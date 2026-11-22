const { MarkdownView, ItemView, Notice, TFolder, stringifyYaml } = require("obsidian");
const { parseDocument } = require("./governance");
const { digest, stableKey } = require("./identity");
const { inside, safePath, versionLocation } = require("./paths");

function reviewLocation(plugin, path) {
  const location = versionLocation(path, plugin.settings.zones.versions);
  return ["设计文档", "开发文档"].includes(location?.section) ? location : null;
}

function linkPaths(links) {
  if (!Array.isArray(links) || !links.length) return [];
  const paths = links.map(link => typeof link === "string" && /^\[\[([^#|\[\]]+)\]\]$/u.exec(link)?.[1]);
  if (paths.some(path => !path)) throw new Error("来源和审核目标须使用完整 Vault 路径双链。");
  return [...new Set(paths.map(path => path.endsWith(".md") ? path : path + ".md"))];
}

function diffLines(previous, current) {
  const before = previous === null ? [] : previous.split(/\r?\n/u);
  const after = current.split(/\r?\n/u);
  if ((before.length + 1) * (after.length + 1) > 2000000) {
    return [...before.map(line => ["-", line]), ...after.map(line => ["+", line])];
  }
  const matrix = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      matrix[i][j] = before[i] === after[j] ? matrix[i + 1][j + 1] + 1
        : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      rows.push([" ", before[i++]]);
      j++;
    }
    else if (i < before.length && (j === after.length || matrix[i + 1][j] >= matrix[i][j + 1])) rows.push(["-", before[i++]]);
    else rows.push(["+", after[j++]]);
  }
  return rows;
}

function approvalHash(plugin, { frontmatter, body }) {
  const { inbox, processed } = plugin.settings.zones;
  const progressKeys = ["einzig_status", "完成开发", "完成测试", "Agent迭代状态", "Agent迭代轮次"];
  const properties = Object.keys(frontmatter).filter(key => !progressKeys.includes(key)).sort()
    .map(key => [key, key === "sources" ? linkPaths(frontmatter.sources).map(path =>
      inside(path, processed) ? inbox + path.slice(processed.length) : path) : frontmatter[key]]);
  return digest(JSON.stringify([properties, body]));
}

async function matchesApproval(plugin, path, doc, approval) {
  if (!approval || approval.revoked || doc.frontmatter.einzig_status === "needs_review") return false;
  if (approval.hash === approvalHash(plugin, doc)) return true;
  const sources = linkPaths(doc.frontmatter.sources);
  const replacements = new Map();
  for (const source of sources) {
    const resolved = plugin.app.metadataCache.getFirstLinkpathDest(source.slice(0, -3), path)?.path ?? source;
    if (!inside(resolved, plugin.settings.zones.processed)) continue;
    const text = await plugin.readText(resolved);
    if (text === null) continue;
    const archived = parseDocument(text);
    if (!linkPaths(archived.frontmatter.NeedReviewList ?? archived.frontmatter.einzig_targets).includes(path)) continue;
    const original = Object.entries(approval.inputs ?? {}).filter(([, hash]) => hash === digest(archived.body));
    if (original.length === 1) replacements.set(resolved, original[0][0]);
  }
  if (!replacements.size) return false;
  const canonicalize = body => body.replace(/\[\[([^\]|#]+)([^\]]*)\]\]/gu, (link, name, suffix) => {
    const target = name.endsWith(".md") ? name : name + ".md";
    const resolved = plugin.app.metadataCache.getFirstLinkpathDest(target.slice(0, -3), path)?.path ?? target;
    const original = replacements.get(resolved);
    return original ? `[[${original.slice(0, -3)}${suffix}]]` : link;
  });
  if (canonicalize(doc.body) !== canonicalize(approval.body)) return false;
  const previousSources = doc.frontmatter.sources.map(canonicalize);
  return approval.hash === approvalHash(plugin, {
    body: approval.body, frontmatter: { ...doc.frontmatter, sources: previousSources },
  });
}

async function tryArchive(plugin, sourcePath) {
  const zones = plugin.settings.zones;
  const text = await plugin.readText(sourcePath);
  if (text === null) return;
  const { frontmatter, body } = parseDocument(text);
  const targets = linkPaths(frontmatter.NeedReviewList ?? frontmatter.einzig_targets);
  if (frontmatter.einzig_intake_closed !== true || !targets.length) return;
  for (const target of targets) {
    if (!reviewLocation(plugin, target)) return;
    const current = await plugin.readText(target);
    const approval = plugin.settings.inlineApprovals[target];
    if (current === null || !approval || approval.revoked) return;
    const doc = parseDocument(current);
    if (approval.inputs?.[sourcePath] !== digest(body) ||
        !await matchesApproval(plugin, target, doc, approval)) return;
  }
  const destination = frontmatter.einzig_archive_path ??
    zones.processed + sourcePath.slice(zones.inbox.length);
  safePath(destination);
  if (!inside(destination, zones.processed) || destination === zones.processed || !destination.endsWith(".md")) {
    throw new Error("归档位置须是已处理目录内的 Markdown 文件路径。");
  }
  plugin.assertWritable(sourcePath);
  plugin.assertWritable(destination);
  await plugin.ensureFolder(destination.slice(0, destination.lastIndexOf("/")));
  const vault = plugin.app.vault;
  if (await vault.adapter.exists(destination)) throw new Error(`已处理目录存在同名文件：${destination}`);
  if (await plugin.readText(sourcePath) !== text) throw new Error("原始输入已变动，请重新检查归档条件。");
  await plugin.app.fileManager.renameFile(vault.getAbstractFileByPath(sourcePath), destination);
  await plugin.ensureFolder(zones.inbox);
}

async function approveInline(plugin, path, expected) {
  return plugin.exclusive(async () => {
    const location = reviewLocation(plugin, path);
    if (!location || await plugin.readText(path) !== expected) throw new Error("文档已变动，请重新预览。");
    plugin.assertWritable(path);
    const doc = parseDocument(expected);
    const { frontmatter, body } = doc;
    if (frontmatter.version !== location.version || typeof frontmatter.feature_key !== "string" || !frontmatter.feature_key.trim()) {
      throw new Error("请补齐功能 Key 和与目录一致的版本。");
    }
    const sources = linkPaths(frontmatter.sources);
    if (!sources.length) throw new Error("请补齐来源双链。");
    const inputs = {};
    for (const link of sources) {
      const source = plugin.app.metadataCache.getFirstLinkpathDest(link.slice(0, -3), path)?.path ?? link;
      const text = await plugin.readText(source);
      if (text === null) throw new Error(`来源不存在：${source}`);
      if (inside(source, plugin.settings.zones.inbox)) inputs[source] = digest(parseDocument(text).body);
    }
    if (await plugin.readText(path) !== expected) throw new Error("文档已变动，请重新预览。");
    const hash = approvalHash(plugin, doc);
    const previous = plugin.settings.inlineApprovals[path];
    const date = new Intl.DateTimeFormat("sv-SE").format(new Date());
    const title = path.split("/").at(-1).slice(0, -3);
    await plugin.ensureChangeBase();
    if (await plugin.readText(path) !== expected) throw new Error("文档已变动，请重新预览。");
    await plugin.writeRecord({
      change_id: stableKey("I", path, previous?.hash ?? null, hash),
      title: `批准 · ${title}`, date, feature_key: frontmatter.feature_key, version: location.version,
      sources: frontmatter.sources, documents: [path], summary: `批准 ${title}`, status: "approved", result: "applied",
    });
    plugin.settings.inlineApprovals[path] = { hash, body, inputs };
    try {
      await plugin.saveSettings();
    } catch (error) {
      if (previous) plugin.settings.inlineApprovals[path] = previous;
      else delete plugin.settings.inlineApprovals[path];
      throw error;
    }
    const header = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?^---[ \t]*(?:\r?\n|$)/mu.exec(expected);
    const approvedHeader = `---\n${stringifyYaml({ ...frontmatter, einzig_status: "approved" }).trimEnd()}\n---\n`;
    if (header?.index === 0) {
      try {
        await plugin.writeCompared(path, approvedHeader + expected.slice(header[0].length), expected);
      } catch (error) {
        new Notice(`审批快照已保存，当前文件状态待核对。${error.message}`, 8000);
        return;
      }
    }
    for (const source of Object.keys(inputs)) {
      try {
        await tryArchive(plugin, source);
      } catch (error) {
        new Notice(`审批已保存，原文待归档。${error.message}`, 8000);
      }
    }
  });
}

const DIFF_VIEW = "einzig-review-diff";

class InlineDiff extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return DIFF_VIEW; }
  getDisplayText() { return "Einzig 文档差异"; }
  getIcon() { return "diff"; }
  getState() { return { path: this.path }; }

  async setState(state, result) {
    this.path = state.path;
    await super.setState(state, result);
    const path = this.path;
    const text = path ? await this.plugin.readText(path) : null;
    if (this.path !== path) return;
    this.contentEl.empty();
    if (text === null) {
      this.contentEl.createEl("p", { text: "请从文档顶部打开差异。" });
      return;
    }
    const previous = this.plugin.settings.inlineApprovals[path];
    this.contentEl.createEl("p", { text: path });
    this.contentEl.createEl("p", { text: previous ? "上次批准 → 当前正文" : "首次审核 · 当前正文" });
    const controls = this.contentEl.createDiv({ cls: "einzig-diff-navigation" });
    const up = controls.createEl("button", { text: "↑", attr: { "aria-label": "上一处差异", title: "上一处差异" } });
    const down = controls.createEl("button", { text: "↓", attr: { "aria-label": "下一处差异", title: "下一处差异" } });
    const position = controls.createSpan({ attr: { "aria-live": "polite" } });
    const pre = this.contentEl.createEl("pre", { cls: "einzig-review-diff" });
    const changes = [];
    let inChange = false;
    for (const [prefix, line] of diffLines(previous?.body ?? null, parseDocument(text).body)) {
      const row = pre.createDiv({ cls: prefix === "+" ? "einzig-added" : prefix === "-" ? "einzig-removed" : "", text: `${prefix} ${line}` });
      const changed = prefix !== " ";
      if (changed && !inChange) changes.push(row);
      inChange = changed;
    }
    let current = -1;
    const update = () => {
      up.disabled = current <= 0;
      down.disabled = current >= changes.length - 1;
      position.setText(changes.length ? `${current + 1} / ${changes.length}` : "无差异");
    };
    const jump = index => {
      if (index < 0 || index >= changes.length) return;
      changes[current]?.classList.remove("einzig-diff-current");
      current = index;
      changes[current].classList.add("einzig-diff-current");
      changes[current].scrollIntoView({ block: "center", inline: "nearest" });
      update();
    };
    up.onclick = () => jump(current - 1);
    down.onclick = () => jump(current + 1);
    update();
  }
}

function setupInlineReview(plugin) {
  if (!plugin.settings.inlineReview) return;
  plugin.settings.inlineApprovals ??= {};
  const { workspace, vault } = plugin.app;
  plugin.registerView(DIFF_VIEW, leaf => new InlineDiff(leaf, plugin));
  async function openDiff(path, sourceLeaf) {
    const leaf = workspace.getLeavesOfType(DIFF_VIEW)[0] ??
      (sourceLeaf ? workspace.createLeafBySplit(sourceLeaf, "vertical") : workspace.getLeaf("split", "vertical"));
    await leaf.setViewState({ type: DIFF_VIEW, active: true, state: { path } });
    await workspace.revealLeaf(leaf);
  }
  const pending = new Set();
  const development = new Map();
  const bars = new Map();
  const painted = new Set();
  let refreshId = 0;
  let timer;
  let explorerObserver;

  function paint() {
    const pendingFolders = new Set();
    const developmentFolders = new Map();
    for (const [path, color] of development) {
      let parent = path.lastIndexOf("/");
      while (parent > 0) {
        const folder = path.slice(0, parent);
        if (developmentFolders.get(folder) !== "red") developmentFolders.set(folder, color);
        parent = path.lastIndexOf("/", parent - 1);
      }
    }
    for (const path of pending) {
      let parent = path.lastIndexOf("/");
      while (parent > 0) {
        pendingFolders.add(path.slice(0, parent));
        parent = path.lastIndexOf("/", parent - 1);
      }
    }
    workspace.getLeavesOfType("file-explorer").forEach(({ view }) => {
      for (const title of view.containerEl.querySelectorAll(".nav-file-title[data-path]")) {
        const path = title.getAttribute("data-path");
        const show = pending.has(path);
        const color = development.get(path);
        title.classList.toggle("einzig-needs-review", show);
        title.classList.toggle("einzig-dev-red", color === "red" || show);
        title.classList.toggle("einzig-dev-yellow", color === "yellow" && !show);
        if (show || color) painted.add(title);
        else painted.delete(title);
      }
      for (const title of view.containerEl.querySelectorAll(".nav-folder-title[data-path]")) {
        const path = title.getAttribute("data-path");
        const show = pendingFolders.has(path);
        const color = developmentFolders.get(path);
        title.classList.toggle("einzig-folder-needs-review", show);
        title.classList.toggle("einzig-dev-red", color === "red" || show);
        title.classList.toggle("einzig-dev-yellow", color === "yellow" && !show);
        if (show || color) painted.add(title);
        else painted.delete(title);
      }
    });
    for (const title of painted) if (!title.isConnected) painted.delete(title);
  }

  async function refresh() {
    const currentRefresh = ++refreshId;
    const states = new Map();
    const progress = new Map();
    for (const file of vault.getMarkdownFiles()) {
      const location = reviewLocation(plugin, file.path);
      if (!location) continue;
      const previous = plugin.settings.inlineApprovals[file.path];
      try {
        const text = await vault.read(file);
        const doc = parseDocument(text);
        if (plugin.settings.agentDevelopment && location.section === "开发文档") {
          if (doc.frontmatter.完成开发 !== true) progress.set(file.path, "red");
          else if (doc.frontmatter.完成测试 !== true) progress.set(file.path, "yellow");
        }
        if (!previous && !doc.frontmatter.einzig_status && !["NeedReview", "needs_review"].includes(doc.frontmatter.status)) continue;
        states.set(file.path, { text, previous, approved: await matchesApproval(plugin, file.path, doc, previous) });
      } catch {
        states.set(file.path, { approved: false });
      }
    }
    if (plugin.unloaded || currentRefresh !== refreshId) return;
    pending.clear();
    development.clear();
    for (const [path, color] of progress) development.set(path, color);
    for (const [path, state] of states) if (!state.approved) pending.add(path);
    paint();
    const seen = new Set();
    for (const leaf of workspace.getLeavesOfType("markdown")) {
      const { view } = leaf;
      if (!(view instanceof MarkdownView)) continue;
      const path = view.file?.path;
      const state = states.get(path);
      if (!state) continue;
      seen.add(view);
      const bar = bars.get(view) ?? view.containerEl.createDiv({ cls: "einzig-review-bar" });
      bars.set(view, bar);
      view.containerEl.prepend(bar);
      bar.empty();
      bar.createSpan({ cls: state.approved ? "" : "einzig-needs-review", text: state.approved ? "已批准" : "NeedReview · 待审核" });
      if (state.text) {
        bar.createEl("button", { text: "查看差异" }).onclick = () =>
          plugin.runCommand(() => openDiff(path, leaf));
        if (!state.approved) {
          const button = bar.createEl("button", { text: "批准", cls: "mod-cta einzig-review-action" });
          button.onclick = () => plugin.runCommand(async () => {
            button.disabled = true;
            try {
              await approveInline(plugin, path, state.text);
            } finally {
              schedule();
              button.disabled = false;
            }
          });
        }
        if (state.approved) {
          bar.createEl("button", { text: "切回待审核", cls: "einzig-review-action" }).onclick = () => plugin.runCommand(async () => {
            await plugin.exclusive(async () => {
              if (await plugin.readText(path) !== state.text) throw new Error("文档已变动，请重新打开。");
              plugin.assertWritable(path);
              const previous = plugin.settings.inlineApprovals[path];
              plugin.settings.inlineApprovals[path] = { ...previous, revoked: true };
              try {
                await plugin.saveSettings();
              } catch (error) {
                plugin.settings.inlineApprovals[path] = previous;
                throw error;
              }
              const file = vault.getAbstractFileByPath(path);
              await plugin.app.fileManager.processFrontMatter(file, properties => {
                properties.einzig_status = "needs_review";
              });
            });
            schedule();
          });
        }
      }
    }
    for (const [view, bar] of bars) {
      if (!seen.has(view)) {
        bar.remove();
        bars.delete(view);
      }
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => plugin.runCommand(refresh), 150);
  }
  plugin.refreshInlineReview = schedule;

  plugin.registerEvent(workspace.on("file-menu", (menu, folder) => {
    if (!(folder instanceof TFolder) || !folder.path || folder.path === "/") return;
    const folderTargets = () => [...pending].filter(path => inside(path, folder.path) && path !== folder.path);
    menu.addItem(item => item.setTitle(`Einzig · 批准全部待审核文档（${folderTargets().length}）`)
      .setIcon("check-check").onClick(() => plugin.runCommand(async () => {
        await refresh();
        const targets = folderTargets();
        if (!targets.length) {
          new Notice("该文件夹没有待审核文档。");
          return;
        }
        const snapshots = await Promise.all(targets.map(async path => ({ path, text: await plugin.readText(path) })));
        let approved = 0;
        const failures = [];
        for (const { path, text } of snapshots) {
          try {
            if (text === null) throw new Error("文档已移动");
            const previous = plugin.settings.inlineApprovals[path];
            if (await matchesApproval(plugin, path, parseDocument(text), previous)) continue;
            await approveInline(plugin, path, text);
            approved++;
          } catch (error) {
            failures.push(`${path}：${error.message}`);
          }
        }
        schedule();
        new Notice([`Einzig 已批准 ${approved} 篇，失败 ${failures.length} 篇。`, ...failures].join("\n"), 9000);
      })));
  }));

  for (const event of ["create", "modify", "rename", "delete"]) plugin.registerEvent(vault.on(event, schedule));
  for (const event of ["file-open", "layout-change"]) plugin.registerEvent(workspace.on(event, schedule));
  workspace.onLayoutReady(() => {
    if (plugin.unloaded) return;
    explorerObserver = new MutationObserver(paint);
    explorerObserver.observe(workspace.containerEl, { childList: true, subtree: true });
    if (plugin.settings.workspaceInitialized) {
      plugin.runCommand(() => plugin.exclusive(() => plugin.ensureFolder(plugin.settings.zones.inbox)));
    }
    schedule();
  });
  plugin.addCommand({
    id: "review-current-document", name: "审核当前设计或开发文档",
    callback: () => plugin.runCommand(async () => {
      const path = workspace.getActiveFile()?.path;
      if (!path || !reviewLocation(plugin, path)) throw new Error("请打开版本目录下的设计或开发文档。");
      const source = workspace.getLeavesOfType("markdown").find(leaf => leaf.view.file?.path === path);
      await openDiff(path, source);
    }),
  });
  plugin.addCommand({
    id: "retry-inline-archive", name: "重试已批准输入归档",
    callback: () => plugin.runCommand(() => plugin.exclusive(async () => {
      for (const file of vault.getMarkdownFiles()) {
        if (!inside(file.path, plugin.settings.zones.inbox)) continue;
        await tryArchive(plugin, file.path);
      }
    })),
  });
  plugin.register(() => {
    workspace.detachLeavesOfType(DIFF_VIEW);
    clearTimeout(timer);
    explorerObserver?.disconnect();
    for (const bar of bars.values()) bar.remove();
    for (const title of painted) title.classList.remove("einzig-needs-review", "einzig-folder-needs-review",
      "einzig-dev-red", "einzig-dev-yellow");
  });
}

module.exports = { setupInlineReview, diffLines, approveInline, matchesApproval };
