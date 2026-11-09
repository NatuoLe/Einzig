const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "dist", "einzig");
const source = path.join(root, "src");
const modules = fs.readdirSync(source).filter((name) => name.endsWith(".js")).sort();
const factories = modules.map((name) => {
  const code = fs.readFileSync(path.join(source, name), "utf8");
  return `${JSON.stringify(name)}(module, exports, require) {\n${code}\n}`;
});
const bundle = `"use strict";
const nativeRequire = require;
const factories = {\n${factories.join(",\n")}\n};
const cache = Object.create(null);
function load(id) {
  if (cache[id]) return cache[id].exports;
  if (!Object.hasOwn(factories, id)) throw new Error("Missing Einzig module: " + id);
  const entry = { exports: {} };
  cache[id] = entry;
  factories[id](entry, entry.exports, (name) => {
    if (!name.startsWith("./")) return nativeRequire(name);
    const local = name.slice(2);
    return load(local.endsWith(".js") ? local : local + ".js");
  });
  return entry.exports;
}
module.exports = load("main.js");
`;

fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, "main.js"), bundle);
fs.copyFileSync(path.join(root, "manifest.json"), path.join(output, "manifest.json"));
fs.copyFileSync(path.join(root, "workspace.css"), path.join(output, "styles.css"));
const skillPath = path.join("skills", "einzig-doc-governance", "SKILL.md");
fs.mkdirSync(path.dirname(path.join(output, skillPath)), { recursive: true });
fs.copyFileSync(path.join(root, skillPath), path.join(output, skillPath));
console.log("Built dist/einzig");
