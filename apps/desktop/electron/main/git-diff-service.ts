// 用途：git-diff-service（issue #43/#47，spec #40 A/E 节）—— Main 进程深模块：单函数 readWorkspaceDiff(cwd, deps, limits) 采集当前项目工作区未提交变更（HEAD 对比 diff + untracked 全文合并解析为统一文件/hunk 行状），调用方零 git 知识；git 可执行显式解析（config 手动覆盖 → env → where 探测，不经 PATH 兜底 spawn）；三类截断上限（采集总字节/文件数/untracked 行数，超限置 truncated、剩余文件仅列名）；untracked 二进制 NUL 探测；四档错误判别联合
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { DiffFileRow, DiffHunk, DiffLine, WorkspaceDiffOk } from "@kanban/ipc-schema";

/** 一次 git 命令执行结果（带缓冲读取 stdout/stderr；spawnError 表示进程未启动，如 exe 消失；stdoutCapped 表示 stdout 达字节上限被截断采集并终止进程——截断不算失败） */
export interface GitRunOutcome {
  code: number;
  stdout: string;
  stderr: string;
  spawnError?: Error;
  /** stdout 采集达 maxBytes 上限被截断（#47）：调用方应置 truncated 而非报错 */
  stdoutCapped?: boolean;
}

/** 服务依赖注入 seam（可测）：exe 解析 + git 命令执行 + untracked 文件首段读取 */
export interface GitDiffDeps {
  /** git 可执行解析：null = 不可解析（→ git-missing） */
  resolveGitExe(): string | null;
  /** 在 cwd 执行一条 git 命令（带缓冲收集输出；超 maxOutputBytes 截断采集并终止进程） */
  runGit(exe: string, args: string[], cwd: string): Promise<GitRunOutcome>;
  /** 读取 cwd 下相对路径文件的首 maxBytes 字节（untracked 全文采集）；null = 读取失败（竞态删除/权限），调用方仅列名 */
  readFileHead(cwd: string, path: string, maxBytes: number): Promise<Buffer | null>;
}

/** 三类截断保护上限（#47，spec #40 E 节/F8；数值来自配置 config.diff，不在此设默认） */
export interface DiffLimits {
  /** git diff/status 采集 stdout 总字节上限 */
  maxBytes: number;
  /** 文件数上限（窗口外仅列名不采集） */
  maxFiles: number;
  /** 单个 untracked 新文件全文展示行数上限 */
  maxUntrackedLines: number;
}

/** 结果形状：统一文件列表 + 全局 truncated（三类上限任一触发即 true）∪ 四档错误 */
export type WorkspaceDiff =
  | WorkspaceDiffOk
  | { ok: false; kind: "not-a-repo" | "git-missing" | "git-failed" | "missing-cwd"; message: string };

// 空树对象哈希：无任何 commit 的空仓（git init 后未提交）diff 基准回退至此，暂存区新增仍可见
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// ============ git 输出解析（纯函数，测试面） ============

/** status 条目（XY 分类 + rename 原路径） */
export interface StatusEntry {
  path: string;
  changeType: "modified" | "added" | "deleted" | "renamed" | "untracked";
  oldPath: string | null;
}

/**
 * 解析 `git status --porcelain -z -uall` 输出为条目列表（截断对账与 untracked 清单的共用来源）。
 * -z 格式条目 NUL 分隔；重命名条目（XY 含 R/C）后跟一个原路径 token，作为 oldPath 跳过不误判。
 * XY 分类：?? → untracked；含 A → added；含 D → deleted；含 R/C → renamed；其余（M/U 等）→ modified。
 */
export function parseStatusEntries(text: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  const tokens = text.split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.length < 4) continue; // 空尾 token / 残段
    const xy = token.slice(0, 2);
    const path = token.slice(3);
    if (xy === "??") {
      entries.push({ path, changeType: "untracked", oldPath: null });
      continue;
    }
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
      const oldPath = tokens[i + 1];
      entries.push({ path, changeType: "renamed", oldPath: oldPath && oldPath.length > 0 ? oldPath : null });
      i += 1; // 跳过 rename 原路径 token
      continue;
    }
    const changeType = xy.includes("A") ? "added" : xy.includes("D") ? "deleted" : "modified";
    entries.push({ path, changeType, oldPath: null });
  }
  return entries;
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
 * HEAD 基准（无 commit 回退空树）→ 状态清单（完整条目）+ HEAD 对比 diff 并行采集 → 统一解析：
 * - 采集字节上限：stdout 超限截断采集 → truncated，diff 残节整节丢弃、缺失 tracked 由 status 对账仅列名；
 * - untracked 全文：文件数窗口内逐个读首段（NUL 判二进制；行数/字节上限截断置 truncated）；
 * - 文件数上限：窗口外一律仅列名（不读不展开），truncated=true。
 */
export async function readWorkspaceDiff(cwd: string, deps: GitDiffDeps, limits: DiffLimits): Promise<WorkspaceDiff> {
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
  if (!inside.stdoutCapped && inside.code !== 0) {
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

  // 状态清单（untracked + 截断对账来源）与 HEAD 对比 diff 并行采集
  const [statusRes, diffRes] = await Promise.all([
    deps.runGit(exe, ["status", "--porcelain", "-z", "-uall"], cwd),
    deps.runGit(exe, ["diff", base, "-M", "--unified=3"], cwd),
  ]);
  for (const r of [statusRes, diffRes]) {
    const fail = toSpawnFailure(r);
    if (fail) return fail;
  }
  if (!statusRes.stdoutCapped && statusRes.code !== 0) {
    return { ok: false, kind: "git-failed", message: `git status 失败：${statusRes.stderr.trim() || `exit ${statusRes.code}`}` };
  }
  if (!diffRes.stdoutCapped && diffRes.code !== 0) {
    return { ok: false, kind: "git-failed", message: `git diff 失败：${diffRes.stderr.trim() || `exit ${diffRes.code}`}` };
  }

  let truncated = statusRes.stdoutCapped === true || diffRes.stdoutCapped === true;

  // status 解析：截断时末条目可能残名，保守丢弃
  const statusEntries = parseStatusEntries(statusRes.stdout);
  if (statusRes.stdoutCapped && statusEntries.length > 0) statusEntries.pop();
  const untrackedPaths = statusEntries.filter((e) => e.changeType === "untracked").map((e) => e.path);

  // diff 解析：空路径节（头行残缺形态）跳过；截断时末节可能残缺，整节丢弃（名字由 status 对账补回）
  const tracked = parseUnifiedDiff(diffRes.stdout).filter((s) => s.path !== "");
  if (diffRes.stdoutCapped && tracked.length > 0) tracked.pop();
  if (diffRes.stdoutCapped) {
    // 对账：status 中有而 diff 已解析节中没有的 tracked 文件 → 仅列名（XY 分类为最佳努力近似）
    const covered = new Set(tracked.map((s) => s.path));
    for (const e of statusEntries) {
      if (e.changeType === "untracked" || covered.has(e.path)) continue;
      tracked.push({ path: e.path, changeType: e.changeType, binary: false, oldPath: e.oldPath, hunks: null, additions: 0, deletions: 0, headerPath: e.path });
    }
  }

  // untracked 全文采集：文件数窗口外的仅列名不读（串行读避免大量文件并发缓冲）
  const untrackedRows: DiffFileRow[] = [];
  for (let i = 0; i < untrackedPaths.length; i += 1) {
    const path = untrackedPaths[i];
    if (tracked.length + i >= limits.maxFiles) {
      untrackedRows.push({ path, changeType: "untracked", binary: false, oldPath: null, hunks: null, additions: 0, deletions: 0 });
      continue;
    }
    untrackedRows.push(await readUntrackedFile(deps, cwd, path, limits, (cut) => (truncated = truncated || cut)));
  }

  // 文件数上限：窗口外一律仅列名（已有内容的置 null）
  let files: DiffFileRow[] = [
    ...tracked.map((s) => ({
      path: s.path,
      changeType: s.changeType,
      binary: s.binary,
      oldPath: s.oldPath,
      hunks: s.hunks,
      additions: s.additions,
      deletions: s.deletions,
    })),
    ...untrackedRows,
  ];
  if (files.length > limits.maxFiles) {
    truncated = true;
    files = files.map((f, i) => (i < limits.maxFiles ? f : { ...f, hunks: null }));
  }
  return { ok: true, files, truncated };
}

/** 采集单个 untracked 文件全文：读取失败仅列名；NUL 判二进制只列名；行数/字节超限截断置 truncated */
async function readUntrackedFile(deps: GitDiffDeps, cwd: string, path: string, limits: DiffLimits, onCut: (cut: boolean) => void): Promise<DiffFileRow> {
  const nameOnly: DiffFileRow = { path, changeType: "untracked", binary: false, oldPath: null, hunks: null, additions: 0, deletions: 0 };
  const head = await deps.readFileHead(cwd, path, limits.maxBytes);
  if (head == null) return nameOnly; // 读取失败（竞态删除/权限）：仅列名，不失败整体
  if (isBinaryBuffer(head)) return { ...nameOnly, binary: true }; // 二进制：只列名与标注（spec US4）
  const { lines, cut } = decodeHeadLines(head, limits.maxBytes, limits.maxUntrackedLines);
  if (cut) onCut(true);
  return {
    ...nameOnly,
    additions: lines.length,
    hunks: lines.length > 0 ? [{ header: `@@ -0,0 +1,${lines.length} @@`, lines: lines.map((text): DiffLine => ({ kind: "add", text })) }] : [],
  };
}

/**
 * untracked 二进制探测（自定最小方案）：前 8000 字节含 NUL(0x00) 判二进制。
 * 与 git 自身 binary 判定同源（git 对 working tree 文件即用此启发式），文本文件极少含 NUL，误报面可忽略。
 */
function isBinaryBuffer(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** untracked 首段字节 → 全文行：\r\n 剥 \r；字节被切断时丢弃残行；行数超限截断；返回 cut 表示发生了截断 */
function decodeHeadLines(head: Buffer, maxBytes: number, maxLines: number): { lines: string[]; cut: boolean } {
  const byteCapped = head.length >= maxBytes; // 读满上限字节数 → 后面可能还有内容
  const parts = head.toString("utf8").split("\n").map((s) => (s.endsWith("\r") ? s.slice(0, -1) : s));
  if (parts.length > 0) {
    const last = parts[parts.length - 1];
    if (last === "") parts.pop(); // 正常 \n 结尾的空尾段
    else if (byteCapped) parts.pop(); // 字节边界切断的残行（可能还截在多字节字符中间），丢弃
  }
  const cut = byteCapped || parts.length > maxLines;
  return { lines: parts.length > maxLines ? parts.slice(0, maxLines) : parts, cut };
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

/** 生产执行器：spawn git（windowsHide，显式绝对路径不经 PATH 运行时查找）；stdout 累积超 maxOutputBytes 停止采集并终止进程（stdoutCapped=true，截断不算失败） */
function runGitSpawn(exe: string, args: string[], cwd: string, maxOutputBytes: number): Promise<GitRunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let stdoutCapped = false;
    child.stdout.on("data", (d: Buffer) => {
      if (stdoutCapped) return;
      stdout += d.toString("utf8");
      if (stdout.length > maxOutputBytes) {
        // 超上限：截到上限长度、终止 git 进程，剩余输出不再采集（stderr 不设限，量级恒小）
        stdoutCapped = true;
        stdout = stdout.slice(0, maxOutputBytes);
        child.kill();
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => resolve({ code: -1, stdout, stderr, spawnError: err, stdoutCapped }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr, stdoutCapped }));
  });
}

/** 生产 untracked 首段读取：同步打开读前 maxBytes 字节（避免整文件载入内存）；任何失败返回 null（仅列名） */
function readFileHeadFs(cwd: string, path: string, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    try {
      const fd = openSync(join(cwd, path), "r");
      try {
        const buf = Buffer.alloc(maxBytes);
        const n = readSync(fd, buf, 0, maxBytes, 0);
        resolve(buf.subarray(0, n));
      } finally {
        closeSync(fd);
      }
    } catch {
      resolve(null);
    }
  });
}

/** 生产 deps 工厂（index.ts 装配传 config.gitExe + config.diff 上限；测试注入 fixture deps 与显式上限） */
export function defaultGitDiffDeps(manualGitExe: string | null, limits: DiffLimits): GitDiffDeps {
  return {
    resolveGitExe: () => resolveGitExeDefault(manualGitExe),
    runGit: (exe, args, cwd) => runGitSpawn(exe, args, cwd, limits.maxBytes),
    readFileHead: (cwd, path, maxBytes) => readFileHeadFs(cwd, path, maxBytes),
  };
}
