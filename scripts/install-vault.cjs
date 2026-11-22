const fs = require("node:fs");
const path = require("node:path");

function install(vault, config = ".obsidian") {
  if (!vault || !/^\.[A-Za-z0-9_-]+$/u.test(config)) {
    throw new Error("Usage: npm run install:vault -- <vault-path> [configuration-folder]");
  }
  const source = path.resolve(__dirname, "../dist/einzig");
  const files = ["manifest.json", "main.js", "styles.css"];
  const contents = files.map((file) => fs.readFileSync(path.join(source, file)));
  const root = fs.realpathSync(vault);
  const skills = ["einzig-doc-governance", "einzig-design-docs"].map((name) => {
    const folder = path.join("skills", name);
    return { folder, content: fs.readFileSync(path.join(source, folder, "SKILL.md")) };
  });
  const configuration = path.join(root, config);
  if (!fs.lstatSync(configuration).isDirectory()) throw new Error("Select an existing Obsidian vault.");
  const plugins = path.join(configuration, "plugins");
  const destination = path.join(plugins, "einzig");
  for (const folder of [plugins, destination, path.join(root, "skills"), ...skills.map(skill => path.join(root, skill.folder))]) {
    if (!fs.existsSync(folder)) fs.mkdirSync(folder);
    if (!fs.lstatSync(folder).isDirectory()) throw new Error(`Not a local directory: ${folder}`);
  }
  for (const file of files) {
    const target = path.join(destination, file);
    const existing = fs.lstatSync(target, { throwIfNoEntry: false });
    if (existing && (!existing.isFile() || existing.nlink !== 1)) {
      throw new Error(`Refusing to replace non-regular file: ${target}`);
    }
  }
  for (const [index, file] of files.entries()) fs.writeFileSync(path.join(destination, file), contents[index]);
  for (const skill of skills) {
    try {
      fs.writeFileSync(path.join(root, skill.folder, "SKILL.md"), skill.content, { flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      console.log(`Kept the existing vault skill in ${skill.folder}.`);
    }
  }
  return destination;
}

try {
  const destination = install(...process.argv.slice(2));
  console.log(`Installed to ${destination}. Reload Obsidian and enable Einzig in Community plugins.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
