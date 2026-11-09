const { Notice, Plugin, TFile, TFolder } = require("obsidian");
const { digest, stableKey, recordTitle } = require("./identity");
const { DEFAULT_ZONES, safePath, inside, versionLocation, validateZones } = require("./paths");
const { setupWorkspace, isLocked } = require("./workspace");
const {
  setupGovernance, parseDocument, validateManagedDocument, renderChangeRecord, renderChangeBase,
} = require("./governance");
const { setupWorkflow } = require("./workflow");

function localDate() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

module.exports = class Einzig extends Plugin {
  async onload() {
    const saved = await this.loadData() || {};
    this.settings = {
      colors: {},
      locks: [],
      ...saved,
      zones: { ...DEFAULT_ZONES, ...saved.zones },
    };
    this.operations = Promise.resolve();
    this.saves = Promise.resolve();
    this.observed = new Map();
    this.ownedWrites = new Map();
    this.observers = new Map();
    this.unloaded = false;
    setupWorkspace(this);
    setupGovernance(this);
    setupWorkflow(this);
    this.addCommand({
      id: "reconcile-review",
      name: "核对中断的审批写入",
      callback: () => this.runCommand(() => this.exclusive(() => this.reconcileReview()), true),
    });
    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      this.startObserver();
      if (this.settings.pendingReview) {
        new Notice("Einzig 有一笔待核对的审批写入。请运行「核对中断的审批写入」。", 9000);
      }
    });
  }

  onunload() {
    this.unloaded = true;
    for (const timer of this.observers.values()) clearTimeout(timer);
  }

  runCommand(operation, reportSuccess = false) {
    return Promise.resolve().then(operation).then((result) => {
      if (reportSuccess && result) new Notice(result);
    }).catch((error) => new Notice(`Einzig：${error.message}`, 8000));
  }

  saveSettings() {
    const snapshot = JSON.parse(JSON.stringify(this.settings));
    const save = this.saves.then(() => this.saveData(snapshot));
    this.saves = save.catch(() => {});
    return save;
  }

  exclusive(operation) {
    const next = this.operations.then(operation);
    this.operations = next.catch(() => {});
    return next;
  }

  async readText(path) {
    safePath(path);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) return null;
    if (!(file instanceof TFile)) throw new Error(`路径已有同名文件夹：${path}`);
    return this.app.vault.read(file);
  }

  assertWritable(path) {
    safePath(path);
    if (isLocked(this.settings, path)) throw new Error(`目录已锁定：${path}`);
  }

  async ensureFolder(path) {
    safePath(path);
    let current = "";
    for (const part of path.split("/")) {
      current = current ? `${current}/${part}` : part;
      const entry = this.app.vault.getAbstractFileByPath(current);
      if (entry instanceof TFolder) continue;
      if (entry) throw new Error(`目录与已有文件重名：${current}`);
      this.assertWritable(current);
      await this.app.vault.createFolder(current);
    }
  }

  async writeCompared(path, text, expected) {
    this.assertWritable(path);
    const vault = this.app.vault;
    const file = vault.getAbstractFileByPath(path);
    if (expected === null && !file) {
      await this.ensureFolder(path.slice(0, path.lastIndexOf("/")));
      this.assertWritable(path);
      this.markOwnedWrite(path, text);
      try {
        return await vault.create(path, text);
      } catch (error) {
        this.ownedWrites.delete(path);
        throw error;
      }
    }
    if (!(file instanceof TFile) || expected === null) throw new Error(`文件在预览后变动：${path}`);
    if (file.path !== path) throw new Error(`路径大小写与库中实际路径不一致：${path}`);
    if (text === expected && await vault.read(file) === expected) return file;
    this.markOwnedWrite(path, text);
    try {
      await vault.process(file, (current) => {
        this.assertWritable(file.path);
        if (file.path !== path || current !== expected) throw new Error(`文件在预览后变动：${path}`);
        return text;
      });
    } catch (error) {
      this.ownedWrites.delete(path);
      throw error;
    }
    return file;
  }

  writeManaged(path, text, { expected, kind } = {}) {
    return this.exclusive(async () => {
      if (!this.settings.workspaceInitialized) throw new Error("请先初始化 Einzig 工作区。");
      safePath(path);
      const zones = validateZones(this.settings.zones);
      const location = versionLocation(path, zones.versions);
      if (kind !== "draft" || location?.section !== "进行中" || !path.endsWith(".md")) {
        throw new Error("普通写入只允许写入版本的进行中草稿。权威文档必须走审批。");
      }
      if (expected !== null && typeof expected !== "string") throw new Error("写入缺少预览基线。");
      await validateManagedDocument(this, { path, text, kind });
      return this.writeCompared(path, text, expected);
    });
  }

  async recordPath(record) {
    const id = record.change_id;
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u.test(id)) {
      throw new Error("修改 Key 无效。");
    }
    const folder = `${this.settings.zones.governance}/修改记录`;
    const title = recordTitle(record).replace(/[<>:"/\\|?*#[\]^]/gu, " ").replace(/\s+/gu, " ").trim();
    const stem = `${record.date || localDate()} · ${Array.from(title || "文档修改").slice(0, 80).join("").replace(/[ .]+$/u, "") || "文档修改"}`;
    const vault = this.app.vault;
    const occupied = new Set();
    for (const file of vault.getMarkdownFiles()) {
      if (!inside(file.path, folder)) continue;
      occupied.add(file.path.toLowerCase());
      try {
        const { frontmatter } = parseDocument(await vault.read(file));
        if (frontmatter.change_id === id) return file.path;
      } catch {
        // A damaged record still reserves its filename.
      }
    }
    for (let ordinal = 1; ; ordinal += 1) {
      const suffix = ordinal === 1 ? "" : ` (${ordinal})`;
      const path = `${folder}/${stem}${suffix}.md`;
      if (!occupied.has(path.toLowerCase()) && !vault.getAbstractFileByPath(path)) return path;
    }
  }

  async ensureChangeBase() {
    const path = `${this.settings.zones.governance}/修改记录.base`;
    if (await this.readText(path) === null) await this.writeCompared(path, renderChangeBase(this), null);
    return path;
  }

  async writeRecord(record, path) {
    path ??= await this.recordPath(record);
    const text = renderChangeRecord(record);
    validateManagedDocument(this, { path, text, kind: "record" });
    const existing = await this.readText(path);
    if (existing === text) return;
    if (existing !== null) throw new Error(`修改 Key 已被使用：${record.change_id}`);
    await this.writeCompared(path, text, null);
  }

  commitReview(review) {
    return this.exclusive(() => this.applyReview(review));
  }

  async applyReview({ targetPath, expected, text, record, sourceSnapshots }) {
    if (!this.settings.workspaceInitialized) throw new Error("请先初始化 Einzig 工作区。");
    if (this.settings.pendingReview) throw new Error("有一笔未完成的审批，请先核对中断写入。");
    const zones = validateZones(this.settings.zones);
    this.assertWritable(targetPath);
    const location = versionLocation(targetPath, zones.versions);
    if (location?.section !== "玩法" || location.version !== record.version || !targetPath.endsWith(".md")) {
      throw new Error("审批目标须位于对应版本的玩法分册。");
    }
    if (expected !== null && typeof expected !== "string") throw new Error("审批缺少目标基线。");
    if (typeof text !== "string" || text === expected) throw new Error("审批没有可写入的变化。");
    await validateManagedDocument(this, { path: targetPath, text, kind: "authority" });
    const { frontmatter } = parseDocument(text);
    if (frontmatter.change_id !== record.change_id || frontmatter.feature_key !== record.feature_key) {
      throw new Error("权威文档与修改记录的 Key 不一致。");
    }
    if (expected !== null) {
      const before = parseDocument(expected).frontmatter;
      if ((before.feature_key && before.feature_key !== frontmatter.feature_key) ||
          (before.doc_id && before.doc_id !== frontmatter.doc_id)) {
        throw new Error("更新权威分册时须保留原功能 Key 和文档 ID。");
      }
    }
    await this.assertUniqueAuthority(targetPath, location.version, frontmatter);
    if (!Array.isArray(sourceSnapshots) || !sourceSnapshots.length) throw new Error("审批缺少来源基线。");
    const recordPath = await this.recordPath(record);
    this.assertWritable(recordPath);
    await this.ensureChangeBase();
    await this.ensureFolder(recordPath.slice(0, recordPath.lastIndexOf("/")));
    if (await this.readText(recordPath) !== null) throw new Error("这笔修改已经登记。请重新打开需求草稿。");
    if (await this.readText(targetPath) !== expected) throw new Error("权威分册已变动，请重新审核。");
    for (const source of sourceSnapshots) {
      const scoped = versionLocation(source.path, zones.versions);
      if (source.path === targetPath || typeof source.expected !== "string" ||
          !(inside(source.path, zones.inbox) || inside(source.path, zones.processed) ||
            inside(source.path, zones.shared) || scoped?.version === location.version) ||
          await this.readText(source.path) !== source.expected) {
        throw new Error(`来源超出审核范围或已变动：${source.path}`);
      }
    }
    const pending = { targetPath, recordPath, before: digest(expected), after: digest(text), record };
    this.settings.pendingReview = pending;
    try {
      await this.saveSettings();
    } catch (error) {
      delete this.settings.pendingReview;
      throw error;
    }
    try {
      await this.writeCompared(targetPath, text, expected);
      await this.writeRecord(record, recordPath);
      await this.clearPending(pending);
    } catch (error) {
      throw new Error(`${error.message}。请运行「核对中断的审批写入」。`);
    }
  }

  async assertUniqueAuthority(target, version, identity) {
    for (const file of this.app.vault.getMarkdownFiles()) {
      const location = versionLocation(file.path, this.settings.zones.versions);
      if (file.path === target || location?.version !== version || location.section !== "玩法") continue;
      let frontmatter;
      try {
        ({ frontmatter } = parseDocument(await this.app.vault.read(file)));
      } catch (error) {
        throw new Error(`无法核对该版本的权威页：${file.path}（${error.message}）`);
      }
      if (typeof frontmatter.feature_key === "string" &&
          frontmatter.feature_key.toUpperCase() === identity.feature_key.toUpperCase()) {
        throw new Error(`同版本已经有相同功能 Key：${file.path}`);
      }
      if (frontmatter.doc_id === identity.doc_id) throw new Error(`文档 ID 已被使用：${file.path}`);
    }
  }

  async clearPending(pending) {
    delete this.settings.pendingReview;
    try {
      await this.saveSettings();
    } catch (error) {
      this.settings.pendingReview = pending;
      throw error;
    }
  }

  async reconcileReview() {
    const pending = this.settings.pendingReview;
    if (!pending) return "没有待核对的审批写入。";
    const current = digest(await this.readText(pending.targetPath));
    if (current === pending.after) {
      await this.writeRecord(pending.record, pending.recordPath);
      await this.clearPending(pending);
      return "已核对目标内容并补齐修改记录。请重新打开草稿。";
    }
    if (current === pending.before && await this.readText(pending.recordPath) === null) {
      await this.clearPending(pending);
      return "本次审批未落盘。可以重新打开草稿审批。";
    }
    throw new Error(`目标已偏离审批前后的两个版本，请人工核对：${pending.targetPath}`);
  }

  startObserver() {
    const vault = this.app.vault;
    for (const event of ["create", "modify"]) {
      this.registerEvent(vault.on(event, (file) => {
        if (file instanceof TFile && file.extension === "md") this.queueObservation(file.path, event);
      }));
    }
  }

  markOwnedWrite(path, text) {
    if (versionLocation(path, this.settings.zones.versions)?.section === "玩法") {
      this.ownedWrites.set(path, digest(text));
    }
  }

  queueObservation(path, event) {
    if (!this.settings.workspaceInitialized) return;
    const zones = this.settings.zones;
    const intake = inside(path, zones.inbox);
    const version = versionLocation(path, zones.versions);
    if (!intake && version?.section !== "玩法") return;
    clearTimeout(this.observers.get(path));
    this.observers.set(path, setTimeout(() => {
      this.observers.delete(path);
      if (!this.unloaded) this.runCommand(() => this.exclusive(() => this.recordObservation(path, event)));
    }, 1200));
  }

  async recordObservation(path, event) {
    const text = await this.readText(path);
    if (text === null) return;
    const hash = digest(text);
    const own = this.ownedWrites.get(path);
    this.ownedWrites.delete(path);
    if (own === hash) {
      this.observed.set(path, hash);
      return;
    }
    if (this.observed.get(path) === hash) return;
    const zones = this.settings.zones;
    const intake = inside(path, zones.inbox);
    const location = versionLocation(path, zones.versions);
    let frontmatter;
    try {
      ({ frontmatter } = parseDocument(text));
    } catch {
      frontmatter = {};
    }
    const date = localDate();
    await this.ensureChangeBase();
    await this.writeRecord({
      change_id: stableKey("O", path, hash, new Date().toISOString()),
      title: `${intake ? "登记输入" : "检测到玩法变更"} · ${path.split("/").at(-1).slice(0, -3)}`,
      date,
      feature_key: typeof frontmatter.feature_key === "string" ? frontmatter.feature_key : "待归属",
      version: location?.version || "待确认",
      sources: [`[[${path.slice(0, -3)}]]`],
      documents: [],
      summary: intake ? "待整理输入有变动" : "检测到玩法分册直接修改",
      status: "observed",
      result: `${event === "create" ? "新增" : "修改"}，作者未核实，SHA-256 ${hash}`,
    });
    this.observed.set(path, hash);
  }
};
