// 用途：main 侧统一退出序列编排（spec H §6.1 全表/#13）—— 停新请求→有序取消→有限等待→Session 粒度受控终止→全量 dispose→PTY 停止；纯依赖注入可单测（#70 C2 起启动收养编排迁至 session-lifecycle.adoptRestored，本模块退出序列只读 status 不写；arch C11 起忙态/存活判定单点 session-store 谓词、进程终止全经 SessionProcesses seam——「structured→adapter / pty→宿主」分派知识单点在 session-lifecycle，本模块不再直连 adapter/PTY 宿主）
import type { LogKind } from "@kanban/ipc-schema";
import type { SessionProcesses } from "./session-lifecycle";
import { isSessionBusy, isStructuredProcessAlive, type SessionStore } from "./session-store";

export interface ShutdownDeps {
  /** 进程能力 seam（arch C11）：有序取消/单会话受控终止/全量 dispose/PTY 全停的分派单点（与 lifecycle 共用 createAdapterSessionProcesses 实例） */
  procs: SessionProcesses;
  sessions: SessionStore;
  /** 有限等待上限 ms（config.shutdown.graceMs，spec H；超时进入受控终止） */
  graceMs: number;
  /** 第 1 步 UI 提示（main 转发 renderer app:shutdown；窗口不在时丢弃） */
  notifyShutdown(reason: string): void;
  /** 等待能力注入（测试用 fake timers / 立即返回） */
  sleep(ms: number): Promise<void>;
  /** memory 提取停止（issue #32，spec #27 C 节）：running 批次 → cancelled；排在 adapter/PTY 之后、DB 关闭前 */
  memory?: { stop(): Promise<void> };
  /** 诊断日志 */
  log?(kind: LogKind, detail: string): void;
}

export interface ShutdownOrchestrator {
  /** 退出序列入口（幂等：并发/重复调用复用同一 Promise；失败不阻断退出） */
  begin(reason: string): Promise<void>;
  /** IPC 门闸：序列启动后为 true（handleIpc 拒绝新请求，spec H 第 1 步） */
  isShuttingDown(): boolean;
}

/**
 * 统一退出序列（spec H）：幂等 begin →
 * 1. gate=true（IPC 拒新）+ notifyShutdown（UI 提示）
 * 2. 各活跃会话 interruptTurn（并行、best-effort——请求有序取消，保留会话）
 * 3. 有限等待：轮询至全部离开 running/waiting 或 graceMs 超时
 * 4. 受控终止（Session 粒度 dispose；OpenCode 引用计数归零停 server、Codex 保留共享进程）
 * 5. 全量 dispose（CliHost worker shutdown + kill 兜底 / 进程内 router dispose）
 * 6. PTY 全停（killAll 幂等；Job Object 覆盖任何残留，t0-01 T1）
 */
export function createShutdownOrchestrator(deps: ShutdownDeps): ShutdownOrchestrator {
  let gate = false;
  let inflight: Promise<void> | null = null;

  const busySessions = () => deps.sessions.list().filter((r) => r.kind === "structured" && isSessionBusy(r.status));

  async function run(reason: string): Promise<void> {
    const startedAt = Date.now();
    // 1. 停止接收新请求 + UI 提示
    gate = true;
    deps.notifyShutdown(reason);
    // 2. 活跃会话有序取消（interrupt 幂等；best-effort：单个失败不影响其余）
    const busy = busySessions();
    if (busy.length > 0) deps.log?.("shutdown", `有序取消 ${busy.length} 个活跃会话`);
    await Promise.allSettled(busy.map((r) => deps.procs.interrupt(r.id)));
    // 3. 有限等待：turn_interrupted/session_status 事件落库驱动状态离开 running/waiting
    const deadline = Date.now() + deps.graceMs;
    while (busySessions().length > 0 && Date.now() < deadline) {
      await deps.sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    const settled = busySessions().length === 0;
    // 4. 受控终止（Session 粒度，结构化存活 = 状态非 disconnected）：逐会话 dispose；全量兜底在前者失败时仍达
    const live = deps.sessions.list().filter((r) => r.kind === "structured" && isStructuredProcessAlive(r.status));
    await Promise.allSettled(live.map((r) => deps.procs.terminate(r)));
    // 5. 全量 dispose（worker 内停新命令→dispose 全部→有限等待→kill；进程内同语义）
    await deps.procs.disposeAll();
    // 6. PTY 全停（幂等）
    deps.procs.killAll();
    // 7. memory 提取停止（issue #32，spec #27 C 节：running 批次 → cancelled；adapter/PTY 之后、DB 关闭前，
    //    DB 在 app quit 才关闭——本序列完成即 quit，时序上保证批次终态先落库）
    if (deps.memory) await deps.memory.stop();
    deps.log?.("shutdown", `退出序列完成：settled=${settled} sessions=${live.length} elapsed=${Date.now() - startedAt}ms`);
  }

  return {
    begin(reason: string): Promise<void> {
      if (!inflight) {
        inflight = run(reason).catch((e) => {
          // 退出路径不抛错：任何步骤失败记录后放行（Job Object 兜底保证无孤儿）
          deps.log?.("shutdown", `退出序列异常（放行退出，Job Object 兜底）：${e instanceof Error ? e.message : String(e)}`);
        });
      }
      return inflight;
    },
    isShuttingDown: () => gate,
  };
}
