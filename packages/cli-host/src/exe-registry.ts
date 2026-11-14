// 用途：cli → exe 解析链注册表（arch C4）—— run-once 等按 cli 名取链的单一分发点；新增 CLI 在其 <cli>/exe.ts 用 ../exe-chain 步工厂声明链后于此登记（键序即对外列举序）
import { CLAUDE_EXE_CHAIN } from "./claude/exe";
import { CODEX_EXE_CHAIN } from "./codex/exe";
import type { ExeChainSpec } from "./exe-chain";
import { OPENCODE_EXE_CHAIN } from "./opencode/exe";

/** cli 名 → 解析链声明 */
export const EXE_CHAINS: Readonly<Record<string, ExeChainSpec>> = {
  claude: CLAUDE_EXE_CHAIN,
  codex: CODEX_EXE_CHAIN,
  opencode: OPENCODE_EXE_CHAIN,
};
