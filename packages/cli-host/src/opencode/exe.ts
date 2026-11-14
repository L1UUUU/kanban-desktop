// 用途：opencode exe 解析链差异声明（arch C4）—— 链骨架单源在 ../exe-chain，此处只声明 opencode 特有步（npm 全局优先于原生安装的步序 + PATH 兜底过滤）；对外 resolve/listCandidates 签名保持
import { existsSync } from "node:fs";
import path from "node:path";
import { listExeChainCandidates, npmGlobalExeStep, pathLookupExeStep, probeExeStep, resolveExeChain, type ExeChainSpec } from "../exe-chain";
import type { ExeCandidateProbes } from "../exe-probes";

/** 解析优先级：手动覆盖（config cliExe.opencode）→ env KANBAN_OPENCODE_BIN → npm 全局 → 原生安装目录 → where/which 显式解析 */
export interface OpenCodeExeOptions {
  manualOverride?: string | null;
}

/** 原生安装形态：Windows 安装器布局 %LOCALAPPDATA%\Programs\opencode\opencode.exe（工单指定直连目标） */
function nativeInstallPath(): string | null {
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  const exe = path.join(local, "Programs", "opencode", "opencode.exe");
  return existsSync(exe) ? exe : null;
}

/**
 * opencode 解析链声明：候选并集与 resolve 从同一条链派生。
 * npm 全局优先于原生安装：npm 1.19.5 为 poc-3 实测版本且与用户真实 opencode DB 兼容；
 * 原生安装（1.15.7）对 1.19.5 时代的用户 DB migration 失败（启动挂死，e2e 前探针实证）。
 * shortcut: 用户升级原生安装到 ≥1.19.5 后可复查优先级；复查触发条件 = 原生版本号追平 npm 版本。
 */
export const OPENCODE_EXE_CHAIN: ExeChainSpec = {
  cli: "opencode",
  envVar: "KANBAN_OPENCODE_BIN",
  steps: [
    // npm 全局 opencode-ai/bin/opencode.exe（poc-3 实测形态；DB 版本兼容）
    npmGlobalExeStep({
      layout: (root) => path.join(root, "opencode-ai", "bin", process.platform === "win32" ? "opencode.exe" : "opencode"),
      miss: (_root, candidate) => `npm 全局 ${candidate} 不存在`,
    }),
    // 原生安装目录（win32 安装器布局；DB 版本兼容问题见上方 shortcut）
    probeExeStep({ probe: () => nativeInstallPath(), miss: "原生安装目录 %LOCALAPPDATA%\\Programs\\opencode\\opencode.exe 不存在" }),
    pathLookupExeStep({
      name: "opencode",
      adopt: (line) => !line.toLowerCase().endsWith(".cmd"),
    }),
  ],
};

/** 解析 opencode 真实 exe：找不到时抛 ExeNotFoundError（含已尝试路径与覆盖方法，失败可定位）；npm 与原生安装的优先级依据见 OPENCODE_EXE_CHAIN 注释 */
export function resolveOpenCodeExe(options: OpenCodeExeOptions = {}): string {
  return resolveExeChain(OPENCODE_EXE_CHAIN, options);
}

/** opencode 解析链全量候选路径并集（#49 残留检测的 exe 匹配粒度；与 resolveOpenCodeExe 自同一条链派生） */
export function listOpenCodeExeCandidates(options: OpenCodeExeOptions & ExeCandidateProbes = {}): string[] {
  return listExeChainCandidates(OPENCODE_EXE_CHAIN, options);
}
