// 用途：共享 turn 内核（arch C1）—— 不变量 6「忙态 sendTurn 排队 + interruptTurn 幂等」的回合状态机单源：每会话回合状态（seq/日志/队列/turnActive/待决审批）与终态策略（interrupted/failed 丢队列、completed 续发、残留审批收口）由内核持有；四家 adapter（fake/claude/codex/opencode）注入 wire 回调消费——真 wire 差异（残留审批应答形状、发文本、中断、活性判定）全部落在回调边界
import type { ChatEvent, ChatEventSeed } from "@kanban/ipc-schema";
import { AdapterError } from "./adapter";

/** 回合终态（内核三分支策略：interrupted/failed 丢弃排队，completed 续发队首） */
export type TurnTerminalStatus = "completed" | "interrupted" | "failed";

/** 审批待决条目基类：内核只关心三字段；wire 挂起应答等扩展字段由各 adapter 的条目类型自带 */
export interface KernelApproval {
  requestId: string;
  itemId: string;
  decided: boolean;
}

/**
 * 每会话回合状态（消费方 SessionState 结构性实现本接口内嵌持有；seq/log/queue/turnActive/pendingApprovals 的写路径收敛到内核）。
 * sessionId 供 emit 归属事件；interruptRequested 为幂等中断闸门。
 */
export interface TurnState<TApproval extends KernelApproval = KernelApproval> {
  sessionId: string;
  seq: number;
  log: ChatEvent[];
  queue: string[];
  turnActive: boolean;
  interruptRequested: boolean;
  pendingApprovals: Map<string, TApproval>;
}

/** 内核构造注入项：广播出口（adapter 订阅集）与时间源（fake 注入 VirtualClock） */
export interface TurnKernelOptions {
  /** ChatEvent 广播出口（内核写日志后调用；SkillObservation 不经内核，仍由 adapter 直发） */
  broadcast: (ev: ChatEvent) => void;
  /** 时间源毫秒（缺省 Date.now；fake 注入 clock.now 获得确定性） */
  nowMs?: () => number;
}

/** finishTurn 注入项：终态残留收口（真 wire 差异 seam）与排队续发出口 */
export interface FinishTurnHooks<TApproval extends KernelApproval = KernelApproval> {
  /**
   * 终态残留收口：内核在回合状态复位后、终态事件发射前逐会话调用一次（审批 map 此时尚未清空）。
   * 真 wire 差异落点——claude 对残留审批回 respond({behavior:"deny"})、codex 回 respond({decision:"cancel"})、
   * opencode 发 approval_expired 事件、fake 冲刷流式/运行中工具；各实现按 status 分支决定额外收口（如 opencode 非终态工具置 interrupted）。
   */
  onResidue?: (s: TurnState<TApproval>, status: TurnTerminalStatus) => void;
  /** completed 续发排队项出口：adapter 决定同步发（claude）、异步发并吞错（codex/opencode）或经时钟延迟调度（fake） */
  sendQueuedTurn?: (text: string) => void;
}

/** handleDeath 注入项：退出码/原因与审批残留收口（claude/opencode 发 approval_expired 事件、codex 回 wire cancel） */
export interface DeathHooks<TApproval extends KernelApproval = KernelApproval> {
  exitCode: number;
  reason: string;
  /** 逐条审批残留收口（在 session_exit 事件之前调用） */
  onApprovalResidue?: (entry: TApproval) => void;
}

/** 回合内核：无自有会话登记——状态内嵌在消费方 SessionState，内核只提供单源操作 */
export class TurnKernel<TApproval extends KernelApproval = KernelApproval> {
  constructor(private readonly options: TurnKernelOptions) {}

  /** ChatEvent 唯一出口：seq 单调分配 + 写日志 + 广播；at 可显式指定（claude/opencode 原生历史回填的 transcript 时间戳） */
  emit(s: TurnState<TApproval>, seed: ChatEventSeed, at?: string): void {
    s.seq += 1;
    const now = this.options.nowMs ? this.options.nowMs() : Date.now();
    const full = { ...seed, sessionId: s.sessionId, seq: s.seq, at: at ?? new Date(now).toISOString() } as ChatEvent;
    s.log.push(full);
    this.options.broadcast(full);
  }

  /** 忙态判定：turn 进行中或存在待决审批（不变量 6 排队依据，单源） */
  isBusy(s: TurnState<TApproval>): boolean {
    return s.turnActive || s.pendingApprovals.size > 0;
  }

  /** 忙态则入队返回 true（FIFO），空闲返回 false 由调用方直接开 turn */
  enqueueIfBusy(s: TurnState<TApproval>, text: string): boolean {
    if (!this.isBusy(s)) return false;
    s.queue.push(text);
    return true;
  }

  /** 回合开启：turnActive 置位 + 中断闸门复位（adapter 随后发各自 wire 与 turn_started 事件） */
  beginTurn(s: TurnState<TApproval>): void {
    s.turnActive = true;
    s.interruptRequested = false;
  }

  /** 幂等中断闸门：无活动 turn 或已请求过 → false（no-op）；首次请求 → 置位并返回 true，wire 中断由调用方执行 */
  requestInterrupt(s: TurnState<TApproval>): boolean {
    if (!s.turnActive && s.pendingApprovals.size === 0) return false;
    if (s.interruptRequested) return false;
    s.interruptRequested = true;
    return true;
  }

  /**
   * turn 终态统一收尾（单源）：状态复位 → 残留收口回调 → 审批 map 清空 →
   * interrupted/failed 丢弃排队（明确报错/中断不重放，spec H）、completed 发 turn_completed 并续发队首。
   * 终态事件序固定：interrupted = [turn_interrupted, session_status interrupted]；failed = [session_status idle]；completed = [turn_completed, session_status idle]。
   */
  finishTurn(s: TurnState<TApproval>, status: TurnTerminalStatus, hooks?: FinishTurnHooks<TApproval>): void {
    s.turnActive = false;
    s.interruptRequested = false;
    hooks?.onResidue?.(s, status);
    s.pendingApprovals.clear();
    if (status === "interrupted") {
      s.queue.length = 0;
      this.emit(s, { type: "turn_interrupted", reason: "user" });
      this.emit(s, { type: "session_status", status: "interrupted" });
      return;
    }
    if (status === "failed") {
      s.queue.length = 0; // 明确报错不重放（spec H）
      this.emit(s, { type: "session_status", status: "idle" });
      return;
    }
    this.emit(s, { type: "turn_completed" });
    this.emit(s, { type: "session_status", status: "idle" });
    const next = s.queue.shift();
    if (next !== undefined) hooks?.sendQueuedTurn?.(next);
  }

  /** 进程/连接死亡收尾（单源）：丢弃排队、复位回合态、逐条审批残留收口、[session_exit, session_status disconnected]；会话状态保留供 resume */
  handleDeath(s: TurnState<TApproval>, death: DeathHooks<TApproval>): void {
    s.queue.length = 0;
    s.turnActive = false;
    s.interruptRequested = false;
    for (const entry of s.pendingApprovals.values()) death.onApprovalResidue?.(entry);
    s.pendingApprovals.clear();
    this.emit(s, { type: "session_exit", exitCode: death.exitCode, reason: death.reason });
    this.emit(s, { type: "session_status", status: "disconnected" });
  }

  /** resume（进程内存活/复位）路径的活动残留清理：回合态、排队与中断闸门一并复位（emit idle 由调用方决定） */
  resetForResume(s: TurnState<TApproval>): void {
    s.turnActive = false;
    s.queue.length = 0;
    s.interruptRequested = false;
  }
}

/** 会话登记表查证：不存在抛 E_SESSION_NOT_FOUND（错误码形状单源，不变量 6） */
export function requireSessionEntry<T>(sessions: Map<string, T>, sessionId: string): T {
  const s = sessions.get(sessionId);
  if (!s) throw new AdapterError("E_SESSION_NOT_FOUND", `会话不存在：${sessionId}`);
  return s;
}

/** 活性查证：不存在 → E_SESSION_NOT_FOUND；isDead 命中 → E_INTERNAL（deadLabel 形如「Claude 进程已退出」，错误文案单源） */
export function requireLiveSessionEntry<T>(sessions: Map<string, T>, sessionId: string, isDead: (s: T) => boolean, deadLabel: string): T {
  const s = requireSessionEntry(sessions, sessionId);
  if (isDead(s)) {
    throw new AdapterError("E_INTERNAL", `${deadLabel}，会话已断开（请读取原生历史恢复或新建会话）`);
  }
  return s;
}

/** 受控终止等待真实退出的兜底上限（缺省值；构造参数可注入缩小，使超时分支可密封直测） */
export const DEFAULT_STOP_TIMEOUT_MS = 3000;

/** 可受控终止的客户端面（claude 流进程 / codex app-server / opencode server 客户端同构） */
export interface StoppableClient {
  onDead(fn: (err: Error) => void): unknown;
  stop(): void;
}

/** 受控终止并等待实际退出（≤timeoutMs 兜底）：正常路径 onDead 先到即返回；进程僵死时超时兜底放行，保证调用方（dispose/release/shutdown）不挂 */
export async function stopAndAwaitExit(client: StoppableClient, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    client.onDead(() => {
      clearTimeout(timer);
      resolve();
    });
    client.stop();
  });
}
