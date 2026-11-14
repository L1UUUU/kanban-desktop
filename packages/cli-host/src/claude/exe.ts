// 用途：claude exe 解析链差异声明（arch C4）—— manual→env→npm 全局→where/which 的链骨架单源在 ../exe-chain，此处只声明 claude 的候选步（npm 全局布局 + PATH 兜底过滤）；对外 resolve/listCandidates 签名保持
import path from "node:path";
import { listExeChainCandidates, npmGlobalExeStep, pathLookupExeStep, resolveExeChain, type ExeChainSpec } from "../exe-chain";
import type { ExeCandidateProbes } from "../exe-probes";

/** 解析优先级：手动覆盖（config cliExe.claude）→ env KANBAN_CLAUDE_BIN → npm 全局 bin/claude.exe → where/which 显式解析 */
export interface ClaudeExeOptions {
  /** config.ts cliExe.claude 的手动覆盖路径（最高优先） */
  manualOverride?: string | null;
}

/**
 * claude PATH 行采纳谓词（arch D4 单源，纯函数）：win32 只采纳 .exe；posix 采纳非 .cmd（无扩展名原生可执行可被 resolve 采纳）。
 * 平台作显式入参：表驱动直测可在 win32 本机钉住 posix 分支；链内接线传 process.platform。
 */
export function adoptClaudePathLine(platform: NodeJS.Platform, line: string): boolean {
  const lower = line.toLowerCase();
  return platform === "win32" ? lower.endsWith(".exe") : !lower.endsWith(".cmd");
}

/**
 * claude 解析链声明：候选并集与 resolve 从同一条链派生（采纳条件天然一致）。
 * PATH 兜底采纳谓词平台感知单源（adoptClaudePathLine，arch D4）：win32 只认 .exe、posix 认非 .cmd。
 */
export const CLAUDE_EXE_CHAIN: ExeChainSpec = {
  cli: "claude",
  envVar: "KANBAN_CLAUDE_BIN",
  steps: [
    // npm 全局 @anthropic-ai/claude-code/bin/claude.exe（poc-7 实证形态；posix 下为无扩展名可执行）
    npmGlobalExeStep({
      layout: (root) => path.join(root, "@anthropic-ai", "claude-code", "bin", process.platform === "win32" ? "claude.exe" : "claude"),
      miss: (_root, candidate) => `npm 全局 ${candidate} 不存在`,
    }),
    pathLookupExeStep({
      name: "claude",
      adopt: (line) => adoptClaudePathLine(process.platform, line),
    }),
  ],
};

/** 解析 claude 真实 exe：找不到时抛 ExeNotFoundError（含已尝试路径与覆盖方法，失败可定位）。spec G：本函数所有分支都返回「显式绝对路径」，claude 兜底回退 PATH 在产品中不可用 */
export function resolveClaudeExe(options: ClaudeExeOptions = {}): string {
  return resolveExeChain(CLAUDE_EXE_CHAIN, options);
}

/** claude 解析链全量候选路径并集（#49 残留检测的 exe 匹配粒度；与 resolveClaudeExe 自同一条链派生） */
export function listClaudeExeCandidates(options: ClaudeExeOptions & ExeCandidateProbes = {}): string[] {
  return listExeChainCandidates(CLAUDE_EXE_CHAIN, options);
}
