// 用途：离线装配 electron 二进制 —— 校验缓存 zip 的 sha256 后解压到 node_modules/electron/dist（等价于 install.js 的动作，绕开其在本机的挂起）
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const pkgDir = path.join(__dirname, "..", "node_modules", "electron");
const cacheZip = path.join(
  process.env.LOCALAPPDATA,
  "electron",
  "Cache",
  "9979a070b96dfabe02a153cb2a175131a5f95dff3098b33ab95156cc1200a9ac",
  "electron-v44.10.2-win32-x64.zip",
);

const sums = JSON.parse(fs.readFileSync(path.join(pkgDir, "checksums.json"), "utf8"));
const expected = sums["electron-v44.10.2-win32-x64.zip"];
if (!expected) throw new Error("checksums.json 缺少 44.10.2 条目");
const actual = crypto.createHash("sha256").update(fs.readFileSync(cacheZip)).digest("hex");
if (actual !== expected) {
  throw new Error(`sha256 不匹配\nexpected=${expected}\nactual=${actual}`);
}
console.log("sha256 校验通过");

const distDir = path.join(pkgDir, "dist");
fs.mkdirSync(distDir, { recursive: true });
// 用 Windows 自带 bsdtar（完整路径避免 GNU tar 把 C: 当远程主机）
execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), [
  "-xf",
  cacheZip,
  "-C",
  distDir,
], { stdio: "inherit" });
fs.writeFileSync(path.join(pkgDir, "path.txt"), "electron.exe", "utf8");
console.log("解压完成：", path.join(distDir, "electron.exe"));
