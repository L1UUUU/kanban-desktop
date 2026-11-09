// 用途：git-diff-service（issue #43，spec #40 A/E 节）—— Main 进程深模块：单函数 readWorkspaceDiff(cwd) 采集当前项目工作区未提交变更（HEAD 对比 diff + untracked 状态清单合并解析为统一文件/hunk 行状），调用方零 git 知识；git 可执行显式解析（config 手动覆盖 → env → where 探测，不经 PATH 兜底 spawn）；四档错误判别联合
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { DiffFileRow, DiffHunk, DiffLine, WorkspaceDiffOk } from "@kanban/ipc-schema";

/** 一次 git 命令执行结果（带缓冲读取 stdout/stderr；spawnError 表示进程未启动，如 exe 消失） */
export interface GitRunOutcome {
  code: number;
  stdout: string;
  stderr: string;
  spawnError?: Error;
}

/** 服务依赖注入 seam（可测）：exe 解析 + git 命令执行 */
export interface GitDiffDeps {
  /** git 可执行解析：null = 不可解析（→ git-missing） */
  resolveGitExe(): string | null;
  /** 在 cwd 执行一条 git 命令（带缓冲收集输出） */
  runGit(exe: string, args: string[], cwd: string): Promise<GitRunOutcome>;
}

/** 结果形状：统一文件列表 + 全局 truncated（#47 落实上限语义，本票恒 false 占位）∪ 四档错误 */
export type WorkspaceDiff =
  | WorkspaceDiffOk
  | { ok: false; kind: "not-a-repo" | "git-missing" | "git-failed" | "missing-cwd"; message: string };

// 空树对象哈希：无任何 commit 的空仓（git init 后未提交）diff 基准回退至此，暂存区新增仍可见
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// ============ git 输出解析（纯函数，测试面） ============

/**
 * 解析 `git status --porcelain -z -uall` 输出，返回 untracked 文件路径列表。
 * -z 格式条目 NUL 分隔；重命名条目（XY 含 R/C）后跟一个原路径 token，须跳过不误判为独立条目。
 */
export function parseStatusPorcelain(text: string): string[] {
  const untracked: string[] = [];
  const tokens = text.split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.length < 4) continue; // 空尾 token / 残段
    const xy = token.slice(0, 2);
    if (xy === "??") untracked.push(token.slice(3));
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") i += 1; // 跳过 rename 原路径 token
  }
  return untracked;
}

/** unified diff 解析的中间行状（kind 判别 + 原文正文） */
interface ParsedSection {
  path: string;
  changeType: "modified" | "added" | "deleted" | "renamed";
  binary: boolean;
  oldPath: string | null;
  hunks: DiffHunk[] | null;
  additions: number;
  deletions: number;
  /** diff --git 头两侧相等时的路径（binary 节无 ---/+++ 行，靠此兜底） */
  headerPath: string;
}

/**
 * 解析 `git diff <base> -M --unified=3` unified 输出为文件节列表（含 new/deleted file mode、
 * rename from/to、Binary files 行、@@ hunk 与 +/-/空格 行级、"\ No newline" 尾标跳过）。
 */
export function parseUnifiedDiff(text: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  const lines = text.split("\n");
  let cur: ParsedSection | null = null;
  let hunk: DiffHunk | null = null;
  let plusPath: string | null = null;
  let minusPath: string | null = null;

  const finishSection = (): void => {
    if (!cur) return;
    // 路径回退链：rename-to（已存 cur.path）→ +++ b/ → --- a/（删除节 +++ 为 /dev/null）→ diff --git 头两侧相等（binary 节兜底）
    if (cur.changeType !== "renamed") {
      if (plusPath != null && plusPath !== "/dev/null") cur.path = plusPath;
      else if (minusPath != null && minusPath !== "/dev/null") cur.path = minusPath;
      else if (!cur.path) cur.path = cur.headerPath;
    }
    cur.hunks = cur.binary ? null : cur.hunks ?? [];
    sections.push(cur);
    cur = null;
    hunk = null;
    plusPath = null;
    minusPath = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      finishSection();
      // 头行 a/与 b/两侧相等时留作路径兜底（两侧不等且无 rename 行的罕见形态不猜测，路径留空由上层跳过）
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      const aPath = m?.[1] ?? "";
      const bPath = m?.[2] ?? "";
      cur = {
        path: "",
        changeType: "modified",
        binary: false,
        oldPath: null,
        hunks: null,
        additions: 0,
        deletions: 0,
        headerPath: aPath !== "" && aPath === bPath ? bPath : "",
      };
      continue;
    }
    if (!cur) continue; // diff 头之前的输出（不应出现，防御跳过）
    if (line.startsWith("@@")) {
      hunk = { header: line, lines: [] };
      (cur.hunks ??= []).push(hunk);
      continue;
    }
    if (line.startsWith("rename from ")) {
      cur.oldPath = line.slice("rename from ".length);
      cur.changeType = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      cur.path = line.slice("rename to ".length);
      cur.changeType = "renamed";
      continue;
    }
    if (line.startsWith("new file mode")) {
      cur.changeType = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      cur.changeType = "deleted";
      continue;
    }
    if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
      cur.binary = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      minusPath = stripAbPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      plusPath = stripAbPrefix(line.slice(4));
      continue;
    }
    if (hunk) {
      if (line.startsWith("\\")) continue; // "\ No newline at end of file" 尾标，非内容行
      const dl = toDiffLine(line);
      if (dl) {
        hunk.lines.push(dl);
        if (dl.kind === "add") cur.additions += 1;
        if (dl.kind === "del") cur.deletions += 1;
      }
    }
  }
  finishSection();
  return sections;
}

/** "--- a/x" / "+++ b/x" 前缀剥离（/dev/null 原样返回） */
function stripAbPrefix(value: string): string {
  if (value === "/dev/null") return value;
  if (value.startsWith("a/") || value.startsWith("b/")) return value.slice(2);
  return value;
}

/** unified 行首字符 → 判别行（空串/残行返回 null） */
function toDiffLine(line: string): DiffLine | null {
  if (line.startsWith("+")) return { kind: "add", text: line.slice(1) };
  if (line.startsWith("-")) return { kind: "del", text: line.slice(1) };
  if (line.startsWith(" ")) return { kind: "context", text: line.slice(1) };
  return null;
}

// ============ 服务主体（单函数接口） ============

/**
 * 读取工作区未提交变更：目录存在性 → git exe 解析 → 仓库判定（is-inside-work-tree）→
 * HEAD 基准（无 commit 回退空树）→ 状态清单（untracked）+ HEAD 对比 diff 并行采集 → 统一解析。
 * shortcut: 输出无上限缓冲（本票最小形态）；#47 落实总字节/文件数/untracked 行数上限与 truncated 语义时复查此处。
 */
export async function readWorkspaceDiff(cwd: string, deps: GitDiffDeps = defaultGitDiffDeps()): Promise<WorkspaceDiff> {
  if (!cwd || !existsSync(cwd)) {
    return { ok: false, kind: "missing-cwd", message: `项目目录不存在：${cwd || "(空路径)"}` };
  }
  const exe = deps.resolveGitExe();
  if (!exe) {
    return { ok: false, kind: "git-missing", message: "未找到 git 可执行文件（where 探测无结果；可在配置文件 gitExe 字段手动指定路径）" };
  }

  // 仓库判定：非 0 退出 + not a git repository 字样 → not-a-repo；输出 false（.git 内部）同判；其余非 0 → git-failed
  const inside = await deps.runGit(exe, ["rev-parse", "--is-inside-work-tree"], cwd);
  const spawnFail = toSpawnFailure(inside);
  if (spawnFail) return spawnFail;
  if (inside.code !== 0) {
    return inside.stderr.includes("not a git repository")
      ? { ok: false, kind: "not-a-repo", message: "当前项目不是 git 仓库" }
      : { ok: false, kind: "git-failed", message: `git rev-parse 失败：${inside.stderr.trim() || `exit ${inside.code}`}` };
  }
  if (inside.stdout.trim() === "false") {
    return { ok: false, kind: "not-a-repo", message: "当前目录不在 git 工作区内" };
  }

  // diff 基准：HEAD 不存在（空仓未提交）回退空树对象，暂存区新增仍可见
  const head = await deps.runGit(exe, ["rev-parse", "--verify", "-q", "HEAD"], cwd);
  const headSpawnFail = toSpawnFailure(head);
  if (headSpawnFail) return headSpawnFail;
  const base = head.code === 0 ? "HEAD" : EMPTY_TREE;

  // 状态清单（untracked）与 HEAD 对比 diff 并行采集
  const [statusRes, diffRes] = await Promise.all([
    deps.runGit(exe, ["status", "--porcelain", "-z", "-uall"], cwd),
    deps.runGit(exe, ["diff", base, "-M", "--unified=3"], cwd),
  ]);
  for (const r of [statusRes, diffRes]) {
    const fail = toSpawnFailure(r);
    if (fail) return fail;
  }
  if (statusRes.code !== 0) {
    return { ok: false, kind: "git-failed", message: `git status 失败：${statusRes.stderr.trim() || `exit ${statusRes.code}`}` };
  }
  if (diffRes.code !== 0) {
    return { ok: false, kind: "git-failed", message: `git diff 失败：${diffRes.stderr.trim() || `exit ${diffRes.code}`}` };
  }

  const tracked = parseUnifiedDiff(diffRes.stdout);
  const untracked = parseStatusPorcelain(statusRes.stdout);
  const files: DiffFileRow[] = [
    ...tracked.map((s) => ({
      path: s.path,
      changeType: s.changeType,
      binary: s.binary,
      oldPath: s.oldPath,
      hunks: s.hunks,
      additions: s.additions,
      deletions: s.deletions,
    })),
    // untracked 本票仅列出（hunks=null 数据形状先留好，全文展示 #47）
    ...untracked.map((path) => ({ path, changeType: "untracked" as const, binary: false, oldPath: null, hunks: null, additions: 0, deletions: 0 })),
  ];
  return { ok: true, files, truncated: false };
}

/** spawn 层失败 → 错误档（ENOENT = exe 消失归 git-missing；其余 git-failed） */
function toSpawnFailure(r: GitRunOutcome): WorkspaceDiff | null {
  if (!r.spawnError) return null;
  if (r.spawnError.message.includes("ENOENT")) {
    return { ok: false, kind: "git-missing", message: `git 可执行启动失败：${r.spawnError.message}` };
  }
  return { ok: false, kind: "git-failed", message: `git 进程启动失败：${r.spawnError.message}` };
}

// ============ 生产依赖（exe 解析 + spawn 执行） ============

/**
 * git 可执行显式解析：config gitExe 手动覆盖 → env KANBAN_GIT_BIN（测试/特殊环境，对齐 claude/exe.ts 先例）
 * → where/which 探测（仅采纳真实存在路径，Windows 优先 .exe）；解析失败返回 null（归 git-missing）。
 */
export function resolveGitExeDefault(manualOverride: string | null): string | null {
  if (manualOverride && existsSync(manualOverride)) return manualOverride;
  const envBin = process.env.KANBAN_GIT_BIN;
  if (envBin && existsSync(envBin)) return envBin;
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, ["git"], { encoding: "utf8" }).trim();
    const candidates = out.split(/\r?\n/).filter(Boolean).filter((p) => existsSync(p));
    return candidates.find((p) => p.toLowerCase().endsWith(".exe")) ?? candidates[0] ?? null;
  } catch {
    return null; // PATH 上无 git
  }
}

/** 生产执行器：spawn git（windowsHide，显式绝对路径不经 PATH 运行时查找）带缓冲收集输出 */
function runGitSpawn(exe: string, args: string[], cwd: string): Promise<GitRunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => resolve({ code: -1, stdout, stderr, spawnError: err }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** 生产 deps 工厂（index.ts 装配传 config.gitExe；测试注入 fixture deps） */
export function defaultGitDiffDeps(manualGitExe: string | null = null): GitDiffDeps {
  return {
    resolveGitExe: () => resolveGitExeDefault(manualGitExe),
    runGit: runGitSpawn,
  };
}
