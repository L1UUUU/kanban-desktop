// 用途：聊天控制器 hook —— transport → ChatStore 接线：启动恢复（session:list 断开会话登记）+ 无项目时 boot 演示会话 + 全部会话始终归并（切会话不中断，一致项 7），动作经 IPC 单通道发出
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AdapterEvent, ApprovalDecision, ChatEvent, CliKind, IpcResult, PermMode, ProjectRow } from "@kanban/ipc-schema";
import type { ChatTransport } from "../../lib/kanban-api";
import { ChatStore, type SessionView } from "./chat-store";

export const DEFAULT_MODEL = "默认模型";

/** createSession 可选项（cwd 必填：挂当前项目的会话传项目 canonicalPath） */
export interface CreateSessionOptions {
  cwd: string;
  projectId?: string | null;
  title?: string;
  permMode?: PermMode;
  /** #20：从需求卡片建会话——Main 创建成功后原子落 link 事件（会话须与需求同项目） */
  requirementId?: string;
}

export interface ChatControllerActions {
  send(text: string): void;
  interrupt(): void;
  resolveApproval(decision: ApprovalDecision): void;
  createSession(cli: CliKind, opts?: CreateSessionOptions): Promise<void>;
  switchTo(sessionId: string): void;
  setPerm(mode: PermMode): void;
  setModel(model: string): void;
  /** 断开会话「读取原生历史并恢复」：readHistory 快照重建消息流 → resume 重连（状态经实时事件流回 idle） */
  resumeSession(sessionId: string): Promise<void>;
  /** #21：关闭同名 skill 冲突提示条（仅隐藏不影响会话） */
  dismissSkillConflict(sessionId: string): void;
  /** #46：关闭会话创建失败卡（仅隐藏；下次创建成功自动清除） */
  dismissCreateFailure(): void;
}

export interface ChatController extends ChatControllerActions {
  sessions: SessionView[];
  activeSession: SessionView | null;
  activeId: string | null;
  /** store 版本号（驱动视图滚动等副作用） */
  version: number;
  /** #46：最近一次会话创建失败（null=无；侧栏创建入口错误卡数据源） */
  createFailure: import("./chat-store").CreateFailure | null;
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
 * 聊天控制器 hook。demoCwd 为 Fake 演示会话 cwd（App 层经 AppInfo 注入：Main 读 KANBAN_FAKE_DEMO_CWD、
 * 缺省用户主目录）；未注入（null/undefined）前不自举 boot 演示会话，真实会话 cwd 一律来自已注册项目。
 */
export function useChatController(transport: ChatTransport | null, demoCwd: string | null = null): ChatController {
  // useState 初始化器保证每 hook 实例一个 store（渲染期可安全读取）
  const [store] = useState(() => new ChatStore());
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // 启动自举一次性标记（仅 effect 内读写：StrictMode 双挂载下只跑一次，订阅仍每次重建）
  const bootRef = useRef(false);

  // 事件订阅 + 启动自举：事件对全部会话始终归并（与激活视图无关 —— 切换不停止）；
  // 自举等 demoCwd 注入到位（AppInfo 异步拉取）再跑，避免演示会话缺失或以未知目录创建
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
      createSession: async (cli, opts) => {
        if (!transport) return;
        // cwd 必须显式携带，或（仅 fake）回落注入的演示目录；真实 CLI 缺 cwd 直接拒绝，不以任何隐式路径创建
        const resolved = opts ?? (cli === "fake" && demoCwd ? { cwd: demoCwd } : null);
        if (!resolved) {
          console.error("[kanban] 会话创建失败：缺少 cwd（真实会话须挂已注册项目，演示目录未注入）");
          return;
        }
        await createCliSession(transport, store, cli, resolved);
      },
      switchTo: (sessionId) => store.setActive(sessionId),
      dismissSkillConflict: (sessionId) => store.dismissSkillConflict(sessionId),
      dismissCreateFailure: () => store.clearCreateFailure(),
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
        // #42：恢复引导条三态驱动——发出即「恢复中」（不可中断，D1），任一步 IPC 失败进「失败」态（重试/复制详情），
        // 成功收敛由 resume 后实时 session_status 驱动（store 复位 resumeState + 状态徽标回 idle）
        store.markResuming(sessionId);
        // 第一步：读原生历史（事件溯源快照）重建消息流；第二步：resume 重连，状态经实时事件流回 idle
        const r = await transport.invoke({ channel: "session:readHistory", sessionId });
        if (!r.ok) {
          store.markResumeFailed(sessionId, r.error.code, r.error.message);
          return;
        }
        store.applySnapshot(sessionId, r.events ?? []);
        const r2 = await transport.invoke({ channel: "session:resume", sessionId });
        if (!r2.ok) {
          store.markResumeFailed(sessionId, r2.error.code, r2.error.message);
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
    createFailure: snap.createFailure,
    store,
  };
}

/** 启动自举：恢复 DB 历史会话（统一断开态）；无项目且无历史时用注入的 demoCwd 建 Fake 演示会话（#6 链路保持） */
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
    await createCliSession(transport, store, "fake", { cwd: demoCwd, title: "演示会话 · Fake" });
  }
}

/** 创建会话并登记激活（目录身份来自 Main 判定回传；#46 起创建失败记录进 store 由侧栏创建入口错误卡呈现） */
export async function createCliSession(
  transport: ChatTransport,
  store: ChatStore,
  cli: CliKind,
  opts: CreateSessionOptions,
): Promise<void> {
  const r = await transport.invoke({
    channel: "session:create",
    cli,
    cwd: opts.cwd,
    projectId: opts.projectId ?? undefined,
    title: opts.title,
    permMode: opts.permMode ?? "auto",
    requirementId: opts.requirementId,
  });
  if (r.ok && r.sessionId) {
    // #20：卡片建会话的自动关联由 Main 原子完成（session_linked 推送回流看板 store）；拒绝仅报告不阻断会话
    if (r.linked === false) console.error("[kanban] 会话创建后自动关联被拒绝", r.reason);
    store.registerSession({
      sessionId: r.sessionId,
      cli: r.cli ?? cli,
      title: r.title ?? opts.title ?? `新会话 · ${cli}`,
      permMode: opts.permMode ?? "auto",
      model: DEFAULT_MODEL,
      projectId: opts.projectId ?? null,
      cwd: opts.cwd,
      dirIdentity: r.dirIdentity ?? "none",
      worktreeName: r.worktreeName ?? null,
      // #21：Main 仅对 claude 会话附同名 skill 冲突名（其余 CLI 缺省无冲突）
      skillConflicts: r.skillConflicts ?? [],
    });
  } else if (!r.ok) {
    // #46：创建失败无会话视图可挂——记录到 store（侧栏创建入口错误卡呈现，携带原参数供「重试创建」；spec #40 F1）
    store.setCreateFailure({
      cli,
      code: r.error.code,
      message: r.error.message,
      cwd: opts.cwd,
      projectId: opts.projectId ?? null,
      title: opts.title,
      requirementId: opts.requirementId,
    });
  }
}
