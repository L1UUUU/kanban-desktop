// 用途：会话生命周期唯一编排写者（issue #70 C2，spec #57 D 节）—— 归档/取消归档/删除三编排自 ipc.ts、PTY 终端事件落库自 index.ts sink、启动收养编排自 shutdown.ts 收敛于此，进程能力经 SessionProcesses seam 注入（生产 = adapter/PTY 宿主分派，测试 = fake）；session-store 保持纯数据面（status 流转决策全在此，落库经 store）；arch C11 起 seam 扩全量形态 disposeAll/killAll（退出序列 shutdown 亦经此分派，「structured→adapter / pty→宿主」分派知识单点在此）；arch C12 起 create 侧编排收进（session:create/terminal:create 的「原生创建/占位落库/标题派生/首条消息/失败回滚」自 ipc 路由表迁入，insert/delete 生产写路径唯一经此——失败回滚与 remove 走同一「终止+删行」尾部，create/cancelCreate 对偶）
import { AdapterError, type AdoptSessionInput, type CliAdapter, type CreateSessionInput, type SendTurnInput } from "@kanban/cli-host";
import { defaultSessionTitle, type CliKind, type ErrorCode, type PermMode, type TerminalCommand } from "@kanban/ipc-schema";
import type { LogFn } from "./logger";
import type { PtyHost, SpawnRequest, SpawnResult } from "./pty-host";
import type { SessionStore } from "./session-store";
import { deriveTitle } from "./title-derive";

/** 进程能力 seam：结构化会话创建/首条发送/中断/受控终止/收养登记与 PTY 启动/写入/终止（两个 adapter——生产分派与测试 fake，真 seam）；arch D2 起 create/adopt 的 cli 为 main 域字段（经 adapter.forCli(cli) 句柄进入目录级命令，adapter 单实现 input 不含 cli） */
export interface SessionProcesses {
  /** 创建结构化原生会话（arch C12，生产 = adapter.forCli(cli).createSession；失败如 CLI 不存在 reject 原样上抛，由 ipc 层既有 catch 映射错误形状） */
  createSession(input: CreateSessionInput & { cli: string }): Promise<{ sessionId: string; nativeSessionId?: string | null; model?: string | null }>;
  /** 发送 user 消息（arch C12，首条消息原子化用；生产 = adapter.sendTurn，只表达已提交、内容一律经事件流） */
  sendTurn(input: SendTurnInput): Promise<void>;
  /** 中断当前 turn（幂等，无活动 turn 自然 no-op） */
  interrupt(sessionId: string): Promise<void>;
  /** 受控终止单会话（结构化 = adapter.dispose 单会话形态；PTY = 宿主终端终止） */
  terminate(rec: { id: string; kind: "structured" | "pty" }): Promise<void>;
  /** 重新登记可恢复句柄；CLI 不支持收养时 reject（错误消息直达调用方，由 ipc 层既有 catch 映射错误形状） */
  adopt(input: AdoptSessionInput & { cli: string }): Promise<void>;
  /** 启动 PTY 终端（arch C12，生产 = 宿主 spawn：同 id 在跑先停旧的；失败经返回值上报不抛） */
  spawnTerminal(terminalId: string, req: SpawnRequest): SpawnResult;
  /** 写入 PTY 终端（arch C12，草稿首输入重放用；生产 = 宿主 write，未运行返回 ok:false） */
  writeTerminal(terminalId: string, data: string): { ok: true } | { ok: false; message: string };
  /** 全量受控终止（arch C11，退出序列第 5 步）：结构化全量 dispose（worker 停新→dispose 全部→有限等待→kill 兜底 / 进程内 router dispose） */
  disposeAll(): Promise<void>;
  /** 全量硬停（arch C11，退出序列第 6 步）：PTY 宿主全停（幂等；Job Object 覆盖任何残留兜底） */
  killAll(): void;
}

/** 生产 SessionProcesses 装配（index.ts 装配现场与测试夹具共用同一分派）：structured → adapter.forCli(cli) 目录句柄 createSession/adoptSession + sendTurn/interruptTurn/dispose；pty → 宿主 spawn/write/kill（lifecycle 仅对 structured 调 adopt，pty 无进程恢复能力）；arch C11 起全量形态 disposeAll/killAll 承载退出序列（lifecycle 编排不消费） */
export function createAdapterSessionProcesses(
  adapter: CliAdapter,
  pty: Pick<PtyHost, "spawn" | "write" | "kill" | "killAll">,
): SessionProcesses {
  return {
    createSession: (input) => {
      const { cli, ...init } = input;
      return adapter.forCli(cli).createSession(init);
    },
    sendTurn: (input) => adapter.sendTurn(input),
    interrupt: (sessionId) => adapter.interruptTurn(sessionId),
    terminate: (rec) => (rec.kind === "pty" ? Promise.resolve(pty.kill(rec.id)) : adapter.dispose({ sessionId: rec.id })),
    adopt: (input) => {
      const { cli, ...rest } = input;
      const dir = adapter.forCli(cli);
      // arch C13：缺席判定单源 = 能力面 adoptSession（方法存在性仅作 TS 收窄保险）；降级行为不变——同错误消息 reject，由 ipc 层既有 catch 映射错误形状
      return adapter.capabilities.adoptSession && dir.adoptSession
        ? dir.adoptSession(rest)
        : Promise.reject(new Error(`当前 CLI 不支持会话收养，无法取消归档：${cli}`));
    },
    spawnTerminal: (terminalId, req) => pty.spawn(terminalId, req),
    writeTerminal: (terminalId, data) => pty.write(terminalId, data),
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

/** createStructuredSession 输入（arch C12，session:create 请求的业务面直传：CLI/cwd/项目挂靠/显式草稿名/模型/权限档/首条消息） */
export interface CreateStructuredSessionInput {
  cli: CliKind;
  cwd: string;
  /** 挂靠项目（缺省 = 无项目演示会话） */
  projectId?: string;
  /** renderer 显式草稿名（boot 演示），非用户意图命名——首条消息派生标题优先（ADR 0003 决策 2） */
  title?: string;
  model?: string;
  permMode?: PermMode;
  /** #59（spec #57）：草稿首条消息 —— 创建+发送原子化，发送失败回滚整行 */
  firstMessage?: string;
}

/** createStructuredSession 结果：成功 = 会话 id + 落库标题 + adapter 实际采用 model（可空，响应组装配省略）；
 *  失败 = 回滚已完成（错误形状与既有 IPC 契约逐字一致，rolledBackSessionId 供 renderer 撤销事件先至的占位行） */
export type CreateStructuredSessionResult =
  | { ok: true; sessionId: string; title: string; model?: string | null }
  | { ok: false; error: { code: ErrorCode; message: string; rolledBackSessionId: string } };

/** createTerminalSession 输入（arch C12，terminal:create 请求的业务面直传：渲染端预生成 terminalId 与 PTY 启动参数/草稿名/首输入） */
export interface CreateTerminalSessionInput {
  terminalId: string;
  cwd: string;
  projectId?: string;
  title?: string;
  cols?: number;
  rows?: number;
  command?: TerminalCommand;
  /** #60 草稿首输入：spawn 成功后重放（中文/多字符不丢失） */
  firstInput?: string;
}

/** createTerminalSession 结果：成功 = 终端 id + 回写后标题（「终端 · shell」或显式草稿名）；失败 = id 冲突（既有行未动）或 spawn 失败（占位行已回滚） */
export type CreateTerminalSessionResult =
  | { ok: true; sessionId: string; title: string }
  | { ok: false; error: { code: "E_SESSION_EXISTS" | "E_INTERNAL"; message: string } };

export interface SessionLifecycle {
  /** arch C12：结构化会话创建编排（#59/#94/ADR 0003 决策 2）：原生创建（失败原样上抛——无落库无回滚，信封层映射错误形状）→
   *  标题随行原子派生落库（首条纯空白回退默认标题）→ firstMessage 原子发送 → 发送失败经与 remove 同一「终止+删行」尾部回滚
   *  （不留空会话，也不留「来自未发出消息」的标题——回滚整行删除天然一致） */
  createStructuredSession(input: CreateStructuredSessionInput): Promise<CreateStructuredSessionResult>;
  /** arch C12：PTY 终端创建编排（#60）：id 冲突守卫（单一 id 空间，不启动进程）→ 占位落库 → spawn → 失败经「终止+删行」尾部回滚
   *  → 标题回写「终端 · shell」→ 草稿首输入重放；PTY 永不进标题状态机（ADR 0003 豁免，titleSource 恒 default） */
  createTerminalSession(input: CreateTerminalSessionInput): Promise<CreateTerminalSessionResult>;
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

/** 「终止 + 删行」单点尾部（arch C12）：remove 与 create 失败回滚共用（create/cancelCreate 对偶）——
 *  受控终止 best-effort 放行（failContext 记 warn：进程已死等不应挡删行；宿主 kill 自吞错幂等，无进程自然 no-op）→ 删行记墓碑 */
async function terminateAndDelete(deps: SessionLifecycleDeps, rec: { id: string; kind: "structured" | "pty" }, failContext: string): Promise<void> {
  await bestEffort(() => deps.procs.terminate(rec), deps, `${failContext}（放行）：${rec.id}`);
  deps.sessions.delete(rec.id);
}

/** 构造会话生命周期唯一写者（ipc 路由壳 / 自动归档引擎 / PTY 事件泵共用同一实例） */
export function createSessionLifecycle(deps: SessionLifecycleDeps): SessionLifecycle {
  const now = (): string => deps.now?.() ?? new Date().toISOString();
  return {
    async createStructuredSession(input): Promise<CreateStructuredSessionResult> {
      // 原生创建失败（CLI 不存在等）原样上抛：尚未落库无回滚可做（与既有 handler 直调 adapter.createSession 的错误面一致）
      const { sessionId, nativeSessionId, model } = await deps.procs.createSession({
        cwd: input.cwd,
        model: input.model,
        permMode: input.permMode,
        cli: input.cli,
      });
      // #94 / ADR 0003 决策 2：firstMessage 携带时 insert 前派生（标题随行原子落库，发送失败回滚整行天然一致；
      // 新建行恒 kind='structured' 且 source='default'，派生条件天然满足；请求显式 title 仅为 renderer 显式草稿名，
      // 非用户意图命名，派生优先提供可辨识性；默认占位名经 defaultSessionTitle 单源构造（arch C8）；
      // 派生为空（纯空白消息）回退默认标题，不落空标题）
      let title = input.title ?? defaultSessionTitle(input.cli);
      let titleSource: "default" | "derived" = "default";
      if (input.firstMessage !== undefined) {
        const derived = deriveTitle(input.firstMessage);
        if (derived) {
          title = derived;
          titleSource = "derived";
        }
      }
      // 会话落库（重启恢复依据；真实 Adapter 返回 native id 一并回填，Fake 无 native id 为 null；status 缺省 idle——新建恒 idle 决策在 store，#70）
      deps.sessions.insert({
        id: sessionId,
        kind: "structured",
        cli: input.cli,
        nativeSessionId: nativeSessionId ?? null,
        projectId: input.projectId ?? null,
        title,
        titleSource,
        cwd: input.cwd,
        permMode: input.permMode ?? "auto",
        lastActiveAt: null,
        archivedAt: null,
      });
      // #59（spec #57）：草稿首条消息 —— 创建+发送原子化：发送失败经与 remove 同一「终止+删行」尾部回滚（不留空会话），错误直达调用方；
      // 终止语义 = 仅受控终止（dispose），不 interrupt——首条 turn 提交即失败，无活动 turn 可中断
      if (input.firstMessage !== undefined) {
        try {
          await deps.procs.sendTurn({ sessionId, text: input.firstMessage });
        } catch (err) {
          const code = err instanceof AdapterError ? err.code : "E_INTERNAL";
          const message = err instanceof Error ? err.message : String(err);
          await terminateAndDelete(deps, { id: sessionId, kind: "structured" }, "首条消息发送失败后的受控终止未成功");
          deps.log?.("error", "lifecycle", `首条消息发送失败，已回滚会话记录（${code}）：${message}`);
          // 附带回滚会话 id：渲染端撤销事件先至的占位会话行（不留空会话的渲染端闭环）
          return { ok: false, error: { code, message, rolledBackSessionId: sessionId } };
        }
      }
      return { ok: true, sessionId, title, model };
    },

    async createTerminalSession(input): Promise<CreateTerminalSessionResult> {
      // #60：terminalId 渲染端预生成（uuid 格式入站已校验）；与既有会话行同 id 空间冲突即拒（不启动进程不覆盖既有行）
      if (deps.sessions.get(input.terminalId)) {
        return { ok: false, error: { code: "E_SESSION_EXISTS", message: `终端 id 已存在：${input.terminalId}（会话 id 空间冲突）` } };
      }
      // 先落库占位（占位标题在 spawn 成功后回写为「终端 · shell」；status 缺省 idle——「新建恒 idle」决策在 store，#70；
      // titleSource 缺省 default——PTY 永不进标题状态机，ADR 0003 豁免）
      const placeholderTitle = input.title ?? "终端";
      deps.sessions.insert({
        id: input.terminalId,
        kind: "pty",
        cli: "pty",
        nativeSessionId: null,
        projectId: input.projectId ?? null,
        title: placeholderTitle,
        cwd: input.cwd,
        permMode: null,
        lastActiveAt: null,
        archivedAt: null,
      });
      const spawned = deps.procs.spawnTerminal(input.terminalId, {
        cwd: input.cwd,
        cols: input.cols ?? 80,
        rows: input.rows ?? 30,
        command: input.command,
      });
      if (!spawned.ok) {
        // 启动失败经「终止+删行」尾部回滚占位行（默认列表与重启均无该会话；宿主 kill 幂等——spawn 失败无进程自然 no-op）
        await terminateAndDelete(deps, { id: input.terminalId, kind: "pty" }, "PTY 启动失败后的终止");
        return { ok: false, error: { code: "E_INTERNAL", message: spawned.message } };
      }
      // #60：spawn 成功后回写标题（显式草稿名原样保留——与占位名相同则不写）；PTY 回写走无条件 updateTitle（豁免状态机）
      const title = input.title ?? `终端 · ${spawned.label}`;
      if (title !== placeholderTitle) deps.sessions.updateTitle(input.terminalId, title);
      // 草稿首输入重放（含多字符/中文，首输入不丢失；失败路径已提前 return 不会写进未启动的终端）
      if (input.firstInput) deps.procs.writeTerminal(input.terminalId, input.firstInput);
      return { ok: true, sessionId: input.terminalId, title };
    },

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
      // 解关联（引擎落 unlink 事件）经 hook 注入——lifecycle 不依赖 tracker；hook 抛错即中止：行保留、进程未终止；
      // 结构化先 best-effort 中断（可能有活动 turn），随后与 create 失败回滚共用「终止+删行」尾部
      if (hooks?.beforeDelete) await hooks.beforeDelete();
      if (rec.kind === "structured") {
        await bestEffort(() => deps.procs.interrupt(rec.id), deps, `删除前中断失败（放行）：${rec.id}`);
      }
      await terminateAndDelete(deps, rec, "删除终止失败");
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
        const input: AdoptSessionInput & { cli: string } = {
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
