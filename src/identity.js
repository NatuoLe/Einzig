const { createHash } = require("node:crypto");

function digest(value) {
  return value === null ? null : createHash("sha256").update(value).digest("hex");
}

function stableKey(kind, ...inputs) {
  return `EZ-${kind}-${digest(JSON.stringify(["einzig/1", kind, ...inputs])).slice(0, 32)}`;
}

function documentKey(kind, version, featureKey) {
  return stableKey("D", kind, version, featureKey.toUpperCase());
}

function recordTitle(record) {
  const title = (record.title || record.summary || "文档修改")
    .replace(/\s+/gu, " ").trim();
  return title || "文档修改";
}

module.exports = { digest, stableKey, documentKey, recordTitle };
