// 用途：@kanban/cli-host 入口 —— C1 Adapter 统一契约（adapter.ts）+ FakeAdapter（fake-adapter.ts）；三 CLI 实现与 CliHost 自 #7/#9/#10 填充
export * from "./adapter";
export { FakeAdapter, type FakeAdapterOptions } from "./fake-adapter";
export type { ScriptStep } from "./fake-scripts";
export { pickScript, DEFAULT_TURN_SCRIPT, APPROVAL_SCRIPT, EXPIRY_SCRIPT, ERROR_SCRIPT } from "./fake-scripts";
export { VirtualClock, SystemClock, type FakeClock } from "./clock";
