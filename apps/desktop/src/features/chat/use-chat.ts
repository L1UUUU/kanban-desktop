// 用途：会话控制器 hook（issue #71：内聚两类草稿与全部会话写路径）—— transport → ChatStore 接线：启动恢复（session:list 断开会话登记）+ 无项目时 boot 演示草稿（#59：发出首条消息才创建会话，空会话永不进历史）+ 全部会话始终归并（切会话不中断，一致项 7）；openSessionDraft 为互斥属主唯一安装点（全局至多一个草稿、两类互相替换、replacedHint 单源）；TerminalDraftController/TerminalManager/terminal:event 订阅隐藏在 seam 之后（use-terminals.ts 已消亡）
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AdapterEvent, ApprovalDecision, ChatEvent, CliKind, IpcResult, PermMode, ProjectRow, SessionRow, SessionStatus, TerminalCommand } from "@kanban/ipc-schema";
import type { ChatTransport } from "../../lib/kanban-api";
import { createScopedLogger } from "../../lib/logger";
import { ChatStore, DEFAULT_MODEL, type DraftSession, type SessionMeta, type SessionView } from "./chat-store";
import { TerminalDraftController, type TerminalDraftSnapshot } from "../terminal/terminal-draft";
import { TerminalManager } from "../terminal/TerminalManager";

// 本文件日志出口（scope 固定 chat，经 lib/logger 唯一出口发出；终端链路沿用 terminal scope 保留过滤语义）
const log = createScopedLogger("chat");
const termLog = createScopedLogger("terminal");

/** 中央区草稿判别联合（issue #71 S4）：全局任一时刻至多一个，两类互相替换（openSessionDraft 单源） */
export type SessionDraft = { kind: "structured"; data: DraftSession } | { kind: "pty"; data: TerminalDraftSnapshot };

/** openSessionDraft 入参（cwd 解析内聚：fromSessionId 给定取该会话 cwd，否则经 deps.resolveCwd 按项目解析） */
export interface OpenSessionDraftInput {
  projectId: string | null;
  /** 结构化 CLI 或 "pty"（PTY 终端草稿） */
  cli: CliKind | "pty";
  requirementId?: string;
  /** PTY 专属：启动命令（缺省交互 shell） */
  command?: TerminalCommand;
  /** 认证失效卡「打开 PTY 终端」：cwd 取该会话（替代调用方手查会话 cwd） */
  fromSessionId?: string;
}

export type OpenDraftResult =
  | { ok: true; replaced: "structured" | "pty" | null }
  | { ok: false; reason: "project-missing" };

export interface ChatControllerActions {
  send(text: string): void;
  interrupt(): void;
  resolveApproval(decision: ApprovalDecision): void;
  /** 互斥属主唯一安装点（issue #71 S4）：cwd 解析 / 项目不存在提示 / 跨类草稿互斥替换 / replacedHint 单源，一个动作完成 */
  openSessionDraft(input: OpenSessionDraftInput): OpenDraftResult;
  /** #59：提交草稿 —— 经 session:create+firstMessage 原子完成「创建原生会话→落库→发送首条消息」；失败返回 false（草稿与输入保留） */
  submitDraft(): Promise<boolean>;
  /** 草稿本地编辑（能力收窄：仅首条消息输入/权限档位/模型三字段，非任意 patch） */
  updateDraft(patch: Partial<Pick<DraftSession, "input" | "permMode" | "model">>): void;
  /** #59 失败卡「知道了」：仅清除提交错误（草稿与输入保留） */
  clearDraftSubmitError(): void;
  /** 切会话 = 离开草稿：结构化丢弃（store.setActive 内聚）+ PTY 丢弃（含 xterm 释放），一行属主 */
  switchTo(sessionId: string): void;
  /** 两类草稿齐丢（切项目 effect 单调用；不弹确认、输入不保留） */
  discardAllDrafts(): void;
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
  /** #46：错误卡「知道了」清除会话 lastError（仅隐藏） */
  clearError(sessionId: string): void;
}

/** 外部并列模块登记/同步会话的窄面（issue #71 S2：PTY 迟到成功登记 / started-exit 徽标 / 取消归档回列表） */
export interface SessionRegistry {
  /** PTY 终端创建成功（含草稿丢弃后的迟到成功——Main 已落库，仍须登记行） */
  registerExternalSession(meta: SessionMeta): void;
  /** 外部状态直写（PTY started/exit 事件驱动，与 ChatEvent 路径并列） */
  updateExternalStatus(id: string, status: SessionStatus): void;
  /** 取消归档回默认列表（设置面板 #63）与启动恢复（DB 行登记） */
  registerRestored(row: SessionRow): void;
}

export interface ChatController extends ChatControllerActions, SessionRegistry {
  sessions: SessionView[];
  activeSession: SessionView | null;
  activeId: string | null;
  /** 视图失效信号（有意暴露：ChatPane 滚动等副作用驱动，非 store 泄漏补救） */
  version: number;
  /** 当前草稿（判别联合；null=无；中央区草稿路由两分支的数据源） */
  draft: SessionDraft | null;
  /** PTY 终端数据源与显式终止入口（TerminalWorkspace 渲染挂点） */
  terminals: { manager: TerminalManager; kill(id: string): void };
}

/** useChatController 依赖注入（ChatWorkspace 用 projects+demoCwd 包 resolveSessionCwd 实现；onNotice 接 projects.setNotice） */
export interface ChatControllerDeps {
  demoCwd: string | null;
  /** cwd 解析（项目 canonicalPath / Fake 演示回落；返回 null=项目不存在拒绝新建） */
  resolveCwd(projectId: string | null, cli: CliKind | "pty"): string | null;
  /** 项目不存在等新建拒绝提示（单源：3 份手抄归 1） */
  onNotice(message: string): void;
}

/**
 * 「＋」新建的 cwd 解析：项目在列表 → canonicalPath；查不到（DB 重置后残留 id、无项目 null 等）不回退任何路径——
 * 真实 CLI/PTY 返回 null 由调用方提示「项目不存在」并拒绝新建，仅 Fake 回落注入的演示 cwd
 */
export function resolveSessionCwd(projects: ProjectRow[], projectId: string | null, cli: CliKind | "pty", demoCwd: string | null): string | null {
  const canonical = projects.find((p) => p.id === projectId)?.canonicalPath;
  if (canonical) return canonical;
  return cli === "fake" ? demoCwd : null;
}

/** ChatEvent 判别（SkillObservation 无 type 判别字段） */
function isChatEvent(e: AdapterEvent): e is ChatEvent {
  return "type" in e;
}

/** 草稿动作环境（issue #71 S5：互斥编排提取为模块级可直测函数的依赖集） */
export interface SessionDraftEnv {
  store: ChatStore;
  drafts: TerminalDraftController;
  manager: TerminalManager;
  /** cwd 解析（项目 canonicalPath / Fake 演示回落；返回 null=项目不存在拒绝新建） */
  resolveCwd(projectId: string | null, cli: CliKind | "pty"): string | null;
  /** 项目不存在等新建拒绝提示（单源） */
  onNotice(message: string): void;
}

/** PTY 草稿丢弃（释放 xterm 实例 + 清草稿；在途创建不取消，迟到成功仍登记） */
function discardPty(env: Pick<SessionDraftEnv, "drafts" | "manager">): void {
  const prev = env.drafts.getSnapshot();
  if (!prev) return;
  env.manager.dispose(prev.terminalId);
  env.drafts.discard();
}

/**
 * 互斥属主唯一安装点（issue #71 S4/S5）：一个动作内聚 cwd 解析（fromSession 会话 cwd 或 resolveCwd 按项目解析）、
 * 项目不存在提示、跨类草稿互斥替换（#65 反向替换缺失的根因修复）、replacedHint 单源（跨类替换也提示）。
 */
export function openSessionDraftAction(env: SessionDraftEnv, input: OpenSessionDraftInput): OpenDraftResult {
  const { store, drafts, manager, resolveCwd, onNotice } = env;
  // cwd 解析失败（项目不存在）统一提示并拒绝——不以任何隐式路径建草稿（3 份手抄归 1）
  let cwd: string | null;
  let projectId = input.projectId;
  if (input.fromSessionId) {
    const s = store.getSession(input.fromSessionId);
    cwd = s?.cwd ?? null;
    projectId = s?.projectId ?? null;
  } else {
    cwd = resolveCwd(input.projectId, input.cli);
  }
  if (!cwd) {
    onNotice("新建失败：项目不存在或已失效，请刷新项目列表后重试");
    return { ok: false, reason: "project-missing" };
  }
  // 互斥属主：全局任一时刻至多一个草稿，两类互相替换并给出提示
  const structured = store.getSnapshot().draft;
  const pty = drafts.getSnapshot();
  const replaced: "structured" | "pty" | null = structured ? "structured" : pty ? "pty" : null;
  if (input.cli === "pty") {
    if (structured) store.discardDraft();
    // pty→pty：释放旧草稿的 xterm 实例（在途创建不取消，迟到成功仍登记）
    if (pty) manager.dispose(pty.terminalId);
    drafts.open({
      projectId,
      cwd,
      ...(input.command ? { command: input.command } : {}),
      ...(input.requirementId ? { requirementId: input.requirementId } : {}),
      replacedHint: replaced !== null,
    });
  } else {
    // 结构化替换 PTY：PTY 草稿静默丢弃（含 xterm 释放）
    if (pty) discardPty(env);
    // 模型继承当前 composer 选定值：优先当前草稿（被替换的同类），其次当前激活会话（权限档位不继承，草稿内自选）
    const s = store.getSnapshot();
    const inheritFrom = structured ?? (s.activeId ? store.getSession(s.activeId) : undefined);
    store.openDraft({
      cli: input.cli,
      cwd,
      projectId,
      requirementId: input.requirementId,
      model: inheritFrom?.model,
      replacedHint: replaced !== null,
    });
  }
  return { ok: true, replaced };
}

/** 切会话 = 离开草稿：结构化丢弃（store.setActive 内聚）+ PTY 丢弃（含 xterm 释放），一行属主 */
export function switchToAction(env: Omit<SessionDraftEnv, "resolveCwd" | "onNotice">, sessionId: string): void {
  env.store.setActive(sessionId);
  discardPty(env);
}

/** 两类草稿齐丢（切项目 effect 单调用；不弹确认、输入不保留） */
export function discardAllDraftsAction(env: Omit<SessionDraftEnv, "resolveCwd" | "onNotice">): void {
  env.store.discardDraft();
  discardPty(env);
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
 * 会话控制器 hook（issue #71：store 与 PTY 草稿机制均为 seam 之后的实现细节）。
 * deps.demoCwd 为 Fake 演示草稿 cwd（App 层经 AppInfo 注入：Main 读 KANBAN_FAKE_DEMO_CWD、缺省用户主目录）；
 * 未注入（null/undefined）前不自举 boot 演示草稿，真实会话 cwd 一律来自已注册项目（deps.resolveCwd）。
 */
export function useChatController(transport: ChatTransport | null, deps: ChatControllerDeps): ChatController {
  const { resolveCwd, onNotice } = deps;
  const demoCwd = deps.demoCwd;
  // useState 初始化器保证每 hook 实例一个 store（渲染期可安全读取）
  const [store] = useState(() => new ChatStore());
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // PTY 草稿机制（issue #71 S3 吸收自 use-terminals）：草稿控制器与多路复用管理器为本 hook 实现细节
  // shortcut: drafts/manager 闭包直接捕获首帧 transport 与 store（App 经 useMemo 同步建桥、测试首帧给定，身份稳定；
  // 复查触发：若未来出现「挂载时 transport=null、之后才可用」的路径，需改回 ref/effect 同步）
  const [drafts] = useState(
    () =>
      new TerminalDraftController({
        invoke: (req) =>
          transport?.invoke(req) ??
          Promise.resolve({ ok: false, error: { code: "E_INTERNAL", message: "transport 不可用" } } satisfies IpcResult),
        onCreated: (ev) => {
          // #20：卡片建终端的自动关联由 Main 原子完成（session_linked 推送回流看板 store）；拒绝仅报告不阻断终端
          if (ev.ok.linked === false)
            termLog.error("终端创建后自动关联被拒绝", {
              sessionId: ev.terminalId,
              ...(ev.ok.reason ? { reason: ev.ok.reason } : {}),
            });
          store.registerSession({
            sessionId: ev.terminalId,
            cli: "pty",
            title: ev.ok.title ?? "终端",
            permMode: "auto",
            model: DEFAULT_MODEL,
            projectId: ev.opts.projectId,
            cwd: ev.opts.cwd,
            dirIdentity: ev.ok.dirIdentity ?? "none",
            worktreeName: ev.ok.worktreeName ?? null,
          });
          // 创建在途期间到达的输入补写（首输入已由 Main 在启动成功后重放，此处保持顺序补剩余）
          if (ev.remainder) void transport?.invoke({ channel: "terminal:write", terminalId: ev.terminalId, data: ev.remainder });
        },
        onFailed: (ev) => {
          termLog.error("终端创建失败", { terminalId: ev.terminalId, code: ev.code, message: ev.message });
        },
      }),
  );
  const ptyDraft = useSyncExternalStore(drafts.subscribe, drafts.getSnapshot);
  const [manager] = useState(
    () =>
      new TerminalManager({
        // #60：草稿态输入不直写通道（首输入触发创建、失败保留缓冲）；非草稿按原路径直写
        write: (terminalId, data) => {
          if (drafts.handleInput(terminalId, data)) return;
          void transport?.invoke({ channel: "terminal:write", terminalId, data });
        },
        resize: (terminalId, cols, rows) => {
          // 草稿无进程可 resize：仅记录尺寸，随创建请求携带
          if (drafts.recordSize(terminalId, cols, rows)) return;
          void transport?.invoke({ channel: "terminal:resize", terminalId, cols, rows });
        },
      }),
  );
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

  // terminal:event 订阅：data/横幅进 manager；started/exit 同步会话状态徽标（store 内部自用直调）
  useEffect(() => {
    if (!transport) return;
    return transport.onTerminalEvent((event) => {
      manager.handleEvent(event);
      if (event.type === "started") store.updateStatus(event.terminalId, "idle");
      else if (event.type === "exit") store.updateStatus(event.terminalId, "disconnected");
    });
  }, [transport, manager, store]);

  const killTerminal = useCallback(
    (terminalId: string) => {
      void transport?.invoke({ channel: "terminal:kill", terminalId });
    },
    [transport],
  );
  const terminals = useMemo(
    () => ({ manager, kill: killTerminal }),
    [manager, killTerminal],
  );

  // 稳定动作独立 useCallback：discardAllDrafts 不依赖 deps（resolveCwd/onNotice 随项目列表每帧可变），
  // ChatWorkspace 切项目 effect 依赖它——项目列表刷新不得触发丢弃（actions 随 deps 重建不影响本引用）
  const discardAllDrafts = useCallback(() => {
    discardAllDraftsAction({ store, drafts, manager });
  }, [store, drafts, manager]);

  const actions = useMemo<Omit<ChatControllerActions, "discardAllDrafts">>(() => {
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
      openSessionDraft: (input) => openSessionDraftAction({ store, drafts, manager, resolveCwd, onNotice }, input),
      submitDraft: async () => {
        if (!transport) return false;
        return submitDraftChain(store, transport);
      },
      updateDraft: (patch) => store.updateDraft(patch),
      clearDraftSubmitError: () => store.clearDraftSubmitError(),
      // 切会话 = 离开草稿：双丢弃内聚于 switchToAction（模块级可直测）
      switchTo: (sessionId) => switchToAction({ store, drafts, manager }, sessionId),
      clearError: (sessionId) => store.clearError(sessionId),
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
  }, [transport, store, resolveCwd, onNotice, drafts, manager]);

  const activeSession = snap.activeId ? (store.getSession(snap.activeId) ?? null) : null;
  // 草稿判别联合聚合：结构化与 PTY 两分支并一支（中央区路由单源）
  const draft: SessionDraft | null = snap.draft ? { kind: "structured", data: snap.draft } : ptyDraft ? { kind: "pty", data: ptyDraft } : null;

  // SessionRegistry 窄面（issue #71 S2）：外部写者经此登记/同步会话，不再直面 store
  const registry: SessionRegistry = {
    registerExternalSession: (meta) => store.registerSession(meta),
    updateExternalStatus: (id, status) => store.updateStatus(id, status),
    registerRestored: (row) => store.registerRestored(row),
  };

  return {
    ...actions,
    discardAllDrafts,
    ...registry,
    sessions: snap.sessions,
    activeSession,
    activeId: snap.activeId,
    version: snap.version,
    draft,
    terminals,
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
