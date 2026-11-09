const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const paths = require("../src/paths");

class TFolder {}
class TFile {
  constructor(path, text) {
    this.path = path;
    this.text = text;
    this.extension = path.split(".").at(-1);
  }
}

const reviewPath = "版本/V2/玩法/战线.md";
const sourcePath = "用户输入/待整理/来源.md";
const frontmatter = { feature_key: "MS-F0042", doc_id: "MS-D0108", change_id: "MS-C-0001" };
const proposed = JSON.stringify(frontmatter);

function loadSource(name, dependencies) {
  const module = { exports: {} };
  const source = path.resolve(__dirname, "../src", name);
  const code = fs.readFileSync(source, "utf8");
  const requireSource = createRequire(source);
  vm.runInThisContext(`(function(module, require) { ${code}\n })`)(module, (id) => dependencies[id] || requireSource(id));
  return module.exports;
}

function testPlugin(integration = false) {
  const dependencies = {
    obsidian: { Plugin: class {}, Notice: class {}, Modal: class {}, TFile, TFolder,
      parseYaml: JSON.parse, stringifyYaml: JSON.stringify },
    "./paths": paths,
    "./workspace": { isLocked: (settings, path) => settings.locks.some((folder) => paths.inside(path, folder)) },
    "./governance": {
      parseDocument: (text) => ({ frontmatter: JSON.parse(text) }),
      validateManagedDocument: () => {},
      renderChangeRecord: JSON.stringify,
      renderChangeBase: () => "views: []",
    },
    "./workflow": {},
  };
  if (integration) {
    dependencies["./governance"] = loadSource("governance.js", dependencies);
    dependencies["./workflow"] = loadSource("workflow.js", dependencies);
  }
  const Plugin = loadSource("main.js", dependencies);
  const plugin = new Plugin();
  plugin.settings = { zones: { ...paths.DEFAULT_ZONES }, locks: [], workspaceInitialized: true };
  plugin.operations = Promise.resolve();
  plugin.saves = Promise.resolve();
  plugin.ownedWrites = new Map();
  plugin.saveData = async () => {};
  const files = new Map([[sourcePath, new TFile(sourcePath, "来源原文")]]);
  plugin.app = {
    metadataCache: { getFirstLinkpathDest: () => null },
    vault: {
      getAbstractFileByPath: (path) => files.get(path),
      getMarkdownFiles: () => Array.from(files.values()).filter((file) => file instanceof TFile),
      createFolder: async (path) => files.set(path, new TFolder()),
      create: async (path, text) => {
        if (files.has(path)) throw new Error("Exists");
        const file = new TFile(path, text);
        files.set(path, file);
        return file;
      },
      read: async (file) => file.text,
      process: async (file, update) => { file.text = update(file.text); },
    },
  };
  return { plugin, files, workflow: dependencies["./workflow"] };
}

function review(overrides) {
  return {
    targetPath: reviewPath,
    expected: null,
    text: proposed,
    record: { change_id: frontmatter.change_id, feature_key: frontmatter.feature_key, version: "V2" },
    sourceSnapshots: [{ path: sourcePath, expected: "来源原文" }],
    ...overrides,
  };
}

test("safe paths reject traversal, settings folders and Windows device names", () => {
  for (const path of ["../test", ".obsidian/main.js", "版本/CON.md", "x\\..\\y", "/test", "x./y"]) {
    assert.throws(() => paths.safePath(path));
  }
});

test("normal writes cannot publish authority notes", async () => {
  const { plugin, files } = testPlugin();
  await assert.rejects(plugin.writeManaged(reviewPath, proposed, { expected: null, kind: "draft" }), /审批/u);
  assert.equal(files.has(reviewPath), false);
});

test("review rejects locked paths and stale sources without changing authority", async () => {
  const { plugin, files } = testPlugin();
  plugin.settings.locks = ["版本/V2"];
  await assert.rejects(plugin.commitReview(review()), /锁定/u);
  plugin.settings.locks = [];
  files.get(sourcePath).text = "已修改";
  await assert.rejects(plugin.commitReview(review()), /来源.*变动/u);
  assert.equal(files.has(reviewPath), false);
});

test("review commits authority and record while leaving input untouched", async () => {
  const { plugin, files } = testPlugin();
  await plugin.commitReview(review());
  assert.equal(files.get(reviewPath).text, proposed);
  assert.equal(files.get(sourcePath).text, "来源原文");
  assert.equal(files.has(await plugin.recordPath(review().record)), true);
  assert.equal(plugin.settings.pendingReview, undefined);
});

test("review rejects a duplicate authority and a target edited after preview", async () => {
  const { plugin, files } = testPlugin();
  const otherPath = "版本/V2/玩法/旧战线.md";
  files.set(otherPath, new TFile(otherPath, JSON.stringify({
    doc_id: "MS-D0220", feature_key: frontmatter.feature_key.toLowerCase(),
  })));
  await assert.rejects(plugin.commitReview(review()), /相同功能 Key/u);
  files.delete(otherPath);
  files.set(reviewPath, new TFile(reviewPath, proposed));
  await assert.rejects(plugin.commitReview(review()), /权威分册已变动/u);
  assert.equal(files.get(reviewPath).text, proposed);
  assert.equal(files.has(await plugin.recordPath(review().record)), false);
});

test("interrupted record write can be reconciled without replaying the authority write", async () => {
  const { plugin, files } = testPlugin();
  const original = plugin.writeRecord.bind(plugin);
  plugin.writeRecord = async () => { throw new Error("record temporarily unavailable"); };
  await assert.rejects(plugin.commitReview(review()), /中断/u);
  assert.equal(files.get(reviewPath).text, proposed);
  assert.ok(plugin.settings.pendingReview);
  plugin.writeRecord = original;
  await plugin.reconcileReview();
  assert.equal(plugin.settings.pendingReview, undefined);
  assert.equal(files.has(await plugin.recordPath(review().record)), true);
});

test("warfront proposal deduplicates and publishes only the approved clause", async () => {
  const { plugin, files, workflow } = testPlugin(true);
  const firstPath = "用户输入/待整理/2026年11月3日 战线推进.md";
  const secondPath = "用户输入/待整理/2026年11月5日 军团战线逻辑重构.md";
  const pilot = process.env.EINZIG_PILOT_VAULT;
  const first = pilot ? fs.readFileSync(path.join(pilot, firstPath), "utf8") : "## 逻辑\n\n增加战线推进区域和蓝光显示。\n";
  const second = pilot ? fs.readFileSync(path.join(pilot, secondPath), "utf8") : "## 重构\n\n预设小队模式屏蔽战线指挥层。\n";
  files.set(firstPath, new TFile(firstPath, first));
  files.set(secondPath, new TFile(secondPath, second));
  const key = "MS-F0042";
  const target = `版本/V2/玩法/${key}.md`;
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  const input = JSON.stringify({
    schema: "einzig-proposal/1", feature_key: key, feature_path: "MINISQUAD-战场-战线",
    version: "V2", scope: "预设小队模式", tags: ["战线"],
    target: { path: target, sha256: null },
    sources: [{ path: firstPath, sha256: hash(first) }, { path: secondPath, sha256: hash(second) }],
    clauses: [
      { id: "command-layer", status: "add", summary: "预设小队的指挥层", after: "预设小队模式屏蔽战线指挥层。",
        evidence: [{ path: secondPath, quote: pilot ? "这个功能被替代了" : "预设小队模式屏蔽战线指挥层。",
          anchor: pilot ? "屏蔽现有“战线作为小队指挥层”的设计" : "重构" }] },
      { id: "visual", status: "conflict", summary: "蓝光显示的适用范围待确认",
        evidence: [{ path: firstPath, quote: pilot ? "从出生点发出蓝光" : "增加战线推进区域和蓝光显示。",
          anchor: "逻辑" }] },
    ],
  });
  const imported = await workflow.importProposal(plugin, input);
  assert.equal(imported.unchanged, false);
  assert.equal((await workflow.importProposal(plugin, input)).unchanged, true);
  const review = await workflow.prepareReview(plugin, imported.path);
  const commit = workflow.makeCommit(review, new Set(["command-layer", "visual"]));
  const repeated = workflow.makeCommit(review, new Set(["command-layer"]));
  assert.equal(commit.record.change_id, repeated.record.change_id);
  assert.equal(commit.text, repeated.text);
  assert.equal(commit.clauses.length, 1);
  await plugin.commitReview(commit);
  const recordPath = await plugin.recordPath(commit.record);
  assert.match(recordPath, /预设小队的指挥层\.md$/u);
  assert.match(files.get(recordPath).text, /^# 预设小队的指挥层$/mu);
  assert.doesNotMatch(recordPath, new RegExp(commit.record.change_id, "u"));
  await plugin.writeManaged(imported.path, workflow.finalizeDraft(review, commit), {
    kind: "draft", expected: review.text,
  });
  assert.match(files.get(target).text, /预设小队模式屏蔽战线指挥层/u);
  assert.doesNotMatch(files.get(target).text, /蓝光/u);
  assert.match(files.get(imported.path).text, /冲突待确认/u);
  assert.equal(files.get(firstPath).text, first);
  assert.equal(files.get(secondPath).text, second);
  assert.deepEqual((await workflow.prepareReview(plugin, imported.path)).state.approved, ["command-layer"]);
});
