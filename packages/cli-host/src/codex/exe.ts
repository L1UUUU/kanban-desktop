// 用途：解析真实 vendored codex.exe 路径与版本（spawn 直连目标，不经 .cmd shim；spec G 通用决策 + t0-01 实证链路）+ 解析链候选并集（#49 残留检测）
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ExeNotFoundError } from "../adapter";
import { dedupePaths, type ExeCandidateProbes } from "../exe-probes";

/** 解析优先级：手动覆盖（config）→ env KANBAN_CODEX_BIN → npm 全局 vendored exe → 本地 node_modules */
export interface CodexExeOptions {
  /** config.ts cliExe.codex 的手动覆盖路径（最高优先） */
  manualOverride?: string | null;
}

/** 通过 npm root -g 定位全局安装根（win32 下 npm 是 .cmd，经 ComSpec 执行避免 shell 转义问题） */
function npmRootGlobal(): string {
  if (process.platform === "win32") {
    return execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm root -g"], {
      encoding: "utf8",
    }).trim();
  }
  return execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
}

/** @openai/codex 包根 → vendored 原生 exe（.cmd shim → node 脚本 → codex-win32-x64/vendor/.../bin/codex.exe） */
function vendoredExe(pkgRoot: string): string | null {
  const bin = process.platform === "win32" ? "codex.exe" : "codex";
  const exe = path.join(
    pkgRoot,
    "node_modules",
    "@openai",
    "codex-win32-x64",
    "vendor",
    "x86_64-pc-windows-msvc",
    "bin",
    bin,
  );
  return existsSync(exe) ? exe : null;
}

/**
 * 解析 codex 真实 exe：找不到时抛错（含已尝试路径与覆盖方法，失败可定位）。
 * 环境变量 KANBAN_CODEX_BIN 与 config 手动覆盖均支持，绝对路径不硬编码。
 */
export function resolveCodexExe(options: CodexExeOptions = {}): string {
  const tried: string[] = [];
  // 1) config 手动覆盖
  if (options.manualOverride) {
    if (existsSync(options.manualOverride)) return options.manualOverride;
    tried.push(`手动覆盖 ${options.manualOverride}（不存在）`);
  }
  // 2) env 覆盖（测试/特殊环境）
  if (process.env.KANBAN_CODEX_BIN) {
    if (existsSync(process.env.KANBAN_CODEX_BIN)) return process.env.KANBAN_CODEX_BIN;
    tried.push(`KANBAN_CODEX_BIN=${process.env.KANBAN_CODEX_BIN}（不存在）`);
  }
  // 3) npm 全局 vendored exe（矩阵实证链路）
  try {
    const root = npmRootGlobal();
    const exe = vendoredExe(path.join(root, "@openai", "codex"));
    if (exe) return exe;
    tried.push(`npm 全局 ${path.join(root, "@openai", "codex")} 下未找到 vendored exe`);
  } catch (e) {
    tried.push(`npm root -g 探测失败：${e instanceof Error ? e.message : String(e)}`);
  }
  // 4) 本进程可达的 node_modules（开发态/monorepo 内安装）
  try {
    const req = createRequire(import.meta.url);
    const exe = vendoredExe(path.dirname(req.resolve("@openai/codex/package.json")));
    if (exe) return exe;
  } catch {
    /* 无本地安装，落入报错 */
  }
  throw new ExeNotFoundError(
    `未找到 codex 可执行文件（已尝试：${tried.join("；") || "无"}）。请在设置中手动指定 codex.exe 路径或设置 KANBAN_CODEX_BIN。`,
  );
}

/** 读取 codex 版本（锁版本探针输入；失败返回 null 不阻塞启动） */
export function readCodexVersion(exe: string): string | null {
  try {
    return execFileSync(exe, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** 本地 node_modules vendored exe 探测（解析链第 4 步；独立成函数供候选并集复用，失败返回 null） */
function localVendoredExePath(): string | null {
  try {
    const req = createRequire(import.meta.url);
    return vendoredExe(path.dirname(req.resolve("@openai/codex/package.json")));
  } catch {
    return null; // 无本地安装
  }
}

/**
 * codex 解析链全量候选路径并集（#49 残留检测的 exe 匹配粒度；与 resolveCodexExe 采纳条件一致：存在才收）。
 * 顺序即解析链优先级：manualOverride → KANBAN_CODEX_BIN → npm 全局 vendored → 本地 node_modules vendored；去重。
 */
export function listCodexExeCandidates(
  options: CodexExeOptions & ExeCandidateProbes & { localVendoredExe?: () => string | null } = {},
): string[] {
  const paths: string[] = [];
  if (options.manualOverride && existsSync(options.manualOverride)) paths.push(options.manualOverride);
  if (process.env.KANBAN_CODEX_BIN && existsSync(process.env.KANBAN_CODEX_BIN)) paths.push(process.env.KANBAN_CODEX_BIN);
  try {
    const root = (options.npmRoot ?? npmRootGlobal)();
    const exe = vendoredExe(path.join(root, "@openai", "codex"));
    if (exe) paths.push(exe);
  } catch {
    /* npm root -g 探测失败：无全局候选 */
  }
  const local = (options.localVendoredExe ?? localVendoredExePath)();
  if (local) paths.push(local);
  return dedupePaths(paths);
}
