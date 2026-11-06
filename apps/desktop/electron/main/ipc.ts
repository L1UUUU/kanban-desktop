// 用途：Main 入站 IPC 路由 —— 单通道 kanban:ipc 强制 zod 校验 + 分发到 CliAdapter 与 projects/sessions store + PTY 宿主（纯函数无 Electron 依赖：dialog 与 config 经 deps 注入）
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  ipcRequestSchema,
  type IpcRequest,
  type IpcResult,
  type SessionRow,
} from "@kanban/ipc-schema";
import { AdapterError, detectSkillConflicts, resolveUserClaudeDir, type CliAdapter } from "@kanban/cli-host";
import { TrackerEngine, type Cli, type NormalizedEvent, type TrackerChange } from "@kanban/tracker";
import { detectDirIdentity } from "./git-identity";
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
      const at = nowIso();
      processAndEmit(deps, {
        eventId: `create:${id}:${at}`,
        kind: "create",
        sessionId: null,
        cli: null,
        skill: null,
        stage: null,
        requirementId: id,
        title: req.title ?? "待命名需求",
        projectId: req.projectId,
        occurredAt: at,
        receivedAt: at,
        seq: null,
        evidenceLevel: "verified",
        source: "gui-create",
      });
      return { ok: true, requirementId: id };
    }
    case "kanban:rename": {
      if (!deps.engine.tracker.req(req.requirementId)) return requirementNotFound(req.requirementId);
      const at = nowIso();
      processAndEmit(deps, {
        eventId: `rename:${req.requirementId}:${at}`,
        kind: "rename",
        sessionId: null,
        cli: null,
        skill: null,
        stage: null,
        requirementId: req.requirementId,
        title: req.title,
        projectId: null,
        occurredAt: at,
        receivedAt: at,
        seq: null,
        evidenceLevel: "verified",
        source: "gui-rename",
      });
      return { ok: true };
    }
    case "kanban:setStage": {
      // uncertain 确认 = setStage 当前阶段（manual 立即生效、uncertain 清除、不锁定）；"none" 由 validateEvent 归一为未开始
      if (!deps.engine.tracker.req(req.requirementId)) return requirementNotFound(req.requirementId);
      const at = nowIso();
      processAndEmit(deps, {
        eventId: `manual:${req.requirementId}:${req.stage}:${at}`,
        kind: "manual",
        sessionId: null,
        cli: null,
        skill: null,
        stage: req.stage,
        requirementId: req.requirementId,
        title: null,
        projectId: null,
        occurredAt: at,
        receivedAt: at,
        seq: null,
        evidenceLevel: "verified",
        source: "gui-manual",
      });
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
      const at = nowIso();
      processAndEmit(deps, {
        eventId: `unlink:${req.sessionId}:${at}`,
        kind: "unlink",
        sessionId: req.sessionId,
        cli: null,
        skill: null,
        stage: null,
        requirementId: null,
        title: null,
        projectId: null,
        occurredAt: at,
        receivedAt: at,
        seq: null,
        evidenceLevel: "verified",
        source: "gui",
      });
      return { ok: true };
    }
    case "kanban:delete": {
      if (!deps.engine.tracker.req(req.requirementId)) return requirementNotFound(req.requirementId);
      const at = nowIso();
      processAndEmit(deps, {
        eventId: `delete:${req.requirementId}:${at}`,
        kind: "delete",
        sessionId: null,
        cli: null,
        skill: null,
        stage: null,
        requirementId: req.requirementId,
        title: null,
        projectId: null,
        occurredAt: at,
        receivedAt: at,
        seq: null,
        evidenceLevel: "verified",
        source: "gui-delete",
      });
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
    dirIdentity: identity.kind,
    worktreeName: identity.kind === "worktree" ? identity.name : null,
  };
}

// ============ #17 kanban 通道辅助（spec #15 C 节） ============

/** 统一时间戳（事件 occurredAt/receivedAt/eventId 后缀共用同一时刻） */
function nowIso(): string {
  return new Date().toISOString();
}

/** 应用侧 cli 名（sessions 表：fake/codex/claude/opencode/pty）→ tracker CLIS（claude-code/codex/opencode/pty）；
 *  fake 演示链路的观察信号由 FakeAdapter 以 claude-code 口径上报，故同映射到 claude-code */
const TRACKER_CLI_BY_APP: Record<string, Cli> = {
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
  while (tracker.requirements.has(`REQ-${String(n).padStart(3, "0")}`)) n++;
  return `REQ-${String(n).padStart(3, "0")}`;
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
  if (!projectId) return { linked: false, reason: "会话未归属项目，无法关联需求" };
  if (r.projectId !== projectId) {
    return { linked: false, reason: `跨项目关联被拒绝：会话属项目 ${projectId}，需求属项目 ${r.projectId}` };
  }
  processLink(deps, sessionId, requirementId, projectId, cli);
  return { linked: true };
}

/** 构造 link 事件经 engine 落事件流并推送变更（kanban:link 与 session:create/terminal:create+requirementId 共用原子路径） */
function processLink(deps: IpcDeps, sessionId: string, requirementId: string, projectId: string, cli: Cli): TrackerChange[] {
  const at = nowIso();
  return processAndEmit(deps, {
    eventId: `link:${sessionId}:${requirementId}:${at}`,
    kind: "link",
    sessionId,
    cli,
    skill: null,
    stage: null,
    requirementId,
    title: null,
    projectId,
    occurredAt: at,
    receivedAt: at,
    seq: null,
    evidenceLevel: "verified",
    source: "gui-card",
  });
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
