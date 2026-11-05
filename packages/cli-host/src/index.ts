// 用途：@kanban/cli-host 入口 —— C1 Adapter 统一契约 + FakeAdapter + CodexAdapter/ClaudeAdapter（真实结构化会话）+ AdapterRouter + CliHost seam；OpenCode 自 #11 填充
export * from "./adapter";
export { FakeAdapter, type FakeAdapterOptions } from "./fake-adapter";
export type { ScriptStep } from "./fake-scripts";
export { pickScript, DEFAULT_TURN_SCRIPT, APPROVAL_SCRIPT, EXPIRY_SCRIPT, ERROR_SCRIPT } from "./fake-scripts";
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
export { AdapterRouter, type AdapterFactory } from "./router-adapter";
export { CliHost, type HostCommand, type HostCommandResult, type ShutdownOptions } from "./host/cli-host";
export { createDesktopAdapterFactory, type DesktopAdapterFactoryOptions } from "./host/desktop-adapters";
