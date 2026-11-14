// 用途：cli 单源注册表（arch C4/D5）—— cli 名、exe 解析链、KANBAN_DISABLE_* Fake 回切开关名一处登记；status 探测装配、router 预热、desktop 工厂开关判断遍历此处派生。新增 CLI 在其 <cli>/exe.ts 用 ../exe-chain 步工厂声明链后于此登记（键序即对外列举序；键集钉在 RealCliKind 上，wire 契约加 CLI 而漏登记即编译错）
import type { RealCliKind } from "@kanban/ipc-schema";
import { CLAUDE_EXE_CHAIN } from "./claude/exe";
import { CODEX_EXE_CHAIN } from "./codex/exe";
import { resolveExeChain, type ExeChainSpec } from "./exe-chain";
import { OPENCODE_EXE_CHAIN } from "./opencode/exe";

/** 注册表条目（arch D5）：exe 解析链（arch C4）+ Fake 回切开关名——desktop-adapters 回切与 cli:status 旁路同一开关语义的单源 */
export interface CliExeEntry {
  /** exe 探测链 */
  chain: ExeChainSpec;
  /** Fake 回切开关环境变量名（=1 时会话回落 Fake 演示模式、status 视为可用不灰置） */
  disableEnv: string;
}

/** cli 名 → 单源注册条目 */
export const CLI_REGISTRY: Readonly<Record<RealCliKind, CliExeEntry>> = {
  claude: { chain: CLAUDE_EXE_CHAIN, disableEnv: "KANBAN_DISABLE_CLAUDE" },
  codex: { chain: CODEX_EXE_CHAIN, disableEnv: "KANBAN_DISABLE_CODEX" },
  opencode: { chain: OPENCODE_EXE_CHAIN, disableEnv: "KANBAN_DISABLE_OPENCODE" },
};

/** 真实 CLI 名单（列举序 = 注册键序；status 探测 / router 预热遍历派生，勿另抄） */
export const REAL_CLI_KINDS: readonly RealCliKind[] = Object.keys(CLI_REGISTRY) as RealCliKind[];

/** cli → 解析链视图：run-once 等按 cli 名取链的单一分发点（自注册表派生，勿另行登记） */
export const EXE_CHAINS: Readonly<Record<string, ExeChainSpec>> = Object.fromEntries(
  REAL_CLI_KINDS.map((cli) => [cli, CLI_REGISTRY[cli].chain]),
);

/** 按注册表解析指定 cli 的真实 exe（cli:status 真实探测等的统一解析入口；找不到抛 ExeNotFoundError） */
export function resolveCliExe(cli: RealCliKind, options: { manualOverride?: string | null } = {}): string {
  return resolveExeChain(CLI_REGISTRY[cli].chain, options);
}
