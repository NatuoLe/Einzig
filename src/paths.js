const DEFAULT_ZONES = Object.freeze({
  inbox: "用户输入/待整理",
  processed: "用户输入/已处理",
  versions: "版本",
  shared: "共享工程",
  governance: "Einzig",
});

function safePath(path) {
  if (typeof path !== "string" || !path || path.length > 512) throw new Error("缺少有效的库内路径。");
  for (const part of path.split("/")) {
    if (!part || part.startsWith(".") || /[ .]$/u.test(part) || /[<>:"\\|?*\x00-\x1f]/u.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)) {
      throw new Error(`不支持的库内路径：${path}`);
    }
  }
  return path;
}

function inside(path, folder) {
  if (!folder) return false;
  const name = path.toLowerCase();
  const prefix = folder.toLowerCase();
  return name === prefix || name.startsWith(prefix + "/");
}

function versionLocation(path, root) {
  if (!inside(path, root) || path.length <= root.length) return null;
  const [version, section, ...rest] = path.slice(root.length + 1).split("/");
  return rest.length ? { version, section } : null;
}

function validateZones(zones) {
  const paths = Object.keys(DEFAULT_ZONES).map((key) => safePath(zones[key]));
  if (paths.some((path, i) => paths.slice(i + 1).some((other) => inside(path, other) || inside(other, path)))) {
    throw new Error("治理目录必须彼此独立，不能互相包含。");
  }
  return zones;
}

module.exports = { DEFAULT_ZONES, safePath, inside, versionLocation, validateZones };
