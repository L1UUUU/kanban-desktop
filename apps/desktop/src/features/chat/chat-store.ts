// 用途：聊天会话视图 store —— ChatEvent 按合并键归并成每会话 items（不变量 3/4 的 renderer 侧），useSyncExternalStore 兼容（快照引用稳定）；
// #59 起承载结构化会话草稿态，arch C8 起为草稿唯一属主：判别联合草稿（structured/pty）的替换、切会话/切项目丢弃、PTY 迟到登记的互斥判定全部内聚于此，
// PTY 草稿的缓冲/在途机制（TerminalDraftController）收编为 store 私有协作对象，外部写者只有 openDraft/openPtyDraft/discardAllDrafts 一类一个入口
// 行数评估（~640 行，超 500 行阈值）：主体是 applyEvent 的 ChatEvent 归并 switch（各 case 独立低交织），与会话登记/CRUD、草稿单属主域共享同一快照通知骨架
// （changed + 引用稳定 snapshot + 订阅），拆开只复制骨架不减耦合，本次不拆；触发条件：草稿域膨胀出独立面板状态或事件归并需要独立演进时按域拆分。
// issue #71 搭车：SessionView 族类型已 type-only 搬移 session-view.ts（单源），此处 re-export 保持既有 import 不变（过渡期）
// arch C6：SessionView 为判别联合（kind=structured/pty），wire→view 转换单点在 session-view.ts（parseWireCli/sessionViewFromWire）
import type { ChatEvent, CliKind, IpcRequest, IpcResult, PermMode, SessionRow, SessionStatus } from "@kanban/ipc-schema";
import { createScopedLogger } from "../../lib/logger";
import { TerminalDraftController, type OpenDraftOptions, type TerminalDraftCreated, type TerminalDraftSnapshot } from "../terminal/terminal-draft";
import type { AssistantItem, SessionView, StructuredSessionView, ToolItem } from "./session-view";
import { blankStructuredView, parseWireCli, sessionViewFromWire } from "./session-view";

export type {
  AssistantItem,
  ChatItem,
  PendingApproval,
  PtySessionView,
  ResumeState,
  SessionView,
  StructuredSessionView,
  ToolItem,
  UserItem,
} from "./session-view";

// PTY 草稿链路日志出口（scope terminal 保持过滤语义；arch C8 随迟到登记/失败留痕一并收编进 store）
const termLog = createScopedLogger("terminal");

/** #46 会话创建失败信息（session:create 失败的错误形状：错误卡数据源；#59 起由草稿 submitError 构造） */
export interface CreateFailure {
  cli: CliKind;
  code: string;
  message: string;
  cwd: string;
  projectId: string | null;
  title?: string;
  requirementId?: string;
}

/** #59 openDraft 入参（点「＋」选 CLI / 看板卡片建会话：cwd 必填，权限/模型可选继承） */
export interface DraftMeta {
  cli: CliKind;
  cwd: string;
  projectId?: string | null;
  /** 显式草稿名（仅 boot 演示草稿「演示会话 · Fake」传入；缺省占位名由显示层经 defaultSessionTitle 派生，arch C8 标题单源） */
  title?: string;
  permMode?: PermMode;
  model?: string;
  /** 看板卡片进入草稿的需求关联（随首条消息落到新会话） */
  requirementId?: string;
}

/** #59 结构化会话草稿（点「＋」后的中央区草稿态：不落库、不进侧栏、不启 CLI；发出首条消息才创建会话） */
export interface DraftSession {
  cli: CliKind;
  /** 显式草稿名（boot 演示）；undefined = 未命名，提示行占位名由显示层 defaultSessionTitle(cli) 即时派生 */
  title: string | undefined;
  cwd: string;
  projectId: string | null;
  /** 权限档位/模型：随首条消息一并下发（model undefined = 未选择/未就绪，就绪后由 combobox 默认选中） */
  permMode: PermMode;
  model: string | undefined;
  requirementId?: string;
  /** 首条消息输入（提交失败保留；丢弃草稿即失） */
  input: string;
  /** 本草稿替换过已有草稿（提示行显示「已替换上一个草稿」） */
  replacedHint: boolean;
  /** 首条消息提交失败（创建+发送原子链错误；null=无） */
  submitError: { code: string; message: string } | null;
}

/** 中央区草稿判别联合（issue #71 S4 / arch C8 单属主）：全局任一时刻至多一个，两类互相替换（ChatStore 为唯一写者） */
export type SessionDraft = { kind: "structured"; data: DraftSession } | { kind: "pty"; data: TerminalDraftSnapshot };

/** ChatStore 构造依赖（arch C8）：PTY 草稿机制的对外副作用单点注入；结构化草稿与会话归并不依赖 */
export interface ChatStoreDeps {
  /** IPC 出口（PTY 草稿 terminal:create 与创建成功后剩余输入补写） */
  invoke(req: IpcRequest): Promise<IpcResult>;
  /** 丢弃/替换 PTY 草稿时释放其 xterm 实例（TerminalManager.dispose；在途创建不取消，迟到成功仍登记） */
  disposeTerminal(terminalId: string): void;
}

export interface SessionMeta {
  sessionId: string;
  cli: string;
  title: string;
  permMode: PermMode;
  /** 模型：创建时选定值；省略/undefined = 未选择（PTY 终端/恢复会话等无模型路径，恢复 chip 显示层派生，issue #77） */
  model?: string | undefined;
  projectId?: string | null;
  cwd?: string | null;
  dirIdentity?: SessionRow["dirIdentity"];
  worktreeName?: string | null;
  /** #21：session:create 响应附回的同名 skill 冲突名（缺省无冲突） */
  skillConflicts?: string[];
}

export interface ChatSnapshot {
  sessions: SessionView[];
  activeId: string | null;
  version: number;
  /** 当前草稿（判别联合，arch C8 单属主；null=无；全局仅一个） */
  draft: SessionDraft | null;
}

let userItemSeq = 0;

export class ChatStore {
  private sessions = new Map<string, SessionView>();
  private activeId: string | null = null;
  /** #59：结构化会话草稿（与 PTY 草稿互斥，写入口保证全局至多一个；切会话/项目/重启丢弃） */
  private draft: DraftSession | null = null;
  /** PTY 草稿机制（arch C8 store 私有协作对象）：缓冲/在途/迟到结果机制为实现细节，外部经 store 写入口与 io 门闸触达 */
  private readonly pty: TerminalDraftController;
  private listeners = new Set<() => void>();
  private version = 0;
  private snapshot: ChatSnapshot | null = null;

  constructor(private readonly deps: ChatStoreDeps) {
    this.pty = new TerminalDraftController({
      invoke: (req) => this.deps.invoke(req),
      onCreated: (ev) => this.onPtyCreated(ev),
      onFailed: (ev) => termLog.error("终端创建失败", { terminalId: ev.terminalId, code: ev.code, message: ev.message }),
    });
    // 机制状态变化并入 store 快照通知（PTY 草稿数据经 ChatSnapshot.draft 单一出口）
    this.pty.subscribe(() => this.changed());
  }

  /** useSyncExternalStore 数据源：变更间引用稳定（箭头属性保证 this 绑定） */
  getSnapshot = (): ChatSnapshot => {
    if (!this.snapshot) {
      const pty = this.pty.getSnapshot();
      this.snapshot = {
        sessions: [...this.sessions.values()],
        activeId: this.activeId,
        version: this.version,
        // 草稿判别联合派生：结构化槽与 PTY 机制互斥（写入口保证至多一个非空），此处并作单一草稿
        draft: this.draft ? { kind: "structured", data: this.draft } : pty ? { kind: "pty", data: pty } : null,
      };
    }
    return this.snapshot;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSession(id: string): SessionView | undefined {
    return this.sessions.get(id);
  }

  registerSession(meta: SessionMeta): void {
    const wire = parseWireCli(meta.cli);
    const existing = this.sessions.get(meta.sessionId);
    // 事件先到（applyEvent 占位）后注册：保留事件已累积的运行态（status/items 等），仅回填元数据
    // （#59 起首条消息在 session:create 的 invoke 内即开始 turn，running 态可能早于注册到达）；
    // kind 不一致的重复登记不可达（PTY 行无事件占位路径），以新行覆盖
    if (existing && existing.kind === wire.kind) {
      existing.title = meta.title;
      existing.projectId = meta.projectId ?? null;
      existing.cwd = meta.cwd ?? existing.cwd;
      existing.dirIdentity = meta.dirIdentity ?? existing.dirIdentity;
      existing.worktreeName = meta.worktreeName ?? null;
      if (existing.kind === "structured" && wire.kind === "structured") {
        existing.cli = wire.cli;
        existing.permMode = meta.permMode;
        existing.model = meta.model;
        existing.modelChangePending = false; // #79：重登记即新会话语境，切换提示不跨登记残留
        existing.skillConflicts = meta.skillConflicts ?? [];
        existing.skillConflictDismissed = false;
      }
      this.activeId = meta.sessionId;
      this.changed();
      return;
    }
    this.sessions.set(
      meta.sessionId,
      sessionViewFromWire({
        sessionId: meta.sessionId,
        cli: meta.cli,
        title: meta.title,
        status: "idle",
        permMode: meta.permMode,
        model: meta.model,
        projectId: meta.projectId ?? null,
        cwd: meta.cwd ?? null,
        dirIdentity: meta.dirIdentity ?? "none",
        worktreeName: meta.worktreeName ?? null,
        skillConflicts: meta.skillConflicts ?? [],
      }),
    );
    this.activeId = meta.sessionId;
    this.changed();
  }

  /** 重启恢复：按 DB 行登记历史会话（状态统一显示断开；不激活） */
  registerRestored(row: SessionRow): void {
    this.sessions.set(
      row.id,
      sessionViewFromWire({
        sessionId: row.id,
        cli: row.cli,
        title: row.title ?? "历史会话",
        status: "disconnected",
        permMode: row.permMode ?? "auto",
        // DB 无 model 列：恢复会话模型为空（undefined），chip 显示由显示层派生默认名（不写 store，issue #77）
        model: undefined,
        projectId: row.projectId,
        cwd: row.cwd,
        dirIdentity: row.dirIdentity,
        worktreeName: row.worktreeName,
        // #21：检测仅在创建时一次（spec E 节），重启恢复的历史会话不再检测
        skillConflicts: [],
      }),
    );
    this.changed();
  }

  setActive(id: string): void {
    if (!this.sessions.has(id)) return;
    const wasActive = this.activeId === id;
    this.activeId = id;
    // #59/#60 切会话 = 离开草稿（两类齐丢、不弹确认、输入不保留；PTY 含 xterm 释放）——arch C8 内聚于 store 单点
    this.discardAllDrafts();
    if (!wasActive) this.changed(); // 激活变化必通知；点已激活行时仅草稿丢弃自身按需通知
  }

  /** issue #86 先手让位（项目维度）：切项目时激活会话若属其他项目则清除选中（回落空态，断开会话标题不跨项目残留） */
  clearActiveIfForeignProject(currentProjectId: string | null): void {
    if (this.activeId === null) return;
    const s = this.sessions.get(this.activeId);
    if (!s || (s.projectId ?? null) === currentProjectId) return;
    this.activeId = null;
    this.changed();
  }

  /**
   * #59 打开结构化草稿（arch C8 唯一写入口）：已有任一类草稿则替换（PTY 含 xterm 释放）并置 replacedHint
   * （跨类替换同样提示——「全局仅一个」的用户感知）。模型继承为视图编排策略（openSessionDraftAction
   * 计算后经 meta.model 传入），store 不做草稿内容默认值。返回被替换的草稿种类（null=无替换）。
   */
  openDraft(meta: DraftMeta): "structured" | "pty" | null {
    const prev = this.getSnapshot().draft;
    // PTY 草稿让位：释放 xterm 后丢弃（在途创建不取消，迟到成功仍登记）
    const pty = this.pty.getSnapshot();
    if (pty) {
      this.deps.disposeTerminal(pty.terminalId);
      this.pty.discard();
    }
    this.draft = {
      cli: meta.cli,
      title: meta.title,
      cwd: meta.cwd,
      projectId: meta.projectId ?? null,
      permMode: meta.permMode ?? "auto",
      model: meta.model,
      requirementId: meta.requirementId,
      input: "",
      replacedHint: prev !== null,
      submitError: null,
    };
    this.changed();
    return prev?.kind ?? null;
  }

  /**
   * #60 打开 PTY 终端草稿（arch C8 唯一写入口）：已有任一类草稿则替换（结构化静默丢弃；旧 PTY 含 xterm 释放），
   * 缓冲/首输入创建机制见 TerminalDraftController。返回被替换的草稿种类（null=无替换）。
   */
  openPtyDraft(opts: Omit<OpenDraftOptions, "replacedHint">): "structured" | "pty" | null {
    const prev = this.getSnapshot().draft;
    // pty→pty：释放旧草稿的 xterm 实例（在途创建不取消，迟到成功仍登记）
    const pty = this.pty.getSnapshot();
    if (pty) this.deps.disposeTerminal(pty.terminalId);
    // 结构化让位（静默；由 openDraft 的对向分支保证双向替换）
    const hadStructured = this.draft !== null;
    this.draft = null;
    this.pty.open({ ...opts, replacedHint: prev !== null });
    if (hadStructured) this.changed();
    return prev?.kind ?? null;
  }

  /** 两类草稿齐丢（切会话经 setActive / 切项目 effect 单调用；不弹确认、输入不保留；PTY 含 xterm 释放，在途创建不取消） */
  discardAllDrafts(): void {
    const hadStructured = this.draft !== null;
    this.draft = null;
    const pty = this.pty.getSnapshot();
    if (pty) {
      this.deps.disposeTerminal(pty.terminalId);
      this.pty.discard(); // 机制自身经订阅桥通知
    }
    if (hadStructured) this.changed();
  }

  /** #59：丢弃结构化草稿（提交成功后；PTY 草稿不受影响——互斥下两者不同时存在，提交在途被替换时天然 no-op） */
  discardDraft(): void {
    if (!this.draft) return;
    this.draft = null;
    this.changed();
  }

  /** #59：草稿本地编辑（首条消息输入/权限档位/模型） */
  updateDraft(patch: Partial<Pick<DraftSession, "input" | "permMode" | "model">>): void {
    if (!this.draft) return;
    Object.assign(this.draft, patch);
    this.changed();
  }

  /** #59：记录首条消息提交失败（创建+发送原子链错误；草稿与输入保留供重试） */
  setDraftSubmitError(code: string, message: string): void {
    if (!this.draft) return;
    this.draft.submitError = { code, message };
    this.changed();
  }

  /** #59：清除提交失败记录（失败卡「知道了」） */
  clearDraftSubmitError(): void {
    if (!this.draft?.submitError) return;
    this.draft.submitError = null;
    this.changed();
  }

  /** PTY 草稿态输入门闸（TerminalManager io.write 路由）：命中=进草稿缓冲不直写通道（首输入触发创建，失败保留缓冲） */
  handlePtyDraftInput(terminalId: string, data: string): boolean {
    return this.pty.handleInput(terminalId, data);
  }

  /** PTY 草稿面板尺寸记录（TerminalManager io.resize 路由；草稿无进程可 resize，创建请求携带最新尺寸） */
  recordPtyDraftSize(terminalId: string, cols: number, rows: number): boolean {
    return this.pty.recordSize(terminalId, cols, rows);
  }

  /** PTY 创建成功登记（含草稿已丢弃的迟到成功——Main 已落库，行仍须登记；arch C8 迟到登记单点） */
  private onPtyCreated(ev: TerminalDraftCreated): void {
    // #20：卡片建终端的自动关联由 Main 原子完成（session_linked 推送回流看板 store）；拒绝仅报告不阻断终端
    if (ev.ok.linked === false)
      termLog.error("终端创建后自动关联被拒绝", {
        sessionId: ev.terminalId,
        ...(ev.ok.reason ? { reason: ev.ok.reason } : {}),
      });
    this.registerSession({
      sessionId: ev.terminalId,
      cli: "pty",
      title: ev.ok.title ?? "终端",
      permMode: "auto",
      // PTY 无模型概念：model 保持 undefined（issue #77 清理，不写占位串）
      projectId: ev.opts.projectId,
      cwd: ev.opts.cwd,
      dirIdentity: ev.ok.dirIdentity ?? "none",
      worktreeName: ev.ok.worktreeName ?? null,
    });
    // 创建在途期间到达的输入补写（首输入已由 Main 在启动成功后重放，此处保持顺序补剩余）
    if (ev.remainder) void this.deps.invoke({ channel: "terminal:write", terminalId: ev.terminalId, data: ev.remainder });
  }

  /** #58/#62 移除会话行（归档/删除编排的 renderer 侧）：移除的是激活会话时切到排序中的下一条，无则上一条，全无则空态；
   *  #59 复用：session:create+firstMessage 发送失败回滚时撤销事件先至的占位行（不留空会话） */
  removeSession(id: string): void {
    if (!this.sessions.has(id)) return;
    const order = [...this.sessions.keys()];
    const ix = order.indexOf(id);
    this.sessions.delete(id);
    if (this.activeId === id) {
      this.activeId = order[ix + 1] ?? order[ix - 1] ?? null;
    }
    this.changed();
  }

  /** 本地会话设置更新（权限档位/模型 chip/标题（#94：派生与重命名标题的本地刷新出口）；modelChangePending 为 #79 切换成功标注，「下一轮起生效」提示数据源）。
   *  PTY 行直达此补丁不可达（重命名入口与摘要推送均为结构化专属，ADR 0003 PTY 豁免），kind 守卫不影响行为 */
  updateSession(id: string, patch: Partial<Pick<StructuredSessionView, "permMode" | "model" | "modelChangePending" | "title">>): void {
    const s = this.sessions.get(id);
    if (!s || s.kind !== "structured") return;
    Object.assign(s, patch);
    this.changed();
  }

  /** 会话状态直写（PTY 终端 started/exit 事件驱动，与 ChatEvent 路径并列） */
  updateStatus(id: string, status: SessionStatus): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.status = status;
    this.changed();
  }

  /**
   * 断开会话恢复（#9）：用 readHistory 快照重建消息流 items。
   * 复用 applyEvent 归并逻辑（与实时流同一合并键 → 快照后增量无缝拼接，不变量 4 的 renderer 侧）；
   * 状态类事件跳过：断开态由 resume 后的实时 session_status 驱动，不用历史状态冒充当前态。
   */
  applySnapshot(id: string, events: ChatEvent[]): void {
    const s = this.sessions.get(id);
    // PTY 无恢复路径（恢复引导条仅结构化会话渲染）——kind 守卫不影响行为
    if (!s || s.kind !== "structured") return;
    s.items = [];
    s.pendingApproval = null;
    s.lastTurnInterrupted = false;
    s.lastError = null;
    for (const e of events) {
      if (e.type === "session_status" || e.type === "session_error" || e.type === "session_exit") continue;
      this.applyEvent(e);
    }
  }

  /** 发送时本地回显用户消息（内容不经事件流回传，见不变量 1 的 renderer 侧补充；结构化会话专属路径——PTY 无消息流） */
  appendUserMessage(id: string, text: string): void {
    const s = this.requireStructuredView(id);
    userItemSeq += 1;
    s.items.push({ kind: "user", itemId: `u-${userItemSeq}`, text });
    this.changed();
  }

  /** IPC 错误结果展示（如过期审批响应；PTY 行无可渲染错误面——ChatPane 不渲染终端行，守卫不影响行为） */
  setError(id: string, code: string, message: string): void {
    const s = this.sessions.get(id);
    if (!s || s.kind !== "structured") return;
    s.lastError = { code, message };
    this.changed();
  }

  /** #46：清除会话错误（错误卡「知道了」动作：仅隐藏不影响会话） */
  clearError(id: string): void {
    const s = this.sessions.get(id);
    if (!s || s.kind !== "structured" || !s.lastError) return;
    s.lastError = null;
    this.changed();
  }

  /** #42：恢复引导条进入「恢复中」（resume 发出后不可中断，D1；结构化专属——PTY 无恢复路径） */
  markResuming(id: string): void {
    const s = this.sessions.get(id);
    if (!s || s.kind !== "structured") return;
    s.resumeState = { phase: "resuming" };
    this.changed();
  }

  /** #42：恢复引导条进入「失败」（readHistory/resume 的 IPC 错误，供重试与复制详情；结构化专属） */
  markResumeFailed(id: string, code: string, message: string): void {
    const s = this.sessions.get(id);
    if (!s || s.kind !== "structured") return;
    s.resumeState = { phase: "failed", code, message };
    this.changed();
  }

  /** 用户已做出审批决定：卡片立即消失（决定即时生效；后续状态经事件流到达；审批仅结构化会话产生） */
  clearApproval(id: string): void {
    const s = this.sessions.get(id);
    if (!s || s.kind !== "structured") return;
    if (s.pendingApproval) {
      s.pendingApproval = null;
      this.changed();
    }
  }

  /** #21：关闭同名 skill 冲突提示条（仅隐藏不影响会话；冲突名保留，再次创建会话重新出现；结构化专属） */
  dismissSkillConflict(id: string): void {
    const s = this.sessions.get(id);
    if (!s || s.kind !== "structured" || s.skillConflictDismissed) return;
    s.skillConflictDismissed = true;
    this.changed();
  }

  /** 核心归并：一条 ChatEvent 并入会话视图（未知会话自动建占位） */
  applyEvent(event: ChatEvent): void {
    const s = this.ensureView(event.sessionId);
    switch (event.type) {
      case "turn_started":
        // 清理上一 turn 残留（审批卡/取消提示/错误提示，原型 L230 同款）
        s.pendingApproval = null;
        s.lastTurnInterrupted = false;
        s.lastError = null;
        s.modelChangePending = false; // #79：新 turn 开始即切换已生效，「下一轮起生效」提示收起
        break;
      case "message_delta": {
        const existing = s.items.find(
          (i): i is AssistantItem => i.kind === "assistant" && i.itemId === event.itemId && i.partId === event.partId,
        );
        if (existing) {
          existing.text += event.delta;
          existing.streaming = true;
        } else {
          s.items.push({ kind: "assistant", itemId: event.itemId, partId: event.partId, text: event.delta, streaming: true });
        }
        break;
      }
      case "message_completed": {
        const target = s.items.find(
          (i): i is AssistantItem => i.kind === "assistant" && i.itemId === event.itemId && i.partId === event.partId,
        );
        // 光标保留到 turn 终结（原型行为：工具运行时段落仍有光标）；此处仅确保条目存在
        if (!target) {
          s.items.push({ kind: "assistant", itemId: event.itemId, partId: event.partId, text: "", streaming: true });
        }
        break;
      }
      case "tool_started":
        s.items.push({
          kind: "tool",
          itemId: event.itemId,
          tool: event.tool,
          argsSummary: event.argsSummary,
          status: "running",
          output: "",
          durationMs: null,
        });
        break;
      case "tool_update": {
        const tool = this.findTool(s, event.itemId);
        if (tool) tool.output += event.outputDelta;
        break;
      }
      case "tool_completed": {
        const tool = this.findTool(s, event.itemId);
        if (tool) {
          tool.status = event.status;
          tool.durationMs = event.durationMs;
          if (event.output) tool.output += `${tool.output ? "\n" : ""}${event.output}`;
        }
        break;
      }
      case "approval_requested":
        s.pendingApproval = { requestId: event.requestId, command: event.command, suggestions: event.suggestions };
        break;
      case "approval_expired":
        if (s.pendingApproval?.requestId === event.requestId) s.pendingApproval = null;
        break;
      case "turn_completed":
        for (const i of s.items) if (i.kind === "assistant") i.streaming = false;
        break;
      case "turn_interrupted":
        this.finalizeLiveItems(s);
        s.pendingApproval = null;
        s.lastTurnInterrupted = true;
        break;
      case "session_status":
        // 断开：终态化流式条目与运行中工具（不宣称运行中、不自动继续，spec H）——状态徽标与工具卡终态一致
        if (event.status === "disconnected") {
          this.finalizeLiveItems(s);
          s.pendingApproval = null;
        }
        s.status = event.status;
        // #42：状态实时回流即生命周期翻页——恢复引导条收敛复位（resume 成功 → idle；再断开 → 重新待恢复，不残留旧失败态）
        if (s.resumeState.phase !== "idle") s.resumeState = { phase: "idle" };
        break;
      case "session_error":
        s.lastError = { code: event.code, message: event.message };
        s.pendingApproval = null;
        break;
      case "session_exit":
        // CLI 进程退出（异常或退出治理）：终态化 + 明确报错（不崩溃、不自动重放，spec H）
        this.finalizeLiveItems(s);
        s.pendingApproval = null;
        if (!s.lastError) {
          s.lastError = {
            code: "E_SESSION_EXIT",
            message: `CLI 进程已退出（exit ${event.exitCode}${event.reason ? `：${event.reason}` : ""}），会话已断开`,
          };
        }
        break;
    }
    this.changed();
  }

  /** 流式/运行中条目终态化：助手停光标、运行中工具置 interrupted（中断中的工具调用不自动继续、不宣称运行中） */
  private finalizeLiveItems(s: StructuredSessionView): void {
    for (const i of s.items) if (i.kind === "assistant") i.streaming = false;
    for (const i of s.items) if (i.kind === "tool" && i.status === "running") i.status = "interrupted";
  }

  private findTool(s: StructuredSessionView, itemId: string): ToolItem | undefined {
    return s.items.find((i): i is ToolItem => i.kind === "tool" && i.itemId === itemId);
  }

  /** 事件先至占位（结构化专属路径：ChatEvent 仅来自结构化会话，终端事件走 updateStatus 直写）；
   *  已登记为 PTY 的 id 收到 ChatEvent 不可达，以结构化占位覆盖维持「事件总能归并」的不变量 */
  private ensureView(sessionId: string): StructuredSessionView {
    const existing = this.sessions.get(sessionId);
    if (existing?.kind === "structured") return existing;
    // 占位差异字段仅身份与「未知会话」标题，其余默认值走 blankStructuredView 单点（arch C8）
    const s = blankStructuredView({ sessionId, cli: "fake" });
    this.sessions.set(sessionId, s);
    return s;
  }

  /** 取结构化会话视图（缺失即抛；PTY 行无消息回显路径） */
  private requireStructuredView(id: string): StructuredSessionView {
    const s = this.sessions.get(id);
    if (!s || s.kind !== "structured") throw new Error(`会话未登记：${id}`);
    return s;
  }

  private changed(): void {
    this.version += 1;
    this.snapshot = null;
    for (const l of this.listeners) l();
  }
}
