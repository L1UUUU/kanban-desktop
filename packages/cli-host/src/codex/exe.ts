// 用途：codex exe 解析链差异声明（arch C4）—— 链骨架单源在 ../exe-chain，此处只声明 codex 特有步（npm 全局 vendored 布局 + 本地 node_modules vendored）；vendored 布局与版本读取保留在本模块，对外签名保持
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { listExeChainCandidates, npmGlobalExeStep, probeExeStep, resolveExeChain, type ExeChainSpec } from "../exe-chain";
import type { ExeCandidateProbes } from "../exe-probes";

/** 解析优先级：手动覆盖（config）→ env KANBAN_CODEX_BIN → npm 全局 vendored exe → 本地 node_modules */
export interface CodexExeOptions {
  /** config.ts cliExe.codex 的手动覆盖路径（最高优先） */
  manualOverride?: string | null;
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

/** 本地 node_modules vendored exe 探测（解析链末步；独立成函数供测试注入替换，失败返回 null） */
function localVendoredExePath(): string | null {
  try {
    const req = createRequire(import.meta.url);
    return vendoredExe(path.dirname(req.resolve("@openai/codex/package.json")));
  } catch {
    return null; // 无本地安装
  }
}

/** codex 解析链声明：候选并集与 resolve 从同一条链派生（存在才收）；无 PATH 兜底步——codex 经 npm 分发，vendored 布局是唯一形态 */
export const CODEX_EXE_CHAIN: ExeChainSpec = {
  cli: "codex",
  envVar: "KANBAN_CODEX_BIN",
  steps: [
    npmGlobalExeStep({
      layout: (root) => vendoredExe(path.join(root, "@openai", "codex")),
      miss: (root) => `npm 全局 ${path.join(root, "@openai", "codex")} 下未找到 vendored exe`,
    }),
    // 本地 node_modules（开发态/monorepo 内安装）：未命中不记已尝试（现行行为保持）
    probeExeStep({ probe: (injection) => (injection.localVendoredExe ?? localVendoredExePath)() }),
  ],
};

/** 解析 codex 真实 exe：找不到时抛 ExeNotFoundError（含已尝试路径与覆盖方法，失败可定位）。环境变量 KANBAN_CODEX_BIN 与 config 手动覆盖均支持，绝对路径不硬编码 */
export function resolveCodexExe(options: CodexExeOptions = {}): string {
  return resolveExeChain(CODEX_EXE_CHAIN, options);
}

/** 读取 codex 版本（锁版本探针输入；失败返回 null 不阻塞启动） */
export function readCodexVersion(exe: string): string | null {
  try {
    return execFileSync(exe, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** codex 解析链全量候选路径并集（#49 残留检测的 exe 匹配粒度；与 resolveCodexExe 自同一条链派生：存在才收） */
export function listCodexExeCandidates(options: CodexExeOptions & ExeCandidateProbes = {}): string[] {
  return listExeChainCandidates(CODEX_EXE_CHAIN, options);
}
