// 用途：Windows 下稳健清理本任务创建的 worktree —— 先删 install 产物、逐个 try、句柄占用重试、注销后 prune
// 用法：node scripts/cleanup-worktrees.mjs <worktree路径> [<worktree路径> ...]
// 只处理显式传入、且 git 能确认为已登记 worktree 且无未提交改动的路径；其余保留并报告原因。
import { existsSync, rmSync } from "node:fs";
import { resolve, basename } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const git = (args, opts = {}) => execFileSync("git", args, { cwd: root, encoding: "utf8", ...opts });

function registered() {
  const out = git(["worktree", "list", "--porcelain"]);
  const list = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) { cur = { path: line.slice(9).trim(), branch: "", bare: false }; list.push(cur); }
    else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).trim();
    else if (cur && line === "bare") cur.bare = true;
  }
  return list;
}

function isClean(dir) {
  try { return git(["-C", dir, "status", "--porcelain"]).trim() === ""; }
  catch { return false; }
}

// Windows 下 electron/node_modules 长路径与句柄占用：先删产物目录，再整目录重试
function removeDirWithRetry(dir) {
  for (let i = 0; i < 8; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      return true;
    } catch {
      // 下一轮重试（子进程退出延迟会释放句柄）
    }
  }
  return false;
}

const targets = process.argv.slice(2).map((p) => resolve(p));
if (!targets.length) {
  console.error("用法：node scripts/cleanup-worktrees.mjs <worktree路径> [...]");
  process.exit(2);
}

const reg = registered();
let failed = 0;
for (const dir of targets) {
  const entry = reg.find((w) => resolve(w.path) === dir);
  if (!entry) { console.log(`[skip] 非已登记 worktree，保留：${dir}`); continue; }
  if (entry.bare) { console.log(`[skip] bare worktree，保留：${dir}`); continue; }
  if (!isClean(dir)) { console.log(`[skip] 有未提交/未跟踪改动，保留：${dir}`); continue; }

  // 先注销 git 登记（Windows 下目录删不掉也不影响 git 侧状态）
  try { git(["worktree", "remove", "--force", dir]); }
  catch (e) { console.log(`[warn] git worktree remove 失败，继续尝试磁盘清理：${dir} (${String(e.message).slice(0, 120)})`); }

  if (existsSync(dir)) {
    // 先删最占句柄的 install 产物与构建产物，降低整目录删除的占用概率
    for (const sub of ["node_modules", "dist", "out", "test-results", "playwright-report"]) {
      const p = resolve(dir, sub);
      if (existsSync(p)) removeDirWithRetry(p);
    }
    if (!removeDirWithRetry(dir)) {
      console.log(`[retain] 目录仍被占用（Windows 句柄/长路径），git 侧已注销，保留目录待重启后手删：${dir}`);
      failed += 1;
    } else {
      console.log(`[done] 已清理 ${basename(dir)} (${entry.branch})`);
    }
  } else {
    console.log(`[done] 已清理 ${basename(dir)} (${entry.branch})`);
  }
}
try { git(["worktree", "prune"]); } catch { /* prune 失败不影响已清理结果 */ }
if (failed) console.log(`[cleanup-worktrees] ${failed} 个目录待重启后手删（git 侧已注销，不影响后续任务）`);
