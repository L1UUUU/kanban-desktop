// 用途：会话生命周期唯一编排写者（issue #70 C2，spec #57 D 节）—— 归档/取消归档/删除三编排自 ipc.ts、PTY 终端事件落库自 index.ts sink、启动收养编排自 shutdown.ts 收敛于此，进程能力经 SessionProcesses seam 注入（生产 = adapter/PTY 宿主分派，测试 = fake）；session-store 保持纯数据面（status 流转决策全在此，落库经 store）；arch C11 起 seam 扩全量形态 disposeAll/killAll（退出序列 shutdown 亦经此分派，「structured→adapter / pty→宿主」分派知识单点在此）
import type { AdoptSessionInput, CliAdapter } from "@kanban/cli-host";
import type { LogFn } from "./logger";
import type { PtyHost } from "./pty-host";
import type { SessionStore } from "./session-store";

/** 进程能力 seam：结构化会话中断/受控终止/收养登记与 PTY 终止（两个 adapter——生产分派与测试 fake，真 seam） */
export interface SessionProcesses {
  /** 中断当前 turn（幂等，无活动 turn 自然 no-op） */
  interrupt(sessionId: string): Promise<void>;
  /** 受控终止单会话（结构化 = adapter.dispose 单会话形态；PTY = 宿主终端终止） */
  terminate(rec: { id: string; kind: "structured" | "pty" }): Promise<void>;
  /** 重新登记可恢复句柄；CLI 不支持收养时 reject（错误消息直达调用方，由 ipc 层既有 catch 映射错误形状） */
  adopt(input: AdoptSessionInput): Promise<void>;
  /** 全量受控终止（arch C11，退出序列第 5 步）：结构化全量 dispose（worker 停新→dispose 全部→有限等待→kill 兜底 / 进程内 router dispose） */
  disposeAll(): Promise<void>;
  /** 全量硬停（arch C11，退出序列第 6 步）：PTY 宿主全停（幂等；Job Object 覆盖任何残留兜底） */
  killAll(): void;
}

/** 生产 SessionProcesses 装配（index.ts 装配现场与测试夹具共用同一分派）：structured → adapter.interruptTurn/dispose/adoptSession；pty → 宿主 kill（lifecycle 仅对 structured 调 adopt，pty 无进程恢复能力）；arch C11 起全量形态 disposeAll/killAll 承载退出序列（lifecycle 编排不消费） */
export function createAdapterSessionProcesses(adapter: CliAdapter, pty: Pick<PtyHost, "kill" | "killAll">): SessionProcesses {
  return {
    interrupt: (sessionId) => adapter.interruptTurn(sessionId),
    terminate: (rec) => (rec.kind === "pty" ? Promise.resolve(pty.kill(rec.id)) : adapter.dispose({ sessionId: rec.id })),
    adopt: (input) =>
      adapter.adoptSession
        ? adapter.adoptSession(input)
        : Promise.reject(new Error(`当前 CLI 不支持会话收养，无法取消归档：${input.cli ?? ""}`)),
    disposeAll: () => adapter.dispose(),
    killAll: () => pty.killAll(),
  };
}

export interface SessionLifecycleDeps {
  sessions: SessionStore;
  procs: SessionProcesses;
  /** 时钟注入（测试固定时刻；缺省当前时刻，归档/取消归档时间戳与活跃时间共用） */
  now?(): string;
  /** 诊断日志（与 ipc/adapter-events 同 LogFn 形状：best-effort 放行记 warn，收养失败记 info） */
  log?: LogFn;
}

export interface SessionLifecycle {
  /** 单会话归档（#58/#64：中断 → 受控终止 → 写标记；未知/已归档 no-op 幂等；中断/终止失败 best-effort 放行） */
  archive(id: string): Promise<{ outcome: "archived" | "noop" }>;
  /** 取消归档（#58：structured 先 adopt 登记成功才清标记刷新活跃时间，失败原地抛错留归档态可重试；PTY 仅清标记回 disconnected；未归档 no-op） */
  unarchive(id: string): Promise<{ outcome: "restored" | "noop" }>;
  /** 删除（#62：解关联 hook 抛错即中止（行保留可重试）→ 终止进程（best-effort 放行）→ 删行记墓碑；无行 no-op 幂等） */
  remove(id: string, hooks?: { beforeDelete?(): Promise<void> }): Promise<void>;
  /** PTY 终端事件唯一写入口（#58/#62）：started → idle / exit → disconnected + 活跃时间；data/error 只吃迟到判定零写入；
   *  返回 false = 迟到事件（已归档/已删除终端），调用方不得写库不得转发 renderer */
  onTerminalEvent(terminalId: string, ev: "started" | "data" | "exit" | "error"): boolean;
  /** 启动恢复编排（spec H/#13，#14 修正，#70 自 shutdown.ts 迁入）：DB 全部未归档结构化会话统一收养登记 disconnected
   *  （readHistory/resume 可续）；收养失败与无 adoptSession 能力的 CLI、以及全部 PTY 会话落库 disconnected；已归档行跳过（防重复登记） */
  adoptRestored(): Promise<void>;
}

/** 编排内 best-effort 步骤：失败只记 warn 不阻断（进程已死等不应挡住归档/删除）——自 ipc.ts 随迁，日志 scope/文案逐字不变 */
async function bestEffort(fn: () => Promise<void>, deps: { log?: LogFn }, context: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    deps.log?.("warn", "kanban:ipc", `${context}：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 构造会话生命周期唯一写者（ipc 路由壳 / 自动归档引擎 / PTY 事件泵共用同一实例） */
export function createSessionLifecycle(deps: SessionLifecycleDeps): SessionLifecycle {
  const now = (): string => deps.now?.() ?? new Date().toISOString();
  return {
    async archive(id): Promise<{ outcome: "archived" | "noop" }> {
      const rec = deps.sessions.get(id);
      if (!rec || rec.archivedAt != null) return { outcome: "noop" }; // 幂等：未知/已归档不重复编排
      if (rec.kind === "pty") await deps.procs.terminate(rec);
      else {
        await bestEffort(() => deps.procs.interrupt(rec.id), deps, `归档前中断失败（放行）：${rec.id}`);
        await bestEffort(() => deps.procs.terminate(rec), deps, `归档终止失败（放行）：${rec.id}`);
      }
      deps.sessions.archive(rec.id, now());
      return { outcome: "archived" };
    },

    async unarchive(id): Promise<{ outcome: "restored" | "noop" }> {
      const rec = deps.sessions.get(id);
      if (rec == null || rec.archivedAt == null) return { outcome: "noop" }; // 未归档 no-op（不写活跃时间）
      // 结构化先重新登记可恢复句柄：adopt 抛错（含 CLI 不支持）原地传播——留在归档态由 ipc 层报错，可重试
      if (rec.kind === "structured") {
        await deps.procs.adopt({
          sessionId: rec.id,
          nativeSessionId: rec.nativeSessionId ?? "",
          cwd: rec.cwd ?? "",
          permMode: rec.permMode ?? undefined,
          cli: rec.cli,
        });
      }
      deps.sessions.unarchive(rec.id, now());
      return { outcome: "restored" };
    },

    async remove(id, hooks): Promise<void> {
      const rec = deps.sessions.get(id);
      if (!rec) return; // 幂等：记录不存在（重复删除/从未存在）直接成功
      // 解关联（引擎落 unlink 事件）经 hook 注入——lifecycle 不依赖 tracker；hook 抛错即中止：行保留、进程未终止
      if (hooks?.beforeDelete) await hooks.beforeDelete();
      if (rec.kind === "pty") await deps.procs.terminate(rec);
      else {
        await bestEffort(() => deps.procs.interrupt(rec.id), deps, `删除前中断失败（放行）：${rec.id}`);
        await bestEffort(() => deps.procs.terminate(rec), deps, `删除终止失败（放行）：${rec.id}`);
      }
      deps.sessions.delete(rec.id);
    },

    onTerminalEvent(terminalId, ev): boolean {
      // 迟到守卫（#58/#62，spec #57 D 节）：已归档/已删除终端的事件不写库不转发（判定单点 = store 数据事实）
      if (deps.sessions.shouldDropEvents(terminalId)) return false;
      // PTY 活 = 空闲徽标（idle）、退出 = 已断开徽标（disconnected）并刷新活跃时间；data/error 不写库
      if (ev === "started") deps.sessions.updateStatus(terminalId, "idle");
      else if (ev === "exit") {
        deps.sessions.updateStatus(terminalId, "disconnected");
        deps.sessions.touch(terminalId, now());
      }
      return true;
    },

    async adoptRestored(): Promise<void> {
      // #58：启动收养走全量查询但跳过已归档行——各 adapter 对重复 adopt 报「会话已存在」，
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
          await deps.procs.adopt(input);
          // 收养成功：session_status disconnected 经事件流落库；此处兜底直写（事件到达前 renderer 拉列表也拿到终态）
          deps.sessions.updateStatus(r.id, "disconnected");
        } catch (e) {
          // 收养失败（含 CLI 不支持收养，procs.adopt reject）与其余会话互不影响：落库断开，逐条留痕
          deps.log?.("info", "lifecycle", `会话收养失败（落库断开）：${r.id} ${e instanceof Error ? e.message : String(e)}`);
          deps.sessions.updateStatus(r.id, "disconnected");
        }
      }
      // PTY 会话：进程已随上次退出终止（before-quit killAll），统一断开态
      // #58：全量遍历（含已归档行）——updateStatus 的未归档守卫使归档行为自然 no-op，不改动其落库状态
      for (const r of deps.sessions.listAll()) {
        if (r.kind === "pty" && r.status !== "disconnected") deps.sessions.updateStatus(r.id, "disconnected");
      }
    },
  };
}
