// 用途：门禁契约确定性校验 —— 供 pre-commit / CI 调用，避免 docs/testing.md 与代码实况漂移靠人工终审发现
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const failures = [];
const ok = (label) => console.log(`[check-gates] OK  ${label}`);
const bad = (label, detail) => failures.push({ label, detail });

// 1) 后缀即契约：所有 *.e2e.test.ts 必须含 KANBAN_E2E 门控常量
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "out") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const e2eFiles = [...walk(join(root, "apps")), ...walk(join(root, "packages"))]
  .filter((f) => f.endsWith(".e2e.test.ts"));
const ungated = e2eFiles.filter((f) => !readFileSync(f, "utf8").includes("KANBAN_E2E"));
if (ungated.length) bad("B 类门控", `以下 .e2e.test.ts 缺 KANBAN_E2E 门控：\n  ${ungated.join("\n  ")}`);
else ok(`B 类门控：${e2eFiles.length} 个 .e2e.test.ts 均含 KANBAN_E2E`);

// 2) workspacePackages 与 workspace 包实查一致（漏包会让 Playwright 启动即崩）
const viteSrc = readFileSync(join(root, "apps/desktop/electron.vite.config.ts"), "utf8");
const declared = [...viteSrc.matchAll(/workspacePackages\s*=\s*\[([^\]]*)\]/g)]
  .flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
const packages = [];
for (const base of ["apps", "packages"]) {
  for (const name of readdirSync(join(root, base))) {
    const pj = join(root, base, name, "package.json");
    if (existsSync(pj)) packages.push(JSON.parse(readFileSync(pj, "utf8")).name);
  }
}
const missing = packages.filter((p) => p !== "@kanban/desktop" && !declared.includes(p));
if (missing.length) bad("workspacePackages", `electron.vite.config.ts 漏登记：${missing.join("、")}`);
else ok(`workspacePackages：${declared.length} 个声明与 ${packages.length} 个 workspace 包一致`);

// 3) 归档 PNG 无未预期改动：只拦「本次提交实际带入」的 PNG（pre-commit 看 staged，CI 看已提交 diff）。
//    工作树里历史遗留的未 staged 再生噪声不假红，交由各任务自行处理。
//    确需更新归档时，生成阶段设 KANBAN_UPDATE_SCREENSHOTS=1，提交阶段显式 KANBAN_ALLOW_ARCHIVE_PNG=1 放行。
let pngDirty = [];
let checked = false;
try {
  const args = process.env.CI
    ? ["diff", "--name-only", "HEAD~1", "HEAD", "--", "docs/acceptance"]
    : ["diff", "--cached", "--name-only", "--", "docs/acceptance"];
  const diff = execFileSync("git", args, { cwd: root, encoding: "utf8" });
  pngDirty = diff.split("\n").map((l) => l.trim()).filter((l) => l && l.includes(".png"));
  checked = true;
} catch {
  ok("归档 PNG（非 git 环境或浅克隆，跳过）");
}
if (checked) {
  if (pngDirty.length && process.env.KANBAN_ALLOW_ARCHIVE_PNG !== "1") {
    bad("归档 PNG", `本次提交带入 ${pngDirty.length} 个 docs/acceptance/ 下的 PNG；截图写入默认走 test-results/，确需更新归档请设 KANBAN_UPDATE_SCREENSHOTS=1 生成、提交时设 KANBAN_ALLOW_ARCHIVE_PNG=1：\n  ${pngDirty.slice(0, 8).join("\n  ")}`);
  } else {
    ok(pngDirty.length ? `归档 PNG：${pngDirty.length} 个已由 KANBAN_ALLOW_ARCHIVE_PNG=1 显式放行` : "归档 PNG 无未预期改动");
  }
}

if (failures.length) {
  console.error(`[check-gates] FAIL ${failures.length} 项：`);
  for (const f of failures) console.error(`  - ${f.label}: ${f.detail}`);
  process.exit(1);
}
console.log("[check-gates] PASS");
