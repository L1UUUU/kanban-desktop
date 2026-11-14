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
 * claude 解析链声明：候选并集与 resolve 从同一条链派生（采纳条件天然一致）。
 * PATH 兜底：resolve 只采纳真实 .exe（posix 无扩展名结果不采纳——现行行为保持）；并集 win32 只收 .exe、posix 收非 .cmd。
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
      adoptFirst: (line) => line.toLowerCase().endsWith(".exe"),
      adoptAll: (line) =>
        process.platform === "win32" ? line.toLowerCase().endsWith(".exe") : !line.toLowerCase().endsWith(".cmd"),
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
