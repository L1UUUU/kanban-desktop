// 用途：main 侧生命周期编排（spec H §6.1 全表/#13）—— 统一退出序列状态机（停新请求→有序取消→有限等待→Session 粒度受控终止→全量 dispose→PTY 停止）与重开恢复编排（启动收养 DB 断开会话）；纯依赖注入可单测
import type { LogKind } from "@kanban/ipc-schema";
import type { CliAdapter, AdoptSessionInput } from "@kanban/cli-host";
import type { SessionStore } from "./session-store";
import type { PtyHost } from "./pty-host";

export interface ShutdownDeps {
  adapter: CliAdapter;
  pty: PtyHost;
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

/** 活跃（须有序取消）判定：running=turn 进行中 / waiting=审批等待 */
function isBusy(status: string | null): boolean {
  return status === "running" || status === "waiting";
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

  const busySessions = () => deps.sessions.list().filter((r) => r.kind === "structured" && isBusy(r.status));

  async function run(reason: string): Promise<void> {
    const startedAt = Date.now();
    // 1. 停止接收新请求 + UI 提示
    gate = true;
    deps.notifyShutdown(reason);
    // 2. 活跃会话有序取消（interruptTurn 幂等；best-effort：单个失败不影响其余）
    const busy = busySessions();
    if (busy.length > 0) deps.log?.("shutdown", `有序取消 ${busy.length} 个活跃会话`);
    await Promise.allSettled(busy.map((r) => deps.adapter.interruptTurn(r.id)));
    // 3. 有限等待：turn_interrupted/session_status 事件落库驱动状态离开 running/waiting
    const deadline = Date.now() + deps.graceMs;
    while (busySessions().length > 0 && Date.now() < deadline) {
      await deps.sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    const settled = busySessions().length === 0;
    // 4. 受控终止（Session 粒度）：逐会话 dispose；全量兜底在前者失败时仍达
    const live = deps.sessions.list().filter((r) => r.kind === "structured" && r.status !== "disconnected");
    await Promise.allSettled(live.map((r) => deps.adapter.dispose({ sessionId: r.id })));
    // 5. 全量 dispose（worker 内停新命令→dispose 全部→有限等待→kill；进程内同语义）
    await deps.adapter.dispose();
    // 6. PTY 全停（幂等）
    deps.pty.killAll();
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

export interface RestoreDeps {
  adapter: CliAdapter;
  sessions: SessionStore;
  log?(kind: LogKind, detail: string): void;
}

/**
 * 重开恢复编排（spec H/#13，#14 修正）：启动时对 DB 中全部结构化会话统一收养
 * （adapter.adoptSession 登记断开，readHistory/resume 可续；事件流回 session_status disconnected 落库）。
 * 含上次已断开的会话——否则第二次重启后 adapter 无登记，「读取原生历史并恢复」必报会话不存在；
 * 收养失败与无 adoptSession 能力的 CLI、以及全部 PTY 会话（进程随上次退出终止）落库为 disconnected。
 */
export async function adoptRestoredSessions(deps: RestoreDeps): Promise<void> {
  // #58：退出收养走全量查询但跳过已归档行——各 adapter 对重复 adopt 报「会话已存在」，
  // 已归档会话留待取消归档时按需 adopt（session:unarchive），避免登记冲突
  const rows = deps.sessions.listAll().filter((r) => r.kind === "structured" && r.archivedAt == null);
  for (const r of rows) {
    const input: AdoptSessionInput = {
      sessionId: r.id,
      nativeSessionId: r.nativeSessionId ?? "",
      cwd: r.cwd ?? "",
      permMode: r.permMode ?? undefined,
      cli: r.cli,
    };
    try {
      if (!deps.adapter.adoptSession) throw new Error("adapter 不支持会话收养");
      await deps.adapter.adoptSession(input);
      // 收养成功：session_status disconnected 经事件流落库；此处兜底直写（事件到达前 renderer 拉列表也拿到终态）
      deps.sessions.updateStatus(r.id, "disconnected");
    } catch (e) {
      deps.log?.("restore", `会话收养失败（落库断开）：${r.id} ${e instanceof Error ? e.message : String(e)}`);
      deps.sessions.updateStatus(r.id, "disconnected");
    }
  }
  // PTY 会话：进程已随上次退出终止（before-quit killAll），统一断开态
  // #58：全量遍历（含已归档行）——updateStatus 的未归档守卫使归档行为自然 no-op，不改动其落库状态
  for (const r of deps.sessions.listAll()) {
    if (r.kind === "pty" && r.status !== "disconnected") deps.sessions.updateStatus(r.id, "disconnected");
  }
}
