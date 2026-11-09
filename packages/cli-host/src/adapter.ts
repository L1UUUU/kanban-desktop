// 用途：C1 Adapter 统一契约（spec B 冻结）—— 方法面 + capabilities + 带错误码的异常；实现侧（Fake/三 CLI）与宿主（CliHost/Main 路由）共同依赖
import type {
  ApprovalDecision,
  ApprovalSuggestion,
  AdapterEvent,
  ChatEvent,
  ErrorCode,
  PermMode,
  TranscriptEvent,
} from "@kanban/ipc-schema";

/** 能力声明：未实证能力 UI 不暴露控件（spec B capabilities） */
export interface AdapterCapabilities {
  approval: boolean;
  interrupt: boolean;
  resume: boolean;
  readHistory: boolean;
  skillSignal: boolean;
}

/** createSession 输入（cwd 必填；model/permMode 由 Adapter 映射到各 CLI 原生机制；cli 供 AdapterRouter 分发，单实现忽略） */
export interface CreateSessionInput {
  cwd: string;
  model?: string;
  permMode?: PermMode;
  /** 目标 CLI（AdapterRouter 按 CLI 分发；单 Adapter 实现忽略） */
  cli?: string;
}

export interface SendTurnInput {
  sessionId: string;
  text: string;
}

export interface ResolveApprovalInput {
  sessionId: string;
  requestId: string;
  decision: ApprovalDecision;
}

export interface DisposeInput {
  sessionId?: string;
}

/** 会话收养输入（#13 恢复编排）：按 DB 持久化的 native id 重建会话状态（登记 disconnected，无进程；readHistory/resume 按需拉起） */
export interface AdoptSessionInput {
  /** 应用侧 sessionId（DB sessions 表 PK） */
  sessionId: string;
  /** 各 CLI 原生会话 id（sessions.native_session_id；Fake 等无原生 id 的实现忽略） */
  nativeSessionId: string;
  cwd: string;
  permMode?: PermMode;
  model?: string;
  /** 目标 CLI（AdapterRouter 按 CLI 分发；单 Adapter 实现忽略） */
  cli?: string;
}

/** Adapter 异常：code 形状由 ipc-schema 定义（不变量 6），宿主据此映射 IPC 错误 */
export class AdapterError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

/**
 * C1 统一接口（全部方法异步；订阅为同步注册返回退订函数）。
 * 六不变量（spec B，强制）：
 * 1. 内容一律经事件流返回，sendTurn 只表达「已提交」；
 * 2. 审批语义不换写（统一枚举映射各 CLI 原生机制）；
 * 3. 事件带可合并键（itemId/partId），流式增量无重复无丢失；
 * 4. readHistory 快照与实时流同一合并键，快照后增量无缝拼接；
 * 5. Adapter 独占 CLI 进程生命周期（宿主不触碰子进程）；
 * 6. 忙态 sendTurn 排队 + interruptTurn 幂等；错误码形状由 ipc-schema 定义。
 */
export interface CliAdapter {
  readonly capabilities: AdapterCapabilities;
  /** nativeSessionId 为各 CLI 原生会话 id（Codex thread id 等；Fake 无则为 undefined/null），宿主据此回填 sessions 表 */
  createSession(init: CreateSessionInput): Promise<{ sessionId: string; nativeSessionId?: string | null }>;
  sendTurn(input: SendTurnInput): Promise<void>;
  interruptTurn(sessionId: string): Promise<void>;
  resolveApproval(input: ResolveApprovalInput): Promise<void>;
  readHistory(sessionId: string): Promise<ChatEvent[]>;
  /**
   * C1 演进（#28 / spec #27 B 节）：读取会话原生历史的 user/assistant 双视角事件。
   * 与 readHistory（GUI 聊天流，ChatEvent 13 成员无 user 消息）互补而非替代；
   * capabilities 门控同 readHistory（无单独开关）；各实现从原生历史源只读拉取。
   */
  readTranscript(sessionId: string): Promise<TranscriptEvent[]>;
  resume(sessionId: string): Promise<void>;
  dispose(input?: DisposeInput): Promise<void>;
  /** 应用重启后的会话收养（可选能力，#13）：登记断开会话供 readHistory/resume 恢复；未实现时恢复编排落库为断开并报错引导 */
  adoptSession?(input: AdoptSessionInput): Promise<void>;
  /**
   * C5 演进（#44 / spec #40 C 节）：上报本 Adapter 当前管理的全部活跃 CLI 子进程 pid（去重集合）。
   * 可选成员：无子进程的实现（Fake 等）可省略（聚合方按空集处理）；
   * 残留治理（#49）以此 worker/进程内形态上报的并集为「本应用活跃集合」判定基准。
   */
  listChildPids?(): Promise<number[]>;
  /** 订阅归一化事件流（ChatEvent ∪ SkillObservation），返回退订函数 */
  subscribe(handler: (event: AdapterEvent) => void): () => void;
}

export type { ApprovalDecision, ApprovalSuggestion, AdapterEvent, ChatEvent, PermMode, TranscriptEvent };
