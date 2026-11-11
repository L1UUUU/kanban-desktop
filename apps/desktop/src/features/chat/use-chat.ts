// 用途：聊天控制器 hook —— transport → ChatStore 接线：启动恢复（session:list 断开会话登记）+ 无项目时 boot 演示草稿（#59：发出首条消息才创建会话，空会话永不进历史）+ 全部会话始终归并（切会话不中断，一致项 7），动作经 IPC 单通道发出
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AdapterEvent, ApprovalDecision, ChatEvent, CliKind, IpcResult, PermMode, ProjectRow } from "@kanban/ipc-schema";
import type { ChatTransport } from "../../lib/kanban-api";
import { createScopedLogger } from "../../lib/logger";
import { ChatStore, DEFAULT_MODEL, type DraftSession, type SessionView } from "./chat-store";

// 本文件日志出口（scope 固定 chat，经 lib/logger 唯一出口发出）
const log = createScopedLogger("chat");

/** #59 草稿打开可选项（cwd 必填：挂当前项目的会话传项目 canonicalPath；权限/模型缺省继承当前 composer 选定值） */
export interface OpenDraftOptions {
  cwd: string;
  projectId?: string | null;
  title?: string;
  /** #20：从需求卡片进草稿——提交后由 Main 原子落 link 事件（会话须与需求同项目） */
  requirementId?: string;
}

export interface ChatControllerActions {
  send(text: string): void;
  interrupt(): void;
  resolveApproval(decision: ApprovalDecision): void;
  /** #59：打开结构化会话草稿（不 invoke、不落库、不进侧栏；全局仅一个，再点「＋」替换） */
  openDraft(cli: CliKind, opts?: OpenDraftOptions): void;
  /** #59：提交草稿 —— 经 session:create+firstMessage 原子完成「创建原生会话→落库→发送首条消息」；失败返回 false（草稿与输入保留） */
  submitDraft(): Promise<boolean>;
  switchTo(sessionId: string): void;
  setPerm(mode: PermMode): void;
  setModel(model: string): void;
  /** 断开会话「读取原生历史并恢复」：readHistory 快照重建消息流 → resume 重连（状态经实时事件流回 idle） */
  resumeSession(sessionId: string): Promise<void>;
  /** #58 归档会话（侧栏 hover「归档」）：Main 编排中断+终止+写标记；成功后本地移除行（含激活切换），失败在该会话上报错 */
  archiveSession(sessionId: string): Promise<void>;
  /** #62 删除会话（侧栏 hover「删除」经二次确认）：Main 编排 unlink+终止+删记录；成功后本地移除行（含激活切换），失败在该会话上报错（行保留可重试） */
  deleteSession(sessionId: string): Promise<void>;
  /** #21：关闭同名 skill 冲突提示条（仅隐藏不影响会话） */
  dismissSkillConflict(sessionId: string): void;
}

export interface ChatController extends ChatControllerActions {
  sessions: SessionView[];
  activeSession: SessionView | null;
  activeId: string | null;
  /** store 版本号（驱动视图滚动等副作用） */
  version: number;
  /** #59：当前结构化会话草稿（null=无；中央区草稿面板数据源） */
  draft: DraftSession | null;
  /** store 直面（终端控制器等并列模块登记 PTY 会话/更新状态用） */
  store: ChatStore;
}

/**
 * 「＋」新建的 cwd 解析：项目在列表 → canonicalPath；查不到（DB 重置后残留 id 等）不回退任何路径——
 * 真实 CLI/PTY 返回 null 由调用方提示「项目不存在」并拒绝新建，仅 Fake 回落注入的演示 cwd
 */
export function resolveSessionCwd(projects: ProjectRow[], projectId: string, cli: CliKind | "pty", demoCwd: string | null): string | null {
  const canonical = projects.find((p) => p.id === projectId)?.canonicalPath;
  if (canonical) return canonical;
  return cli === "fake" ? demoCwd : null;
}

/** ChatEvent 判别（SkillObservation 无 type 判别字段） */
function isChatEvent(e: AdapterEvent): e is ChatEvent {
  return "type" in e;
}

/**
 * #59 提交编排（模块级可直测）：session:create+firstMessage 原子链 ——
 * 成功：登记会话 + 首条消息本地回显 + 丢弃草稿；失败：草稿与输入保留（可重试），错误直达失败卡，
 * Main 回滚时事件先至的占位行按 rolledBackSessionId 撤销（不留空会话）。
 */
export async function submitDraftChain(store: ChatStore, transport: ChatTransport): Promise<boolean> {
  const d = store.getSnapshot().draft;
  if (!d || d.input.trim().length === 0) return false;
  // 「默认模型」是 UI 占位串不下发（后端按各 CLI 探测链自选）
  const model = d.model === DEFAULT_MODEL ? undefined : d.model;
  const r = await transport.invoke({
    channel: "session:create",
    cli: d.cli,
    cwd: d.cwd,
    projectId: d.projectId ?? undefined,
    title: d.title,
    ...(model ? { model } : {}),
    permMode: d.permMode,
    requirementId: d.requirementId,
    firstMessage: d.input,
  });
  if (r.ok && r.sessionId) {
    // #20：卡片进草稿的自动关联由 Main 原子完成（session_linked 推送回流看板 store）；拒绝仅报告不阻断会话
    if (r.linked === false)
      log.error("会话创建后自动关联被拒绝", {
        sessionId: r.sessionId,
        ...(r.reason ? { reason: r.reason } : {}),
      });
    store.registerSession({
      sessionId: r.sessionId,
      cli: r.cli ?? d.cli,
      title: r.title ?? d.title,
      permMode: d.permMode,
      model: d.model,
      projectId: d.projectId,
      cwd: d.cwd,
      dirIdentity: r.dirIdentity ?? "none",
      worktreeName: r.worktreeName ?? null,
      // #21：Main 仅对 claude 会话附同名 skill 冲突名（其余 CLI 缺省无冲突）
      skillConflicts: r.skillConflicts ?? [],
    });
    store.appendUserMessage(r.sessionId, d.input); // 首条消息本地回显（内容不经事件流回传）
    store.discardDraft();
    return true;
  }
  // 失败：草稿与输入保留（可重试），错误直达失败卡；不留空会话（Main 已回滚记录）
  const code = r.ok ? "E_INTERNAL" : r.error.code;
  const message = r.ok ? "未知错误" : r.error.message;
  // Main 回滚时事件（session_status 等）可能已先至渲染端建占位行——按回滚 id 撤销，不留空会话
  if (!r.ok && r.error.rolledBackSessionId) store.removeSession(r.error.rolledBackSessionId);
  // #55（spec #52 G 节）：提交失败留痕（带关键参数；requirementId 可选键条件携带，防 ctx 出现 undefined）
  log.error("草稿提交失败（创建+发送首条消息）", {
    cli: d.cli,
    code,
    message,
    cwd: d.cwd,
    ...(d.projectId ? { projectId: d.projectId } : {}),
    ...(d.requirementId ? { requirementId: d.requirementId } : {}),
  });
  store.setDraftSubmitError(code, message);
  return false;
}

/**
 * #42 恢复编排（模块级可直测）：两步 IPC —— readHistory 快照重建消息流 → resume 重连。
 * 发出即「恢复中」（不可中断，D1）；任一步失败进「失败」态（重试/复制详情）；
 * 成功收敛由 resume 后实时 session_status 驱动（store 复位 resumeState + 状态徽标回 idle）。
 */
export async function resumeChain(store: ChatStore, transport: ChatTransport, sessionId: string): Promise<void> {
  store.markResuming(sessionId);
  // 第一步：读原生历史（事件溯源快照）重建消息流；第二步：resume 重连，状态经实时事件流回 idle
  const r = await transport.invoke({ channel: "session:readHistory", sessionId });
  if (!r.ok) {
    store.markResumeFailed(sessionId, r.error.code, r.error.message);
    // #55（spec #52 G 节）：恢复失败留痕（带会话标识；jsdom 无桥可选链降级）
    log.error("会话恢复失败（readHistory）", { sessionId, code: r.error.code, message: r.error.message });
    return;
  }
  store.applySnapshot(sessionId, r.events ?? []);
  const r2 = await transport.invoke({ channel: "session:resume", sessionId });
  if (!r2.ok) {
    store.markResumeFailed(sessionId, r2.error.code, r2.error.message);
    log.error("会话恢复失败（resume）", { sessionId, code: r2.error.code, message: r2.error.message });
  }
}

/**
 * 聊天控制器 hook。demoCwd 为 Fake 演示草稿 cwd（App 层经 AppInfo 注入：Main 读 KANBAN_FAKE_DEMO_CWD、
 * 缺省用户主目录）；未注入（null/undefined）前不自举 boot 演示草稿，真实会话 cwd 一律来自已注册项目。
 */
export function useChatController(transport: ChatTransport | null, demoCwd: string | null = null): ChatController {
  // useState 初始化器保证每 hook 实例一个 store（渲染期可安全读取）
  const [store] = useState(() => new ChatStore());
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // 启动自举一次性标记（仅 effect 内读写：StrictMode 双挂载下只跑一次，订阅仍每次重建）
  const bootRef = useRef(false);

  // 事件订阅 + 启动自举：事件对全部会话始终归并（与激活视图无关 —— 切换不停止）；
  // 自举等 demoCwd 注入到位（AppInfo 异步拉取）再跑，避免演示草稿缺失或以未知目录打开
  useEffect(() => {
    if (!transport) return;
    const off = transport.onEvent((e) => {
      if (isChatEvent(e)) store.applyEvent(e);
    });
    if (!bootRef.current && demoCwd !== null) {
      bootRef.current = true;
      void bootstrap(transport, store, demoCwd);
    }
    return off;
  }, [transport, store, demoCwd]);

  const actions = useMemo<ChatControllerActions>(() => {
    const activeId = (): string | null => store.getSnapshot().activeId;
    const report = (p: Promise<IpcResult>, sessionId: string): void => {
      void p.then((r) => {
        if (!r.ok) store.setError(sessionId, r.error.code, r.error.message);
      });
    };
    return {
      send: (text) => {
        const id = activeId();
        if (!id || !transport || text.trim().length === 0) return;
        store.appendUserMessage(id, text);
        report(transport.invoke({ channel: "session:send", sessionId: id, text }), id);
      },
      interrupt: () => {
        const id = activeId();
        if (!id || !transport) return;
        report(transport.invoke({ channel: "session:interrupt", sessionId: id }), id);
      },
      resolveApproval: (decision) => {
        const id = activeId();
        const pending = id ? store.getSession(id)?.pendingApproval : null;
        if (!id || !pending || !transport) return;
        store.clearApproval(id); // 决定即时生效：卡片立即消失（后续输出经事件流差异呈现）
        report(
          transport.invoke({
            channel: "session:resolveApproval",
            sessionId: id,
            requestId: pending.requestId,
            decision,
          }),
          id,
        );
      },
      openDraft: (cli, opts) => {
        // cwd 必须显式携带，或（仅 fake）回落注入的演示目录；真实 CLI 缺 cwd 直接拒绝，不以任何隐式路径建草稿
        const resolved = opts ?? (cli === "fake" && demoCwd ? { cwd: demoCwd } : null);
        if (!resolved) {
          log.error("草稿打开失败：缺少 cwd（真实会话须挂已注册项目，演示目录未注入）");
          return;
        }
        // 模型继承当前 composer 选定值：优先当前草稿，其次当前激活会话（权限档位不继承，草稿内自选）
        const s = store.getSnapshot();
        const inheritFrom = s.draft ?? (s.activeId ? store.getSession(s.activeId) : undefined);
        store.openDraft({
          cli,
          cwd: resolved.cwd,
          projectId: resolved.projectId,
          title: resolved.title,
          requirementId: resolved.requirementId,
          model: inheritFrom?.model,
        });
      },
      submitDraft: async () => {
        if (!transport) return false;
        return submitDraftChain(store, transport);
      },
      switchTo: (sessionId) => store.setActive(sessionId),
      dismissSkillConflict: (sessionId) => store.dismissSkillConflict(sessionId),
      setPerm: (mode) => {
        const id = activeId();
        if (id) store.updateSession(id, { permMode: mode });
      },
      setModel: (model) => {
        const id = activeId();
        if (id) store.updateSession(id, { model });
      },
      resumeSession: async (sessionId) => {
        if (!transport) return;
        await resumeChain(store, transport, sessionId);
      },
      archiveSession: async (sessionId) => {
        if (!transport) return;
        const r = await transport.invoke({ channel: "session:archive", sessionId });
        if (r.ok) store.removeSession(sessionId);
        else {
          store.setError(sessionId, r.error.code, r.error.message);
          log.error("会话归档失败", { sessionId, code: r.error.code, message: r.error.message });
        }
      },
      deleteSession: async (sessionId) => {
        if (!transport) return;
        const r = await transport.invoke({ channel: "session:delete", sessionId });
        if (r.ok) store.removeSession(sessionId);
        else {
          store.setError(sessionId, r.error.code, r.error.message);
          log.error("会话删除失败", { sessionId, code: r.error.code, message: r.error.message });
        }
      },
    };
  }, [transport, store, demoCwd]);

  const activeSession = snap.activeId ? (store.getSession(snap.activeId) ?? null) : null;

  return {
    ...actions,
    sessions: snap.sessions,
    activeSession,
    activeId: snap.activeId,
    version: snap.version,
    draft: snap.draft,
    store,
  };
}

/** 启动自举：恢复 DB 历史会话（统一断开态）；无项目且无会话时打开 Fake 演示草稿（#59：不落库，发第一条消息才成会话） */
async function bootstrap(transport: ChatTransport, store: ChatStore, demoCwd: string): Promise<void> {
  const [projRes, sessRes] = await Promise.all([
    transport.invoke({ channel: "project:list" }),
    transport.invoke({ channel: "session:list" }),
  ]);
  if (sessRes.ok && sessRes.sessions) {
    for (const row of sessRes.sessions) store.registerRestored(row);
  }
  const hasProjects = projRes.ok && (projRes.projects?.length ?? 0) > 0;
  if (!hasProjects && store.getSnapshot().sessions.length === 0) {
    store.openDraft({ cli: "fake", cwd: demoCwd, title: "演示会话 · Fake" });
  }
}
