// 用途：解析真实 claude 可执行文件路径（spawn 直连目标，不经 .cmd shim / PATH 兜底；spec G 通用决策 + poc-7 实证链路）+ 解析链候选并集（#49 残留检测）
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { ExeNotFoundError } from "../adapter";
import { dedupePaths, lookupAllPathLines, type ExeCandidateProbes } from "../exe-probes";

/** 解析优先级：手动覆盖（config cliExe.claude）→ env KANBAN_CLAUDE_BIN → npm 全局 bin/claude.exe → where/which 显式解析 */
export interface ClaudeExeOptions {
  /** config.ts cliExe.claude 的手动覆盖路径（最高优先） */
  manualOverride?: string | null;
}

/** 通过 npm root -g 定位全局安装根（win32 下 npm 是 .cmd，经 ComSpec 执行避免 shell 转义问题；与 codex/exe.ts 同链路） */
function npmRootGlobal(): string {
  if (process.platform === "win32") {
    return execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm root -g"], {
      encoding: "utf8",
    }).trim();
  }
  return execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
}

/** 经 PATH 显式解析可执行文件绝对路径（where/which 只用于「找到路径」，spawn 仍直连该绝对路径，不回退 PATH 运行时查找） */
function fromPathLookup(): string | null {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, ["claude"], { encoding: "utf8" }).trim();
    // where 可能返回多行（.cmd/.exe/…），优先真实 exe，其次非 shim 的可执行
    for (const line of out.split(/\r?\n/).filter(Boolean)) {
      if (existsSync(line) && line.toLowerCase().endsWith(".exe")) return line;
    }
    return null; // 只有 .cmd shim（npm shim 指向 node 脚本）时不采用：spawn .cmd 会留孤儿（PoC 1 发现 4）
  } catch {
    return null; // PATH 上无 claude
  }
}

/**
 * 解析 claude 真实 exe：找不到时抛错（含已尝试路径与覆盖方法，失败可定位）。
 * spec G：claude 兜底回退 PATH 在产品中不可用 —— 本函数所有分支都返回「显式绝对路径」。
 */
export function resolveClaudeExe(options: ClaudeExeOptions = {}): string {
  const tried: string[] = [];
  // 1) config 手动覆盖
  if (options.manualOverride) {
    if (existsSync(options.manualOverride)) return options.manualOverride;
    tried.push(`手动覆盖 ${options.manualOverride}（不存在）`);
  }
  // 2) env 覆盖（测试/特殊环境；CliHostClient 经 env 传给 worker）
  if (process.env.KANBAN_CLAUDE_BIN) {
    if (existsSync(process.env.KANBAN_CLAUDE_BIN)) return process.env.KANBAN_CLAUDE_BIN;
    tried.push(`KANBAN_CLAUDE_BIN=${process.env.KANBAN_CLAUDE_BIN}（不存在）`)
  }
  // 3) npm 全局 @anthropic-ai/claude-code/bin/claude.exe（poc-7 实证形态；posix 下为无扩展名可执行）
  try {
    const root = npmRootGlobal();
    const bin = process.platform === "win32" ? "claude.exe" : "claude";
    const exe = path.join(root, "@anthropic-ai", "claude-code", "bin", bin);
    if (existsSync(exe)) return exe;
    tried.push(`npm 全局 ${path.join(root, "@anthropic-ai", "claude-code", "bin", bin)} 不存在`)
  } catch (e) {
    tried.push(`npm root -g 探测失败：${e instanceof Error ? e.message : String(e)}`)
  }
  // 4) where/which 显式解析（仅采纳真实 .exe / 可执行文件）
  const looked = fromPathLookup();
  if (looked) return looked;
  tried.push("where/which 未解析到 claude 可执行文件（.cmd shim 不采用）")
  throw new ExeNotFoundError(
    `未找到 claude 可执行文件（已尝试：${tried.join("；")}）。请在设置中手动指定 claude.exe 路径或设置 KANBAN_CLAUDE_BIN。`,
  );
}

/**
 * claude 解析链全量候选路径并集（#49 残留检测的 exe 匹配粒度；采纳条件与 resolveClaudeExe 一致）。
 * 顺序：manualOverride → KANBAN_CLAUDE_BIN → npm 全局 bin/claude.exe → where/which 全部真实可执行（.cmd shim 不采用，多结果全收）；去重。
 */
export function listClaudeExeCandidates(options: ClaudeExeOptions & ExeCandidateProbes = {}): string[] {
  const paths: string[] = [];
  if (options.manualOverride && existsSync(options.manualOverride)) paths.push(options.manualOverride);
  if (process.env.KANBAN_CLAUDE_BIN && existsSync(process.env.KANBAN_CLAUDE_BIN)) paths.push(process.env.KANBAN_CLAUDE_BIN);
  try {
    const root = (options.npmRoot ?? npmRootGlobal)();
    const bin = process.platform === "win32" ? "claude.exe" : "claude";
    const exe = path.join(root, "@anthropic-ai", "claude-code", "bin", bin);
    if (existsSync(exe)) paths.push(exe);
  } catch {
    /* npm root -g 探测失败：无全局候选 */
  }
  const lines = (options.pathLookup ?? (() => lookupAllPathLines("claude")))("claude");
  // where 多结果全收（不只首个命中）：win32 只收真实 .exe，posix 收非 .cmd 可执行（与 fromPathLookup 同过滤）
  for (const line of lines) {
    if (process.platform === "win32" ? line.toLowerCase().endsWith(".exe") : !line.toLowerCase().endsWith(".cmd")) {
      paths.push(line);
    }
  }
  return dedupePaths(paths);
}
