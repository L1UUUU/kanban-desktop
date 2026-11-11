// 用途：Main 入站 IPC 路由 —— 单通道 kanban:ipc 强制 zod 校验 + 分发到 CliAdapter 与 projects/sessions store + PTY 宿主（纯函数无 Electron 依赖：dialog 与 config 经 deps 注入）
// 行数评估（~660 行，超 500 行阈值）：app:getInfo + 五个 :ipc 通道（kanban/memory/diff/residue/config）的 handler 聚合是既有装配模式（共享单通道校验、deps 注入与 store 装配，拆开只搬文件不减耦合），本次不拆；触发条件：第六个 IPC 通道（或任一通道 handler 独立逻辑显著膨胀）加入时按通道拆分为独立模块。
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  configRequestSchema,
  diffRequestSchema,
  ipcRequestSchema,
  memoryRequestSchema,
  residueRequestSchema,
  type ConfigResult,
  type DiffResult,
  type IpcRequest,
  type IpcResult,
  type MemoryResult,
  type ResidueProcess,
  type ResidueResult,
  type ResidueKillResult,
  type SessionRow,
} from "@kanban/ipc-schema";
import { AdapterError, detectSkillConflicts, resolveUserClaudeDir, type CliAdapter } from "@kanban/cli-host";
import { TrackerEngine, formatRequirementId, type Cli, type NormalizedEvent, type TrackerChange } from "@kanban/tracker";
import type { AppConfig } from "./config";
import { detectDirIdentity } from "./git-identity";
import type { WorkspaceDiff } from "./git-diff-service";
import type { LogFn } from "./logger";
import { type MemoryService } from "./memory-service";
import type { PtyHost } from "./pty-host";
import type { ProjectStore } from "./project-store";
import type { SessionStore } from "./session-store";

/** 路由依赖：adapter + PTY 宿主 + 持久化 store + 平台能力（Electron dialog/config 由 index.ts 注入，测试可替换） */
export interface IpcDeps {
  adapter: CliAdapter;
  /** PTY 终端宿主（terminal:* 通道；mock 注入可单测） */
  pty: PtyHost;
  projects: ProjectStore;
  sessions: SessionStore;
  /** #17：kanban:* 通道与 session:create+requirementId 全量经 engine 落事件流（事件溯源唯一状态变化路径，spec #15 C 节） */
  engine: TrackerEngine;
  /** #17：tracker 变更推送（index.ts 接 webContents.send("tracker:event")；可选，缺省丢弃供不需要推送的测试） */
  emitTrackerChange?(change: TrackerChange): void;
  /** 原生目录选择（用户取消返回 null） */
  pickDirectory(): Promise<string | null>;
  getCurrentProjectId(): string | null;
  setCurrentProjectId(id: string): void;
  /** 退出序列门闸（true=正在退出，拒绝新请求，spec H 第 1 步；缺省恒 false 供旧测试） */
  isShuttingDown?(): boolean;
  /** #21（spec #15 E 节）：用户级 Claude 基准目录解析（CLAUDE_CONFIG_DIR 优先，否则 ~/.claude）；仅 session:create cli=claude 的同名 skill 检测用。缺省读 process.env + os.homedir，测试注入固定目录 */
  resolveUserClaudeDir?(): string;
  /** #35（spec #27 J 节）：memory 面（kanban:delete 需求删除级联清理）；index.ts 经 openMemoryService 装配注入，缺省无 memory 数据可清理（旧测试/降级装配） */
  memory?: MemoryService;
  /** #53（spec #52 G 节）：诊断日志 —— safeParse 失败与 route 抛错记 error（error.code 原样）；业务拒绝 ok:false 不记；缺省 no-op 供既有装配夹具 */
  log?: LogFn;
}

// CLI 显示名（新建会话默认标题「新会话 · {名}」，原型 §3.6）
const CLI_LABELS: Record<string, string> = {
  fake: "Fake",
  codex: "Codex",
  claude: "Claude",
  opencode: "OpenCode",
};

/** 处理一条入站请求：校验 → 退出门闸 → 路由 → 错误码形状化（spec E：Main 强制校验，非法消息明确错误码；spec H：退出中拒新请求） */
export async function handleIpc(deps: IpcDeps, raw: unknown): Promise<IpcResult> {
  const parsed = ipcRequestSchema.safeParse(raw);
  if (!parsed.success) {
    deps.log?.("error", "kanban:ipc", `入站请求不符合契约（E_SCHEMA）：${summarizeIssues(parsed.error.issues)}`);
    return {
      ok: false,
      error: { code: "E_SCHEMA", message: summarizeIssues(parsed.error.issues) },
    };
  }
  if (deps.isShuttingDown?.()) {
    return {
      ok: false,
      error: { code: "E_INTERNAL", message: "应用正在退出，已停止接收新请求" },
    };
  }
  try {
    return await route(deps, parsed.data);
  } catch (err) {
    // #53：catch 记一条 error（error.code 原样不造新码）；AdapterError 透传 / 其余 E_INTERNAL 的既有形状不变
    const code = err instanceof AdapterError ? err.code : "E_INTERNAL";
    deps.log?.("error", "kanban:ipc", `处理异常（${code}）：${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof AdapterError) {
      return { ok: false, error: { code: err.code, message: err.message } };
    }
    return {
      ok: false,
      error: { code: "E_INTERNAL", message: err instanceof Error ? err.message : String(err) },
    };
  }
}

/** 按 channel 分发（不变量 1：send 等只表达已提交，内容经事件流） */
async function route(deps: IpcDeps, req: IpcRequest): Promise<IpcResult> {
  switch (req.channel) {
    case "project:list": {
      // 列表随取随探测（existsSync 便宜）：missing 标记始终新鲜
      return { ok: true, projects: deps.projects.refreshStatuses(), currentProjectId: deps.getCurrentProjectId() };
    }
    case "project:register": {
      const dir = await deps.pickDirectory();
      if (!dir) return { ok: true, canceled: true };
      const { duplicate, project } = deps.projects.register(dir);
      // 注册成功即切到新项目（用户刚注册，立即开始工作）；重复注册不打断当前指向
      if (!duplicate) deps.setCurrentProjectId(project.id);
      return { ok: true, duplicate, project };
    }
    case "project:switch": {
      // 切换时探测（工单验收第 1 条）：missing 仅标记不阻止
      deps.projects.refreshStatuses();
      const project = deps.projects.get(req.projectId);
      if (!project) {
        return { ok: false, error: { code: "E_PROJECT_NOT_FOUND", message: `项目不存在：${req.projectId}` } };
      }
      deps.setCurrentProjectId(project.id);
      return { ok: true, project };
    }
    case "session:list": {
      const rows = deps.sessions.list(req.projectId).map(toSessionRow);
      return { ok: true, sessions: rows };
    }
    case "session:archivedList": {
      // #58 归档视图（设置面板用）：含归档时间等展示字段
      return { ok: true, sessions: deps.sessions.listArchived().map(toSessionRow) };
    }
    case "session:archive": {
      // #58 归档编排（spec #57 D 节）：中断当前 turn（interruptTurn 幂等，无活动 turn 自然 no-op）→
      // 受控终止单会话（PTY 用终端终止）→ 写归档标记；终止失败（进程已死等）不阻断归档；重复归档幂等（不重复编排）
      const rec = deps.sessions.get(req.sessionId);
      if (!rec) return sessionNotFound(req.sessionId);
      if (rec.archivedAt == null) {
        if (rec.kind === "pty") deps.pty.kill(rec.id);
        else {
          await bestEffort(() => deps.adapter.interruptTurn(rec.id), deps, `归档前中断失败（放行）：${rec.id}`);
          await bestEffort(() => deps.adapter.dispose({ sessionId: rec.id }), deps, `归档终止失败（放行）：${rec.id}`);
        }
        deps.sessions.archive(rec.id, nowIso());
      }
      return { ok: true };
    }
    case "session:unarchive": {
      // #58 取消归档编排：先重新登记可恢复句柄（adopt）→ 成功才清标记并刷新活跃时间；失败留在归档态报错（可重试）。
      // PTY 无进程恢复能力（与重启后行为一致）：仅清标记回列表显示已断开
      const rec = deps.sessions.get(req.sessionId);
      if (!rec) return sessionNotFound(req.sessionId);
      if (rec.archivedAt != null) {
        if (rec.kind === "structured") {
          if (!deps.adapter.adoptSession) {
            return { ok: false, error: { code: "E_INTERNAL", message: `当前 CLI 不支持会话收养，无法取消归档：${rec.cli}` } };
          }
          await deps.adapter.adoptSession({
            sessionId: rec.id,
            nativeSessionId: rec.nativeSessionId ?? "",
            cwd: rec.cwd ?? "",
            permMode: rec.permMode ?? undefined,
            cli: rec.cli,
          });
        }
        deps.sessions.unarchive(rec.id, nowIso());
      }
      return { ok: true };
    }
    case "session:delete": {
      // #62 删除编排（spec #57 D 节）：先解除看板关联（落 unlink 事件，重启重放后映射干净；失败抛错即中止，记录保留可重试）→
      // 终止 CLI 进程（PTY 用终端终止；终止失败 best-effort 放行——进程已死不应挡删除）→ 删除本地会话记录；
      // 幂等：记录已不存在（重复删除/从未存在）直接成功；不删 CLI 原生历史文件、不做撤销；历史事件日志永不删除
      const rec = deps.sessions.get(req.sessionId);
      if (!rec) return { ok: true };
      if (deps.engine.tracker.sessionToReq.has(rec.id)) {
        processAndEmit(deps, guiEvent(`unlink:${rec.id}`, {
          kind: "unlink",
          source: "gui",
          requirementId: null,
          sessionId: rec.id,
        }));
      }
      if (rec.kind === "pty") deps.pty.kill(rec.id);
      else {
        await bestEffort(() => deps.adapter.interruptTurn(rec.id), deps, `删除前中断失败（放行）：${rec.id}`);
        await bestEffort(() => deps.adapter.dispose({ sessionId: rec.id }), deps, `删除终止失败（放行）：${rec.id}`);
      }
      deps.sessions.delete(rec.id);
      return { ok: true };
    }
    case "session:create": {
      const { sessionId, nativeSessionId } = await deps.adapter.createSession({
        cwd: req.cwd,
        model: req.model,
        permMode: req.permMode,
        cli: req.cli,
      });
      const title = req.title ?? `新会话 · ${CLI_LABELS[req.cli] ?? req.cli}`;
      const identity = detectDirIdentity(req.cwd);
      // 会话落库（重启恢复依据；真实 Adapter 返回 native id 一并回填，Fake 无 native id 为 null）
      deps.sessions.insert({
        id: sessionId,
        kind: "structured",
        cli: req.cli,
        nativeSessionId: nativeSessionId ?? null,
        projectId: req.projectId ?? null,
        title,
        cwd: req.cwd,
        permMode: req.permMode ?? "auto",
        status: "idle",
        lastActiveAt: null,
        archivedAt: null,
      });
      // #17（spec #15 C 节）：可选 requirementId —— 创建成功后由 Main 原子落 link 事件（避免 renderer 两步编排竞态）；
      // 会话须与需求同项目，业务拒绝是合法结果不走错误码，原因直达调用方
      const linkedResult = req.requirementId
        ? linkAfterCreate(deps, sessionId, req.requirementId, req.projectId ?? null, TRACKER_CLI_BY_APP[req.cli])
        : undefined;
      return {
        ok: true,
        sessionId,
        cli: req.cli,
        title,
        dirIdentity: identity.kind,
        worktreeName: identity.kind === "worktree" ? identity.name : null,
        ...linkedResult, // 无 requirementId 时为 undefined，展开为空（响应不含 linked/reason 字段，保持既有形状）
        // #21（spec #15 E 节）：仅 Claude 创建时扫描一次（不做运行时/发送时检测；Codex/OpenCode 不检测）；检测失败安全降级为空数组（纯函数内兜底）
        ...(req.cli === "claude"
          ? { skillConflicts: detectSkillConflicts(req.cwd, (deps.resolveUserClaudeDir ?? defaultUserClaudeDir)()) }
          : {}),
      };
    }
    case "session:send":
      await deps.adapter.sendTurn({ sessionId: req.sessionId, text: req.text });
      return { ok: true };
    case "session:interrupt":
      await deps.adapter.interruptTurn(req.sessionId);
      return { ok: true };
    case "session:resolveApproval":
      await deps.adapter.resolveApproval({
        sessionId: req.sessionId,
        requestId: req.requestId,
        decision: req.decision,
      });
      return { ok: true };
    case "session:readHistory": {
      // 断开会话恢复第一步：原生历史快照（不变量 4：与实时流同键同 seq，renderer 侧无缝拼接）
      const events = await deps.adapter.readHistory(req.sessionId);
      return { ok: true, events };
    }
    case "session:resume":
      // 断开会话恢复第二步：重连原生会话（真实 CLI 语义由 #8/#10/#11 Adapter 实现）
      await deps.adapter.resume(req.sessionId);
      return { ok: true };
    // PTY 终端通道（spec E/H：切换/关标签不停止；kill 为用户显式停止的唯一入口）
    case "terminal:create": {
      const terminalId = randomUUID();
      const spawned = deps.pty.spawn(terminalId, { cwd: req.cwd, cols: req.cols ?? 80, rows: req.rows ?? 30, command: req.command });
      if (!spawned.ok) {
        return { ok: false, error: { code: "E_INTERNAL", message: spawned.message } };
      }
      const title = req.title ?? `终端 · ${spawned.label}`;
      const identity = detectDirIdentity(req.cwd);
      deps.sessions.insert({
        id: terminalId,
        kind: "pty",
        cli: "pty",
        nativeSessionId: null,
        projectId: req.projectId ?? null,
        title,
        cwd: req.cwd,
        permMode: null,
        status: "idle",
        lastActiveAt: null,
        archivedAt: null,
      });
      // #20（spec #15 C/D 节）：从需求卡片建 PTY 终端——创建成功后原子落 link 事件（与 session:create+requirementId 同语义）
      const linkedResult = req.requirementId
        ? linkAfterCreate(deps, terminalId, req.requirementId, req.projectId ?? null, "pty")
        : undefined;
      return {
        ok: true,
        sessionId: terminalId,
        cli: "pty",
        title,
        dirIdentity: identity.kind,
        worktreeName: identity.kind === "worktree" ? identity.name : null,
        ...linkedResult,
      };
    }
    case "terminal:write": {
      const written = deps.pty.write(req.terminalId, req.data);
      if (!written.ok) {
        return { ok: false, error: { code: "E_SESSION_NOT_FOUND", message: written.message } };
      }
      return { ok: true };
    }
    case "terminal:resize":
      deps.pty.resize(req.terminalId, req.cols, req.rows);
      return { ok: true };
    case "terminal:kill":
      deps.pty.kill(req.terminalId);
      return { ok: true };
    // 看板通道（#17 spec #15 C 节：全部状态变化经 TrackerEngine.process 落事件流；restore 重放不产生推送，启动靠 kanban:list 再水化）
    case "kanban:list": {
      const rows = deps.engine.snapshot().filter((r) => !req.projectId || r.projectId === req.projectId);
      const sessionToReq: Record<string, string> = {};
      for (const [sessionId, requirementId] of deps.engine.tracker.sessionToReq) sessionToReq[sessionId] = requirementId;
      return { ok: true, requirements: rows, sessionToReq };
    }
    case "kanban:create": {
      const id = nextRequirementId(deps.engine.tracker);
      processAndEmit(deps, guiEvent(`create:${id}`, {
        kind: "create",
        source: "gui-create",
        requirementId: id,
        title: req.title ?? "待命名需求",
        projectId: req.projectId,
      }));
      return { ok: true, requirementId: id };
    }
    case "kanban:rename": {
      if (!deps.engine.tracker.req(req.requirementId)) return requirementNotFound(req.requirementId);
      processAndEmit(deps, guiEvent(`rename:${req.requirementId}`, {
        kind: "rename",
        source: "gui-rename",
        requirementId: req.requirementId,
        title: req.title,
      }));
      return { ok: true };
    }
    case "kanban:setStage": {
      // uncertain 确认 = setStage 当前阶段（manual 立即生效、uncertain 清除、不锁定）；"none" 由 validateEvent 归一为未开始
      if (!deps.engine.tracker.req(req.requirementId)) return requirementNotFound(req.requirementId);
      processAndEmit(deps, guiEvent(`manual:${req.requirementId}:${req.stage}`, {
        kind: "manual",
        source: "gui-manual",
        requirementId: req.requirementId,
        stage: req.stage,
      }));
      return { ok: true };
    }
    case "kanban:link": {
      // 业务拒绝（已关联他卡/跨项目/无项目会话）是合法结果：linked=false + reason，不走错误码（spec #15 C 节）
      const r = deps.engine.tracker.req(req.requirementId);
      if (!r) return requirementNotFound(req.requirementId);
      const session = deps.sessions.get(req.sessionId);
      if (!session) {
        return { ok: false, error: { code: "E_SESSION_NOT_FOUND", message: `会话不存在：${req.sessionId}` } };
      }
      const existing = deps.engine.tracker.sessionToReq.get(req.sessionId);
      if (existing === req.requirementId) return { ok: true, linked: true }; // 幂等：已关联同一需求
      if (existing) return { ok: true, linked: false, reason: `会话已关联需求 ${existing}，请先解除关联` };
      if (session.projectId == null) {
        return { ok: true, linked: false, reason: "会话未归属项目，无法关联需求（请先在项目中创建会话）" };
      }
      if (session.projectId !== r.projectId) {
        return {
          ok: true,
          linked: false,
          reason: `跨项目关联被拒绝：会话属项目 ${session.projectId}，需求属项目 ${r.projectId}`,
        };
      }
      const changes = processLink(deps, req.sessionId, req.requirementId, session.projectId, TRACKER_CLI_BY_APP[session.cli] ?? "claude-code");
      if (changes.some((c) => c.type === "session_linked")) return { ok: true, linked: true };
      // 预检通过但状态机拒绝（并发态漂移，理论不至）：仍按业务拒绝返回原因
      return { ok: true, linked: false, reason: "关联被拒绝（会话或需求状态已变化，请刷新看板重试）" };
    }
    case "kanban:unlink": {
      const session = deps.sessions.get(req.sessionId);
      if (!session) {
        return { ok: false, error: { code: "E_SESSION_NOT_FOUND", message: `会话不存在：${req.sessionId}` } };
      }
      if (!deps.engine.tracker.sessionToReq.has(req.sessionId)) return { ok: true }; // 幂等：本就未关联
      processAndEmit(deps, guiEvent(`unlink:${req.sessionId}`, {
        kind: "unlink",
        source: "gui",
        requirementId: null,
        sessionId: req.sessionId,
      }));
      return { ok: true };
    }
    case "kanban:delete": {
      const r = deps.engine.tracker.req(req.requirementId);
      if (!r) return requirementNotFound(req.requirementId);
      // #35（spec #27 J 节 US22）：需求删除级联清理 memory 数据（批次/待审与已忽略候选/总结与 proposed/需求目录），
      // accepted/edited 知识保留；置于墓碑事件前——清理抛错时需求仍在、用户可重试删除，不产生永不可达的孤儿 memory 数据
      deps.memory?.deleteRequirementData(req.requirementId, r.projectId);
      processAndEmit(deps, guiEvent(`delete:${req.requirementId}`, {
        kind: "delete",
        source: "gui-delete",
        requirementId: req.requirementId,
      }));
      return { ok: true };
    }
  }
}

/** DB 记录 → wire 行（cwd 存在时附带目录身份判定） */
function toSessionRow(rec: ReturnType<SessionStore["list"]>[number]): SessionRow {
  const identity = rec.cwd ? detectDirIdentity(rec.cwd) : { kind: "none" as const };
  return {
    id: rec.id,
    kind: rec.kind,
    cli: rec.cli,
    nativeSessionId: rec.nativeSessionId,
    projectId: rec.projectId,
    title: rec.title,
    cwd: rec.cwd,
    permMode: rec.permMode,
    status: rec.status,
    lastActiveAt: rec.lastActiveAt,
    archivedAt: rec.archivedAt,
    dirIdentity: identity.kind,
    worktreeName: identity.kind === "worktree" ? identity.name : null,
  };
}

/** #58 归档编排的 best-effort 步骤：失败只记日志不阻断（进程已死等不应挡住归档） */
async function bestEffort(fn: () => Promise<void>, deps: IpcDeps, context: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    deps.log?.("warn", "kanban:ipc", `${context}：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** #58 未知会话 → E_SESSION_NOT_FOUND（session:archive / session:unarchive 共用） */
function sessionNotFound(sessionId: string): IpcResult {
  return { ok: false, error: { code: "E_SESSION_NOT_FOUND", message: `会话不存在：${sessionId}` } };
}

// ============ #17 kanban 通道辅助（spec #15 C 节） ============

/** 统一时间戳（事件 occurredAt/receivedAt/eventId 后缀共用同一时刻） */
function nowIso(): string {
  return new Date().toISOString();
}

/** 应用侧 cli 名（sessions 表：fake/codex/claude/opencode/pty）→ tracker CLIS（claude-code/codex/opencode/pty）；
 *  fake 演示链路的观察信号由 FakeAdapter 以 claude-code 口径上报，故同映射到 claude-code；
 *  #31 起 memory 装配（index.ts）复用本映射把关联会话 cli 归一为 tracker 口径 */
export const TRACKER_CLI_BY_APP: Record<string, Cli> = {
  fake: "claude-code",
  codex: "codex",
  claude: "claude-code",
  opencode: "opencode",
  pty: "pty",
};

/** 未知需求 id → E_REQUIREMENT_NOT_FOUND（kanban:rename/setStage/delete/link 共用） */
function requirementNotFound(requirementId: string): IpcResult {
  return { ok: false, error: { code: "E_REQUIREMENT_NOT_FOUND", message: `需求不存在：${requirementId}` } };
}

/** 下一个可用确定性需求 id（REQ-00N；跳过已占用编号；create 事件进 tracker 后推进 nextId 防自动建卡编号冲突） */
function nextRequirementId(tracker: TrackerEngine["tracker"]): string {
  let n = tracker.nextId;
  while (tracker.requirements.has(formatRequirementId(n))) n++;
  return formatRequirementId(n);
}

/** GUI 通道事件工厂（S1 评审收敛）：kanban:create/rename/setStage/unlink/delete 与 link 共用——缺省空 sessionId/cli/skill/
 *  stage/title/projectId/seq、verified 证据、同一 nowIso 时刻（eventId 后缀与 occurredAt/receivedAt 一致）；eventId = `${prefix}:${at}` */
function guiEvent(
  prefix: string,
  partial: { kind: NormalizedEvent["kind"]; source: string; requirementId: string | null } & Partial<
    Pick<NormalizedEvent, "sessionId" | "cli" | "stage" | "title" | "projectId">
  >,
): NormalizedEvent {
  const at = nowIso();
  return {
    eventId: `${prefix}:${at}`,
    kind: partial.kind,
    sessionId: partial.sessionId ?? null,
    cli: partial.cli ?? null,
    skill: null,
    stage: partial.stage ?? null,
    requirementId: partial.requirementId,
    title: partial.title ?? null,
    projectId: partial.projectId ?? null,
    occurredAt: at,
    receivedAt: at,
    seq: null,
    evidenceLevel: "verified",
    source: partial.source,
  };
}

/** 创建会话后的原子关联（session:create / terminal:create + requirementId 共用）：需求须存在且与会话同项目；
 *  业务拒绝是合法结果——返回 {linked:false, reason} 直达调用方，不落 link 事件 */
function linkAfterCreate(
  deps: IpcDeps,
  sessionId: string,
  requirementId: string,
  projectId: string | null,
  cli: Cli,
): { linked: boolean; reason?: string } {
  const r = deps.engine.tracker.req(requirementId);
  if (!r) return { linked: false, reason: `需求不存在：${requirementId}` };
  if (!projectId) return { linked: false, reason: "会话未归属项目，无法关联需求（请先在项目中创建会话）" };
  if (r.projectId !== projectId) {
    return { linked: false, reason: `跨项目关联被拒绝：会话属项目 ${projectId}，需求属项目 ${r.projectId}` };
  }
  processLink(deps, sessionId, requirementId, projectId, cli);
  return { linked: true };
}

/** 构造 link 事件经 engine 落事件流并推送变更（kanban:link 与 session:create/terminal:create+requirementId 共用原子路径） */
function processLink(deps: IpcDeps, sessionId: string, requirementId: string, projectId: string, cli: Cli): TrackerChange[] {
  return processAndEmit(deps, guiEvent(`link:${sessionId}:${requirementId}`, {
    kind: "link",
    source: "gui-card",
    requirementId,
    sessionId,
    cli,
    projectId,
  }));
}

/** 经 engine 落事件流并把引发的 tracker 变更推送 renderer（状态变化唯一路径：事件溯源 + tracker:event） */
function processAndEmit(deps: IpcDeps, ev: NormalizedEvent): TrackerChange[] {
  const { changes } = deps.engine.process(ev);
  for (const c of changes) deps.emitTrackerChange?.(c);
  return changes;
}

/** zod issue 摘要：路径 + 信息，定位到字段（不含堆栈噪音） */
function summarizeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}

/** #21：用户级 Claude 基准目录缺省解析（生产路径：CLAUDE_CONFIG_DIR 优先，否则 ~/.claude；测试经 deps.resolveUserClaudeDir 注入） */
function defaultUserClaudeDir(): string {
  return resolveUserClaudeDir(process.env, homedir());
}

// ============ #31 memory:ipc 通道（spec #27 H 节，对齐 kanban:ipc 模式：单通道 + Main 入站 zod 强制校验 + 业务拒绝 ok:false+reason） ============

/** memory:ipc 路由依赖（MemoryService 由 index.ts 经 openMemoryService 装配注入） */
export interface MemoryIpcDeps {
  memory: MemoryService;
  /** 退出序列门闸（true=正在退出，拒绝新请求；缺省恒 false 供测试） */
  isShuttingDown?(): boolean;
  /** #53（spec #52 G 节）：诊断日志 —— safeParse 失败记 error（reason 原样）；route 抛错记 error 后原样 rethrow；业务拒绝不记；缺省 no-op */
  log?: LogFn;
}

/** 处理一条 memory:ipc 入站请求：zod 强制校验 → 退出门闸 → 八通道路由（业务拒绝直达调用方，不新增全局错误码） */
export async function handleMemoryIpc(deps: MemoryIpcDeps, raw: unknown): Promise<MemoryResult> {
  const parsed = memoryRequestSchema.safeParse(raw);
  if (!parsed.success) {
    deps.log?.("error", "memory:ipc", `入站请求不符合契约（invalid-request）：${summarizeIssues(parsed.error.issues)}`);
    return { ok: false, reason: "invalid-request", detail: summarizeIssues(parsed.error.issues) };
  }
  if (deps.isShuttingDown?.()) {
    return { ok: false, reason: "shutting-down", detail: "应用正在退出，已停止接收新请求" };
  }
  const req = parsed.data;
  try {
    switch (req.channel) {
      case "memory:extract": {
        const r = deps.memory.extract(req.requirementId);
        return r.ok ? { ok: true, started: true, batchId: r.batchId } : r;
      }
      case "memory:cancel": {
        // #32：取消管线已接线（异步等待整批落定）
        const r = await deps.memory.cancel(req.requirementId);
        return r.ok ? { ok: true, cancelled: true } : r;
      }
      case "memory:reviewCandidate": {
        const r = deps.memory.reviewCandidate(req.candidateId, req.action, req.edit);
        return r.ok ? { ok: true, candidate: r.candidate } : r;
      }
      case "memory:resolveSummary": {
        return await deps.memory.resolveSummary(req.requirementId, req.choice);
      }
      case "memory:requirementMemory": {
        return await deps.memory.requirementMemory(req.requirementId);
      }
      case "memory:projectMemory": {
        return await deps.memory.projectMemory(req.projectId, req.query);
      }
      case "memory:editAccepted": {
        const r = deps.memory.editAccepted(req.candidateId, { claim: req.claim, scope: req.scope });
        return r.ok ? { ok: true, candidate: r.candidate } : r;
      }
      case "memory:editSummary": {
        return await deps.memory.editSummary(req.requirementId, req.content);
      }
    }
  } catch (err) {
    // #53：记一条 error 后原样 rethrow（既有异常向 ipcMain.handle 传播的行为不变，不吞不造码）
    deps.log?.("error", "memory:ipc", `处理异常：${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

// ============ #49 residue:ipc 通道（spec #40 D 节，对齐 memory:ipc 模式：单通道 + Main 入站 zod 强制校验 + 业务拒绝 ok:false+reason） ============

/** residue:ipc 路由依赖（检测与终止由 index.ts 装配注入：检测为本次启动缓存的一次性结果，不重复探测） */
export interface ResidueIpcDeps {
  /** 残留检测（返回缓存清单；spec：每次启动只检测一次，不轮询） */
  detect(): Promise<ResidueProcess[]>;
  /** 确认式逐 pid 终止（用户显式触发；无自动清理路径） */
  kill(pids: number[]): Promise<ResidueKillResult[]>;
  /** 退出序列门闸（true=正在退出，拒绝新请求；缺省恒 false 供测试） */
  isShuttingDown?(): boolean;
  /** #53（spec #52 G 节）：诊断日志 —— safeParse 失败记 error（reason 原样）；deps 抛错记 error 后原样 rethrow；业务拒绝不记；缺省 no-op */
  log?: LogFn;
}

// ============ #43 diff:ipc 通道（spec #40 D 节，对齐 memory:ipc 独立单通道先例：入站 zod 强制校验 + 退出门闸 + 经 project store 解析 cwd） ============

/** diff:ipc 路由依赖：project store（projectId → canonicalPath）+ git-diff-service 单函数（测试注入 fixture） */
export interface DiffIpcDeps {
  projects: ProjectStore;
  /** 读取工作区未提交变更（生产 = git-diff-service readWorkspaceDiff 装配） */
  readWorkspaceDiff(cwd: string): Promise<WorkspaceDiff>;
  /** 退出序列门闸（true=正在退出，拒绝新请求；缺省恒 false 供测试） */
  isShuttingDown?(): boolean;
  /** #53（spec #52 G 节）：诊断日志 —— safeParse 失败记 error（E_SCHEMA 原码）；readWorkspaceDiff 抛错记 error 后原样 rethrow；业务拒绝不记；缺省 no-op */
  log?: LogFn;
}

/** 处理一条 residue:ipc 入站请求：zod 强制校验 → 退出门闸 → 二通道路由（业务拒绝直达调用方，不新增全局错误码） */
export async function handleResidueIpc(deps: ResidueIpcDeps, raw: unknown): Promise<ResidueResult> {
  const parsed = residueRequestSchema.safeParse(raw);
  if (!parsed.success) {
    deps.log?.("error", "residue:ipc", `入站请求不符合契约（invalid-request）：${summarizeIssues(parsed.error.issues)}`);
    return { ok: false, reason: "invalid-request", detail: summarizeIssues(parsed.error.issues) };
  }
  if (deps.isShuttingDown?.()) {
    return { ok: false, reason: "shutting-down", detail: "应用正在退出，已停止接收新请求" };
  }
  try {
    switch (parsed.data.channel) {
      case "residue:detect":
        return { ok: true, processes: await deps.detect() };
      case "residue:kill":
        return { ok: true, results: await deps.kill(parsed.data.pids) };
    }
  } catch (err) {
    // #53：记一条 error 后原样 rethrow（既有异常向 ipcMain.handle 传播的行为不变，不吞不造码）
    deps.log?.("error", "residue:ipc", `处理异常：${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

/** 处理一条 diff:ipc 入站请求：zod 强制校验 → 退出门闸 → diff:get 经 project store 解析 cwd 后透传服务结果 */
export async function handleDiffIpc(deps: DiffIpcDeps, raw: unknown): Promise<DiffResult> {
  const parsed = diffRequestSchema.safeParse(raw);
  if (!parsed.success) {
    deps.log?.("error", "diff:ipc", `入站请求不符合契约（E_SCHEMA）：${summarizeIssues(parsed.error.issues)}`);
    return { ok: false, error: { code: "E_SCHEMA", message: summarizeIssues(parsed.error.issues) } };
  }
  if (deps.isShuttingDown?.()) {
    return { ok: false, error: { code: "E_INTERNAL", message: "应用正在退出，已停止接收新请求" } };
  }
  try {
    switch (parsed.data.channel) {
      case "diff:get": {
        const project = deps.projects.get(parsed.data.projectId);
        if (!project) {
          return { ok: false, error: { code: "E_PROJECT_NOT_FOUND", message: `项目不存在：${parsed.data.projectId}` } };
        }
        // return await：让 readWorkspaceDiff 的拒绝进 catch（记日志后原样 rethrow），而非绕过 catch 直达调用方
        return await deps.readWorkspaceDiff(project.canonicalPath);
      }
    }
  } catch (err) {
    // #53：记一条 error 后原样 rethrow（既有异常向 ipcMain.handle 传播的行为不变，不吞不造码）
    deps.log?.("error", "diff:ipc", `处理异常：${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

// ============ #61 config:ipc 通道（spec #57 配置链路，对齐 diff:ipc 独立单通道先例：读 autoArchive 子集 / 写字段级合并 + 先持久化成功再改内存） ============

/** config:ipc 路由依赖：内存配置对象 + 全量持久化（getConfig/persist 由 index.ts 经闭包注入，测试替换 fixture） */
export interface ConfigIpcDeps {
  /** 当前内存配置（Main 闭包对象，恒返回同一引用；写盘成功后由 handler 原地更新其 autoArchive 字段，其余字段一律不触碰） */
  getConfig(): AppConfig;
  /** 持久化完整配置（生产 = saveConfig 全量写回；抛错即写盘失败，新值不生效） */
  persist(config: AppConfig): void;
  /** 退出序列门闸（true=正在退出，拒绝新请求；缺省恒 false 供测试） */
  isShuttingDown?(): boolean;
  /** #53 惯例：safeParse 失败与 persist 抛错记 error；缺省 no-op */
  log?: LogFn;
}

/** 处理一条 config:ipc 入站请求：zod 强制校验 → 退出门闸 → 读子集 / 写先持久化成功再改内存（失败明确报错，内存与磁盘不分叉） */
export async function handleConfigIpc(deps: ConfigIpcDeps, raw: unknown): Promise<ConfigResult> {
  const parsed = configRequestSchema.safeParse(raw);
  if (!parsed.success) {
    deps.log?.("error", "config:ipc", `入站请求不符合契约（E_SCHEMA）：${summarizeIssues(parsed.error.issues)}`);
    return { ok: false, error: { code: "E_SCHEMA", message: summarizeIssues(parsed.error.issues) } };
  }
  if (deps.isShuttingDown?.()) {
    return { ok: false, error: { code: "E_INTERNAL", message: "应用正在退出，已停止接收新请求" } };
  }
  try {
    switch (parsed.data.channel) {
      case "config:get":
        return { ok: true, autoArchive: deps.getConfig().autoArchive };
      case "config:set": {
        const current = deps.getConfig();
        // 先持久化成功再改内存：persist 抛错进 catch（返回明确错误，内存对象未动，新值不生效）；
        // 写仅开放 autoArchive 子集 —— 持久化对象由内存配置字段级合并而来，项目/CLI 路径等其余字段不受请求影响
        deps.persist({ ...current, autoArchive: parsed.data.autoArchive });
        current.autoArchive = parsed.data.autoArchive;
        return { ok: true, autoArchive: current.autoArchive };
      }
    }
  } catch (err) {
    // 写盘失败不 rethrow：配置保存是用户可见的可重试动作，返回明确错误直达调用方（新值不生效）
    const message = err instanceof Error ? err.message : String(err);
    deps.log?.("error", "config:ipc", `配置保存失败（新值不生效）：${message}`);
    return { ok: false, error: { code: "E_INTERNAL", message: `配置保存失败，新值未生效：${message}` } };
  }
}
