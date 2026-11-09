const { Modal, Notice, parseYaml, stringifyYaml } = require("obsidian");
const { recordTitle } = require("./identity");
const { DEFAULT_ZONES, inside } = require("./paths");

const recordFolder = "修改记录";
const documentTypes = new Set(["authority", "draft", "evidence", "reference"]);
const draftStates = new Set(["draft", "pending_review", "conflict"]);

function within(path, root) {
  return inside(path, root) && path.length > root.length;
}

function classifyPath(plugin, path) {
  const { inbox, processed, versions, shared, governance } = plugin.settings.zones;
  if (within(path, inbox)) return { kind: "inbox" };
  if (within(path, processed)) return { kind: "processed" };
  if (within(path, versions)) {
    const [version, section, ...rest] = path.slice(versions.length + 1).split("/");
    if (rest.length) {
      if (section === "玩法") return { kind: "authority", version };
      if (section === "进行中") return { kind: "draft", version };
      if (section === "归档") return { kind: "archive", version };
      if (section === "工程") return { kind: "reference", version };
    }
    return { kind: "version", version };
  }
  if (within(path, shared)) return { kind: "shared", version: "shared" };
  if (governance && within(path, `${governance}/${recordFolder}`)) return { kind: "record" };
  if (within(path, governance)) return { kind: "governance" };
  return { kind: "outside" };
}

function parseDocument(text) {
  const source = text.replace(/^\uFEFF/, "");
  if (!/^---[ \t]*\r?\n/.test(source)) return { frontmatter: {}, body: source };
  const header = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(source);
  if (!header) throw new Error("YAML 属性缺少结束分隔符。");
  const frontmatter = parseYaml(header[1]) ?? {};
  if (typeof frontmatter !== "object" || Array.isArray(frontmatter) || frontmatter instanceof Date) {
    throw new Error("YAML 属性必须是键值映射。");
  }
  return { frontmatter, body: source.slice(header[0].length).replace(/^\r?\n/, "") };
}

function renderDocument(frontmatter, body) {
  return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${body.trimEnd()}\n`;
}

async function scanDocuments(plugin, { includeText = false, version, kinds } = {}) {
  const { vault } = plugin.app;
  const documents = [];
  for (const file of vault.getMarkdownFiles()) {
    const location = classifyPath(plugin, file.path);
    if (["outside", "governance", "archive"].includes(location.kind)) continue;
    if (kinds && !kinds.includes(location.kind)) continue;
    if (version && location.version && ![version, "shared"].includes(location.version)) continue;
    try {
      const text = await vault.read(file);
      const { frontmatter } = parseDocument(text);
      const document = { path: file.path, frontmatter, ...location };
      if (includeText) document.text = text;
      documents.push(document);
    } catch (error) {
      documents.push({ path: file.path, frontmatter: {}, error: error.message, ...location });
    }
  }
  return documents;
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isDate(value) {
  if (value instanceof Date) return Number.isFinite(value.valueOf()) && value.toISOString().endsWith("T00:00:00.000Z");
  if (!hasText(value) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function dateText(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function isTextList(value) {
  return Array.isArray(value) && value.length > 0 && value.every(hasText);
}

function requireKeys(frontmatter, keys, issues) {
  for (const key of keys) {
    if (!hasText(frontmatter[key]) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(frontmatter[key])) {
      issues.push(`${key} 须为字母、数字、连字符或下划线组成的标识。`);
    }
  }
}

function validateSources(plugin, path, sources, issues) {
  if (!isTextList(sources)) {
    issues.push("sources 至少需要一个原文双链。");
    return;
  }
  for (const source of sources) {
    const target = /^\[\[([^\[\]#|]+)(?:#[^\[\]|]+)?(?:\|[^\[\]]+)?\]\]$/.exec(source);
    if (!target || !hasText(target[1])) {
      issues.push(`来源格式无效：${source}`);
      continue;
    }
    const { metadataCache, vault } = plugin.app;
    const targetPath = target[1].trim();
    const file = metadataCache.getFirstLinkpathDest(targetPath, path)
      || vault.getAbstractFileByPath(targetPath)
      || vault.getAbstractFileByPath(`${targetPath}.md`);
    if (!file || file.extension !== "md") issues.push(`来源文档找不到：${source}`);
    else if (file.path === path) issues.push(`来源不能指向当前文档：${source}`);
  }
}

function validateManagedDocument(plugin, { path, text, kind }) {
  const location = classifyPath(plugin, path);
  const { frontmatter, body } = parseDocument(text);
  const issues = [];
  const type = frontmatter.type;
  if (location.kind === "record" || kind === "record") {
    requireKeys(frontmatter, ["change_id"], issues);
    if (type !== "change_record") issues.push("修改记录的 type 须为 change_record。");
    if (!isDate(frontmatter.date)) issues.push("修改记录需要有效日期。");
    if (!hasText(frontmatter.summary) || !hasText(frontmatter.status)) {
      issues.push("修改记录需要摘要和状态。");
    }
  } else {
    requireKeys(frontmatter, ["feature_key", "doc_id", "change_id"], issues);
    const featureSegments = hasText(frontmatter.feature_path) ? frontmatter.feature_path.split("-") : [];
    if (featureSegments.length < 2 || featureSegments.some(segment => !hasText(segment) || /[\r\n]/.test(segment))) {
      issues.push("feature_path 须采用 项目-功能-子功能 链路。");
    }
    if (!isDate(frontmatter.created) || !isDate(frontmatter.updated)) {
      issues.push("created 和 updated 须为有效的 YYYY-MM-DD 日期。");
    } else if (dateText(frontmatter.updated) < dateText(frontmatter.created)) {
      issues.push("updated 不得早于 created。");
    }
    if (!isTextList(frontmatter.tags) || frontmatter.tags.some(tag => /[\s#]/.test(tag) || /^\p{N}+$/u.test(tag))) {
      issues.push("tags 至少需要一个标签，属性中的标签不含空格或 #。");
    }
    if (!documentTypes.has(type)) issues.push("文档 type 无效。");
    if (!hasText(frontmatter.version) || (location.version && frontmatter.version !== location.version)) {
      issues.push("version 须和所在版本一致。");
    }
    if (!hasText(frontmatter.status)) issues.push("需要 status。");
    if (frontmatter.scope !== undefined && !hasText(frontmatter.scope) && !isTextList(frontmatter.scope)) {
      issues.push("scope 须为适用范围文本或文本列表。");
    }
    if (!body.trim()) issues.push("正文不能为空。");
    validateSources(plugin, path, frontmatter.sources, issues);

    if (kind === "authority" || type === "authority") {
      if (location.kind !== "authority" || type !== "authority" || frontmatter.status !== "approved") {
        issues.push("权威页须位于版本玩法目录，type 为 authority，status 为 approved。");
      }
    } else if (kind === "draft" || type === "draft") {
      if (location.kind !== "draft" || type !== "draft" || !draftStates.has(frontmatter.status)) {
        issues.push("演进草稿须位于版本进行中目录，并标注为待审或冲突状态。");
      }
    }
  }
  if (issues.length) throw new Error(`${path}：${issues.join(" ")}`);
  return frontmatter;
}

function renderChangeRecord(record) {
  const title = recordTitle(record);
  const frontmatter = {
    type: "change_record",
    title,
    change_id: record.change_id,
    date: record.date,
    feature_key: record.feature_key,
    version: record.version,
    sources: record.sources ?? [],
    documents: (record.documents ?? []).map(path => {
      if (/^[^[\]#|]+\.md$/i.test(path)) return `[[${path.slice(0, -3)}]]`;
      return path;
    }),
    summary: record.summary,
    status: record.status,
    result: record.result ?? "",
  };
  const lines = [`# ${title}`, "", record.summary];
  if (record.result) lines.push("", "## 执行结果", "", record.result);
  if (frontmatter.sources.length) lines.push("", "## 来源", "", ...frontmatter.sources.map(source => `- ${source}`));
  if (frontmatter.documents.length) lines.push("", "## 影响文档", "", ...frontmatter.documents.map(path => `- ${path}`));
  return renderDocument(frontmatter, lines.join("\n"));
}

function renderChangeBase(plugin = DEFAULT_ZONES.governance) {
  const governance = typeof plugin === "string" ? plugin : plugin.settings.zones.governance;
  return stringifyYaml({
    filters: { and: [`file.inFolder(${JSON.stringify(`${governance}/${recordFolder}`)})`, 'note.type == "change_record"'] },
    properties: {
      "file.name": { displayName: "修改记录" },
      "note.date": { displayName: "日期" },
      "note.feature_key": { displayName: "功能 Key" },
      "note.version": { displayName: "版本" },
      "note.sources": { displayName: "来源" },
      "note.documents": { displayName: "影响文档" },
      "note.summary": { displayName: "摘要" },
      "note.status": { displayName: "审批状态" },
      "note.result": { displayName: "执行结果" },
    },
    views: [{
      type: "table",
      name: "统一修改记录",
      order: ["note.summary", "note.status", "note.date", "note.version", "note.feature_key",
        "file.name", "note.result", "note.sources", "note.documents"],
      sort: [{ property: "note.date", direction: "DESC" }],
    }],
  });
}

async function collectAudit(plugin) {
  const documents = await scanDocuments(plugin, { includeText: true });
  const issues = [];
  const legacy = [];
  const docIds = new Map();
  const authorityKeys = new Map();
  for (const document of documents) {
    const { path, frontmatter, kind, version, error } = document;
    if (kind === "inbox" || kind === "processed") continue;
    if (error) {
      issues.push(error.includes(path) ? error : `${path}：${error}`);
      continue;
    }
    if (kind !== "record" && !documentTypes.has(frontmatter.type) && !frontmatter.doc_id) {
      legacy.push(path);
      continue;
    }
    try {
      validateManagedDocument(plugin, { path, text: document.text });
    } catch (validationError) {
      issues.push(validationError.message);
    }
    if (frontmatter.doc_id) {
      const id = String(frontmatter.doc_id).toUpperCase();
      const existing = docIds.get(id);
      if (existing) issues.push(`文档 ID 重复：${existing} / ${path}`);
      else docIds.set(id, path);
    }
    if (frontmatter.type === "authority" && frontmatter.feature_key && version) {
      const key = `${version}/${frontmatter.feature_key}`.toUpperCase();
      const existing = authorityKeys.get(key);
      if (existing) issues.push(`版本内存在多个权威页：${existing} / ${path}`);
      else authorityKeys.set(key, path);
    }
  }
  return { issues, legacy };
}

class AuditModal extends Modal {
  constructor(app, report) {
    super(app);
    this.report = report;
  }

  onOpen() {
    const { issues, legacy } = this.report;
    this.contentEl.createEl("h2", { text: "Einzig 文档巡检" });
    this.contentEl.createEl("p", { text: `${issues.length} 个待处理问题，${legacy.length} 篇未纳管旧笔记。` });
    for (const [title, items] of [["待处理", issues], ["未纳管", legacy]]) {
      if (!items.length) continue;
      const details = this.contentEl.createEl("details");
      details.open = title === "待处理";
      details.createEl("summary", { text: `${title}（${items.length}）` });
      const list = details.createEl("ul");
      for (const item of items) list.createEl("li", { text: item });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

function setupGovernance(plugin) {
  plugin.addCommand({
    id: "audit-documents",
    name: "巡检文档格式和权威冲突",
    callback: async () => {
      try {
        new AuditModal(plugin.app, await collectAudit(plugin)).open();
      } catch (error) {
        new Notice(`Einzig 巡检失败：${error.message}`);
      }
    },
  });
  plugin.addCommand({
    id: "open-change-base",
    name: "打开统一修改记录表",
    callback: async () => {
      const path = `${plugin.settings.zones.governance}/${recordFolder}.base`;
      const file = plugin.app.vault.getAbstractFileByPath(path);
      if (!file) {
        new Notice("修改记录表尚未建立，请先初始化 Einzig。");
        return;
      }
      try {
        await plugin.app.workspace.getLeaf(false).openFile(file);
      } catch (error) {
        new Notice(`无法打开修改记录表，请确认已启用 Bases：${error.message}`);
      }
    },
  });
}

module.exports = {
  classifyPath,
  parseDocument,
  renderDocument,
  scanDocuments,
  validateManagedDocument,
  renderChangeRecord,
  renderChangeBase,
  setupGovernance,
};
