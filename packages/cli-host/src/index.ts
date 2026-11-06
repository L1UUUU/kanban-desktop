// 用途：@kanban/cli-host 入口 —— C1 Adapter 统一契约 + FakeAdapter + CodexAdapter/ClaudeAdapter/OpenCodeAdapter（真实结构化会话）+ AdapterRouter + CliHost seam
export * from "./adapter";
export { FakeAdapter, type FakeAdapterOptions } from "./fake-adapter";
export type { ScriptStep } from "./fake-scripts";
export { pickScript, DEFAULT_TURN_SCRIPT, APPROVAL_SCRIPT, EXPIRY_SCRIPT, ERROR_SCRIPT } from "./fake-scripts";
export { detectSkillConflicts, resolveUserClaudeDir } from "./skill-conflicts";
export { VirtualClock, SystemClock, type FakeClock } from "./clock";
export { CodexAdapter, type CodexAdapterOptions, type CodexRpcClientLike } from "./codex-adapter";
export { resolveCodexExe, readCodexVersion } from "./codex/exe";
export { CodexRpcClient, RpcError } from "./codex/rpc";
export { createDefaultModelResolver, latestRolloutModel, probeModelWithMinimalTurn, type ModelResolver, type ProbeClient } from "./codex/model-probe";
export { probeProtocol, type ProtocolProbeResult } from "./codex/protocol-probe";
export { ClaudeAdapter, type ClaudeAdapterOptions, type ClaudeStreamClientLike } from "./claude-adapter";
export { resolveClaudeExe } from "./claude/exe";
export { ClaudeStreamClient, CLAUDE_BASE_ARGS, assertApprovalFlag, type ClaudeStreamOptions } from "./claude/client";
export { resolveHookNodeBin } from "./claude/hook-inject";
export { findTranscriptFile } from "./claude/transcript";
export { OpenCodeAdapter, type OpenCodeAdapterOptions, splitModelId } from "./opencode-adapter";
export { resolveOpenCodeExe } from "./opencode/exe";
export { OpenCodeHttpServerClient, type OpenCodeServerClientLike, type OpenCodeSseEvent, type OpenCodeApiResponse } from "./opencode/client";
export { OpenCodeServerHost, OPENCODE_PERM_CONFIG, type OpenCodeServerHostLike, type OpenCodeServerHostOptions } from "./opencode/server-host";
export { AdapterRouter, type AdapterFactory } from "./router-adapter";
export { CliHost, type HostCommand, type HostCommandResult, type ShutdownOptions } from "./host/cli-host";
export { createDesktopAdapterFactory, type DesktopAdapterFactoryOptions } from "./host/desktop-adapters";
// #29 C5 演进：run-once 一次性执行（spec #27 C 节）+ Job guard 脚本单一事实源
export { RunOnceRunner, DEFAULT_RUN_ONCE_TIMEOUT_MS, type RunOnceInput, type RunOnceResult } from "./host/run-once";
export { JOB_GUARD_PS } from "./host/job-guard";
