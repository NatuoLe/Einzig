const { MarkdownView, Modal, Notice, PluginSettingTab, Setting, TFolder } = require("obsidian");
const { inside, validateZones } = require("./paths");

const ZONE_LABELS = {
  inbox: "用户待整理",
  processed: "用户已处理",
  versions: "版本库",
  shared: "共享库",
  governance: "Einzig 记录区",
};

function lockOrigin(settings, path) {
  const normalized = path.replace(/\\/g, "/");
  return settings.locks.find((root) => inside(normalized, root));
}

function isLocked(settings, path) {
  return !settings.locksPaused && typeof path === "string" && Boolean(lockOrigin(settings, path));
}

function effectiveColor(settings, path) {
  let nearest = "";
  for (const root of Object.keys(settings.colors)) {
    if (root.length > nearest.length && inside(path, root)) nearest = root;
  }
  const color = settings.colors[nearest];
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "";
}

function resolveZones(vault, draft) {
  const zones = validateZones(Object.fromEntries(Object.keys(ZONE_LABELS).map((key) => [
    key, (draft[key] || "").trim().replace(/\\/g, "/"),
  ])));
  for (const path of Object.values(zones)) {
    let prefix = "";
    for (const part of path.split("/")) {
      prefix = prefix ? prefix + "/" + part : part;
      const existing = vault.getAbstractFileByPath(prefix);
      if (existing && !(existing instanceof TFolder)) throw new Error(prefix + " 已经是文件。");
      if (existing && existing.path !== prefix) throw new Error("路径大小写与现有目录不一致：" + existing.path);
    }
  }
  return zones;
}

function showError(error) {
  new Notice("Einzig · " + (error instanceof Error ? error.message : String(error)));
}

class WorkspaceSetupModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen() {
    this.titleEl.setText("初始化 Einzig 工作区");
    const draft = { ...this.plugin.settings.zones };
    const { vault } = this.app;
    let applying = false;
    const getZones = () => {
      const zones = resolveZones(vault, draft);
      const previous = this.plugin.settings.zones;
      if (this.plugin.settings.pendingReview && Object.keys(zones).some((key) => zones[key] !== previous[key])) {
        throw new Error("请先核对中断的审批写入，再变更工作区映射。");
      }
      if (isLocked(this.plugin.settings, zones.governance)) throw new Error("请先解锁 Einzig 记录区。");
      for (const path of Object.values(zones)) {
        if (!vault.getAbstractFileByPath(path) && isLocked(this.plugin.settings, path)) {
          throw new Error("无法在锁定目录下创建 " + path + "。");
        }
      }
      return zones;
    };
    this.contentEl.createEl("p", { text: "填写 Vault 内目录。应用后创建缺少的目录并保存映射，既有笔记保留在原目录。" });
    for (const [key, label] of Object.entries(ZONE_LABELS)) {
      new Setting(this.contentEl).setName(label).addText((text) => {
        text.setValue(draft[key] || "").onChange((value) => {
          draft[key] = value;
          renderPreview();
        });
      });
    }
    const preview = this.contentEl.createDiv({ cls: "einzig-workspace-preview" });
    const footer = new Setting(this.contentEl);
    let apply;
    footer.addButton((button) => {
      apply = button;
      button.setButtonText("应用工作区").setCta().onClick(async () => {
        if (applying) return;
        applying = true;
        renderPreview();
        try {
          await this.plugin.exclusive(async () => {
            const zones = getZones();
            for (const path of Object.values(zones)) {
              if (!vault.getAbstractFileByPath(path)) await this.plugin.ensureFolder(path);
            }
            const previous = this.plugin.settings.zones;
            const initialized = this.plugin.settings.workspaceInitialized;
            this.plugin.settings.zones = zones;
            this.plugin.settings.workspaceInitialized = true;
            try {
              await this.plugin.saveSettings();
            } catch (error) {
              this.plugin.settings.zones = previous;
              this.plugin.settings.workspaceInitialized = initialized;
              throw error;
            }
            await this.plugin.ensureChangeBase();
          });
          new Notice("Einzig 工作区已就绪");
          this.close();
        } catch (error) {
          showError(error);
        } finally {
          applying = false;
          if (preview.isConnected) renderPreview();
        }
      });
    });
    const renderPreview = () => {
      preview.empty();
      try {
        const zones = getZones();
        const list = preview.createEl("ul");
        for (const [key, path] of Object.entries(zones)) {
          const action = vault.getAbstractFileByPath(path) ? "使用现有目录" : "创建";
          list.createEl("li", { text: ZONE_LABELS[key] + " · " + action + " · " + path });
        }
        apply.setDisabled(applying);
      } catch (error) {
        preview.createEl("p", { text: error.message });
        apply.setDisabled(true);
      }
    };
    renderPreview();
  }

  onClose() {
    this.contentEl.empty();
  }
}

class FolderColorModal extends Modal {
  constructor(plugin, folder, update) {
    super(plugin.app);
    this.plugin = plugin;
    this.folder = folder;
    this.update = update;
  }

  onOpen() {
    this.titleEl.setText("设置文件夹颜色");
    const initial = effectiveColor(this.plugin.settings, this.folder.path) || "#547eaa";
    const picker = this.contentEl.createEl("input", { type: "color", value: initial });
    picker.setAttribute("aria-label", "文件夹颜色");
    new Setting(this.contentEl).setName(this.folder.path).addButton((button) => {
      button.setButtonText("保存颜色").setCta().onClick(async () => {
        try {
          const path = this.folder.path;
          this.plugin.settings.colors = { ...this.plugin.settings.colors, [path]: picker.value };
          await this.update();
          this.close();
        } catch (error) {
          showError(error);
        }
      });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class WorkspaceSettingsTab extends PluginSettingTab {
  constructor(plugin, openSetup, update) {
    super(plugin.app, plugin);
    this.workspacePlugin = plugin;
    this.openSetup = openSetup;
    this.update = update;
  }

  display() {
    this.containerEl.empty();
    new Setting(this.containerEl).setName("工作区目录").addButton((button) => {
      button.setButtonText("配置工作区").onClick(this.openSetup);
    });
    for (const [key, label] of Object.entries(ZONE_LABELS)) {
      new Setting(this.containerEl).setName(label).setDesc(this.workspacePlugin.settings.zones[key] || "未配置");
    }
    new Setting(this.containerEl).setName("锁定目录").setHeading();
    this.containerEl.createEl("p", { text: "锁定包括子目录，用于防止在 Obsidian 误改笔记，并阻止 Einzig 写入。可从文件夹右键菜单管理。" });
    new Setting(this.containerEl).setName("暂停目录锁")
      .setDesc("暂时恢复编辑和 Einzig 写入，保留已锁定目录。")
      .addToggle((toggle) => toggle.setValue(Boolean(this.workspacePlugin.settings.locksPaused))
        .onChange(async (paused) => {
          this.workspacePlugin.settings.locksPaused = paused;
          try {
            await this.update();
          } catch (error) {
            showError(error);
          }
        }));
    for (const path of this.workspacePlugin.settings.locks) {
      new Setting(this.containerEl).setName(path).addButton((button) => {
        button.setButtonText("解锁").onClick(async () => {
          try {
            const { settings } = this.workspacePlugin;
            settings.locks = settings.locks.filter((root) => root !== path);
            await this.update();
            this.display();
          } catch (error) {
            showError(error);
          }
        });
      });
    }
  }
}

function setupWorkspace(plugin) {
  const { workspace, vault } = plugin.app;
  const explorers = new Map();
  const protectedViews = new Map();
  const switching = new WeakSet();
  const failedViewPaths = new WeakMap();
  let disposed = false;
  let timer = null;
  let setupModal;

  function openSetup() {
    if (setupModal?.modalEl.isConnected) return;
    setupModal = new WorkspaceSetupModal(plugin);
    setupModal.open();
  }

  function repaintExplorer(container, clear = false) {
    for (const title of container.querySelectorAll(".nav-folder-title[data-path]")) {
      const path = title.getAttribute("data-path");
      const color = clear ? "" : effectiveColor(plugin.settings, path);
      title.classList.toggle("einzig-colored-folder", Boolean(color));
      if (color) title.style.setProperty("--einzig-folder-color", color);
      else title.style.removeProperty("--einzig-folder-color");
      title.classList.toggle("einzig-locked-folder", !clear && isLocked(plugin.settings, path));
    }
  }

  function protectReadingView(view) {
    const container = view.containerEl;
    const observer = new container.ownerDocument.defaultView.MutationObserver(scheduleRefresh);
    observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-mode"] });
    function guard(event) {
      if (!isLocked(plugin.settings, view.file?.path)) return;
      const target = event.target;
      if (target.closest?.(".cm-content")) {
        if (event.type === "keydown") {
          const shortcut = event.ctrlKey || event.metaKey;
          const editKey = ["Enter", "Delete", "Backspace", "Process"].includes(event.key);
          const printable = !shortcut && !event.altKey && event.key.length === 1;
          const undoRedo = shortcut && ["z", "y"].includes(event.key.toLowerCase());
          if (!editKey && !printable && !undoRedo) return;
        } else if (!["beforeinput", "paste", "cut", "drop"].includes(event.type)) {
          return;
        }
      } else {
        if (!target.closest?.(".task-list-item-checkbox, .metadata-property")) return;
        if (target.closest("a.internal-link, a.external-link")) return;
        if (event.type === "keydown" && !["Enter", " ", "Delete", "Backspace"].includes(event.key)) return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    const events = ["click", "pointerdown", "beforeinput", "keydown", "paste", "cut", "drop"];
    for (const event of events) container.addEventListener(event, guard, true);
    protectedViews.set(view, () => {
      observer.disconnect();
      for (const event of events) container.removeEventListener(event, guard, true);
    });
  }

  function refresh() {
    const explorerContainers = new Set(workspace.getLeavesOfType("file-explorer").map((leaf) => leaf.view.containerEl));
    for (const [container, observer] of explorers) {
      if (explorerContainers.has(container)) continue;
      observer.disconnect();
      repaintExplorer(container, true);
      explorers.delete(container);
    }
    for (const container of explorerContainers) {
      repaintExplorer(container);
      if (explorers.has(container)) continue;
      const observer = new container.ownerDocument.defaultView.MutationObserver(scheduleRefresh);
      observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-path"] });
      explorers.set(container, observer);
    }

    const lockedViews = new Set();
    for (const leaf of workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !isLocked(plugin.settings, view.file?.path)) continue;
      lockedViews.add(view);
      if (!protectedViews.has(view)) protectReadingView(view);
      if (view.getMode() !== "source" || switching.has(leaf)) continue;
      const path = view.file.path;
      if (failedViewPaths.get(leaf) === path) continue;
      const state = leaf.getViewState();
      switching.add(leaf);
      void leaf.setViewState({ ...state, state: { ...state.state, file: path, mode: "preview" } })
        .catch((error) => {
          failedViewPaths.set(leaf, path);
          showError(error);
        })
        .finally(() => switching.delete(leaf));
    }
    for (const [view, cleanup] of protectedViews) {
      if (lockedViews.has(view)) continue;
      failedViewPaths.delete(view.leaf);
      cleanup();
      protectedViews.delete(view);
    }
  }

  function scheduleRefresh() {
    if (disposed || timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      refresh();
    }, 32);
  }

  async function update() {
    refresh();
    await plugin.saveSettings();
  }

  function addMenuItem(menu, name, icon, action) {
    menu.addItem((item) => item.setTitle("Einzig · " + name).setIcon(icon).onClick(() => {
      Promise.resolve().then(action).catch(showError);
    }));
  }

  plugin.registerEvent(workspace.on("file-menu", (menu, file) => {
    if (!(file instanceof TFolder) || !file.parent) return;
    const path = file.path;
    addMenuItem(menu, "设置文件夹颜色", "palette", () => new FolderColorModal(plugin, file, update).open());
    if (Object.hasOwn(plugin.settings.colors, path)) {
      addMenuItem(menu, "清除文件夹颜色", "eraser", async () => {
        delete plugin.settings.colors[path];
        await update();
      });
    }
    if (plugin.settings.locks.includes(path)) {
      addMenuItem(menu, "解锁文件夹", "lock-open", async () => {
        plugin.settings.locks = plugin.settings.locks.filter((root) => root !== path);
        await update();
        const ancestor = lockOrigin(plugin.settings, path);
        if (ancestor) new Notice("Einzig · 仍受上层目录锁定：" + ancestor);
      });
    } else {
      const ancestor = lockOrigin(plugin.settings, path);
      if (ancestor) {
        addMenuItem(menu, "查看文件夹锁定来源", "lock", () => new Notice("Einzig · 上层目录已锁定：" + ancestor));
      } else {
        addMenuItem(menu, "锁定文件夹", "lock", async () => {
          if (!lockOrigin(plugin.settings, path)) plugin.settings.locks.push(path);
          await update();
        });
      }
    }
  }));

  plugin.registerEvent(workspace.on("file-open", refresh));
  for (const event of ["active-leaf-change", "layout-change", "window-open", "window-close"]) {
    plugin.registerEvent(workspace.on(event, scheduleRefresh));
  }

  plugin.registerEvent(vault.on("rename", (file, oldPath) => {
    scheduleRefresh();
    if (!(file instanceof TFolder)) return;
    const settings = plugin.settings;
    const remap = (path) => inside(path, oldPath) ? file.path + path.slice(oldPath.length) : path;
    if (![...Object.values(settings.zones), ...Object.keys(settings.colors), ...settings.locks].some((path) => inside(path, oldPath))) return;
    settings.zones = Object.fromEntries(Object.entries(settings.zones).map(([key, path]) => [key, remap(path)]));
    settings.colors = Object.fromEntries(Object.entries(settings.colors).map(([path, color]) => [remap(path), color]));
    settings.locks = [...new Set(settings.locks.map(remap))];
    void update().catch(showError);
  }));

  plugin.addCommand({ id: "initialize-workspace", name: "初始化或配置工作区", callback: openSetup });
  plugin.addSettingTab(new WorkspaceSettingsTab(plugin, openSetup, update));
  workspace.onLayoutReady(() => {
    if (disposed) return;
    scheduleRefresh();
    if (!plugin.settings.workspaceInitialized) openSetup();
  });
  plugin.register(() => {
    disposed = true;
    if (timer !== null) window.clearTimeout(timer);
    setupModal?.close();
    for (const [container, observer] of explorers) {
      observer.disconnect();
      repaintExplorer(container, true);
    }
    explorers.clear();
    for (const cleanup of protectedViews.values()) cleanup();
    protectedViews.clear();
  });
}

module.exports = { setupWorkspace, isLocked };
