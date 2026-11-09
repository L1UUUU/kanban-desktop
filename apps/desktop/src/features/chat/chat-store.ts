// 用途：聊天会话视图 store —— ChatEvent 按合并键归并成每会话 items（不变量 3/4 的 renderer 侧），useSyncExternalStore 兼容（快照引用稳定）
import type { ApprovalSuggestion, ChatEvent, CliKind, PermMode, SessionRow, SessionStatus } from "@kanban/ipc-schema";

/** 用户消息条目（ChatEvent 无 user 成员：renderer 发送时本地回显） */
export interface UserItem {
  kind: "user";
  itemId: string;
  text: string;
}

/** 助手消息条目（按 itemId+partId 归并 delta；streaming 驱动光标） */
export interface AssistantItem {
  kind: "assistant";
  itemId: string;
  partId: string;
  text: string;
  streaming: boolean;
}

/** 工具卡片条目（按 itemId 归并 started/update/completed） */
export interface ToolItem {
  kind: "tool";
  itemId: string;
  tool: string;
  argsSummary: string;
  status: "running" | "completed" | "denied" | "interrupted";
  output: string;
  durationMs: number | null;
}

export type ChatItem = UserItem | AssistantItem | ToolItem;

export interface PendingApproval {
  requestId: string;
  command: string;
  suggestions: ApprovalSuggestion[];
}

/** #42 恢复引导条三态：idle=待恢复（无恢复进行）；resuming=恢复中（不可中断，D1）；failed=上次尝试失败（附 IPC 错误） */
export type ResumeState = { phase: "idle" } | { phase: "resuming" } | { phase: "failed"; code: string; message: string };

/** #46 会话创建失败记录（session:create 失败无会话视图可挂——挂侧栏创建入口卡；携带原参数供「重试创建」，spec #40 F1） */
export interface CreateFailure {
  cli: CliKind;
  code: string;
  message: string;
  cwd: string;
  projectId: string | null;
  title?: string;
  requirementId?: string;
}

export interface SessionView {
  sessionId: string;
  cli: string;
  title: string;
  status: SessionStatus;
  /** 权限档位/模型为 renderer 本地会话状态（createSession 传入；chip/select 切换） */
  permMode: PermMode;
  model: string;
  /** 会话挂靠项目（null=无项目演示会话；侧栏按当前项目过滤） */
  projectId: string | null;
  /** 会话工作目录与目录身份徽标数据（spec I-3） */
  cwd: string | null;
  dirIdentity: SessionRow["dirIdentity"];
  worktreeName: string | null;
  items: ChatItem[];
  pendingApproval: PendingApproval | null;
  /** 「本轮已取消」提示（turnnote）标记 */
  lastTurnInterrupted: boolean;
  lastError: { code: string; message: string } | null;
  /** #21：Claude 同名 skill 冲突名（session:create 响应附回；仅创建时检测一次，空数组=无冲突，非 claude 会话恒空） */
  skillConflicts: string[];
  /** #21：冲突提示条已关闭（关闭仅隐藏，不影响会话；再次创建会话重新出现） */
  skillConflictDismissed: boolean;
  /** #42：恢复引导条状态（banner 三态数据源；成功收敛由 resume 后实时 session_status 驱动复位） */
  resumeState: ResumeState;
}

export interface SessionMeta {
  sessionId: string;
  cli: string;
  title: string;
  permMode: PermMode;
  model: string;
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
  /** #46：最近一次会话创建失败（null=无；侧栏创建入口错误卡数据源） */
  createFailure: CreateFailure | null;
}

let userItemSeq = 0;

export class ChatStore {
  private sessions = new Map<string, SessionView>();
  private activeId: string | null = null;
  /** #46：最近一次会话创建失败（无会话视图可挂） */
  private createFailure: CreateFailure | null = null;
  private listeners = new Set<() => void>();
  private version = 0;
  private snapshot: ChatSnapshot | null = null;

  /** useSyncExternalStore 数据源：变更间引用稳定（箭头属性保证 this 绑定） */
  getSnapshot = (): ChatSnapshot => {
    if (!this.snapshot) {
      this.snapshot = {
        sessions: [...this.sessions.values()],
        activeId: this.activeId,
        version: this.version,
        createFailure: this.createFailure,
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
    this.sessions.set(meta.sessionId, {
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
      items: [],
      pendingApproval: null,
      lastTurnInterrupted: false,
      lastError: null,
      skillConflicts: meta.skillConflicts ?? [],
      skillConflictDismissed: false,
      resumeState: { phase: "idle" },
    });
    this.activeId = meta.sessionId;
    // #46：创建成功清除旧的创建失败卡（不残留）
    if (this.createFailure) this.createFailure = null;
    this.changed();
  }

  /** 重启恢复：按 DB 行登记历史会话（状态统一显示断开；不激活） */
  registerRestored(row: SessionRow): void {
    this.sessions.set(row.id, {
      sessionId: row.id,
      cli: row.cli,
      title: row.title ?? "历史会话",
      status: "disconnected",
      permMode: row.permMode ?? "auto",
      model: "默认模型",
      projectId: row.projectId,
      cwd: row.cwd,
      dirIdentity: row.dirIdentity,
      worktreeName: row.worktreeName,
      items: [],
      pendingApproval: null,
      lastTurnInterrupted: false,
      lastError: null,
      // #21：检测仅在创建时一次（spec E 节），重启恢复的历史会话不再检测
      skillConflicts: [],
      skillConflictDismissed: false,
      resumeState: { phase: "idle" },
    });
    this.changed();
  }

  setActive(id: string): void {
    if (!this.sessions.has(id) || this.activeId === id) return;
    this.activeId = id;
    this.changed();
  }

  /** 本地会话设置更新（权限档位/模型 chip） */
  updateSession(id: string, patch: Partial<Pick<SessionView, "permMode" | "model">>): void {
    const s = this.sessions.get(id);
    if (!s) return;
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
    if (!s) return;
    s.items = [];
    s.pendingApproval = null;
    s.lastTurnInterrupted = false;
    s.lastError = null;
    for (const e of events) {
      if (e.type === "session_status" || e.type === "session_error" || e.type === "session_exit") continue;
      this.applyEvent(e);
    }
  }

  /** 发送时本地回显用户消息（内容不经事件流回传，见不变量 1 的 renderer 侧补充） */
  appendUserMessage(id: string, text: string): void {
    const s = this.requireView(id);
    userItemSeq += 1;
    s.items.push({ kind: "user", itemId: `u-${userItemSeq}`, text });
    this.changed();
  }

  /** IPC 错误结果展示（如过期审批响应） */
  setError(id: string, code: string, message: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.lastError = { code, message };
    this.changed();
  }

  /** #46：清除会话错误（错误卡「知道了」动作：仅隐藏不影响会话） */
  clearError(id: string): void {
    const s = this.sessions.get(id);
    if (!s || !s.lastError) return;
    s.lastError = null;
    this.changed();
  }

  /** #46：记录会话创建失败（session:create IPC 错误；无会话视图可挂——侧栏创建入口错误卡数据源） */
  setCreateFailure(f: CreateFailure): void {
    this.createFailure = f;
    this.changed();
  }

  /** #46：清除创建失败记录（「知道了」或下次创建成功时） */
  clearCreateFailure(): void {
    if (!this.createFailure) return;
    this.createFailure = null;
    this.changed();
  }

  /** #42：恢复引导条进入「恢复中」（resume 发出后不可中断，D1） */
  markResuming(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.resumeState = { phase: "resuming" };
    this.changed();
  }

  /** #42：恢复引导条进入「失败」（readHistory/resume 的 IPC 错误，供重试与复制详情） */
  markResumeFailed(id: string, code: string, message: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.resumeState = { phase: "failed", code, message };
    this.changed();
  }

  /** 用户已做出审批决定：卡片立即消失（决定即时生效；后续状态经事件流到达） */
  clearApproval(id: string): void {
    const s = this.sessions.get(id);
    if (s?.pendingApproval) {
      s.pendingApproval = null;
      this.changed();
    }
  }

  /** #21：关闭同名 skill 冲突提示条（仅隐藏不影响会话；冲突名保留，再次创建会话重新出现） */
  dismissSkillConflict(id: string): void {
    const s = this.sessions.get(id);
    if (!s || s.skillConflictDismissed) return;
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
  private finalizeLiveItems(s: SessionView): void {
    for (const i of s.items) if (i.kind === "assistant") i.streaming = false;
    for (const i of s.items) if (i.kind === "tool" && i.status === "running") i.status = "interrupted";
  }

  private findTool(s: SessionView, itemId: string): ToolItem | undefined {
    return s.items.find((i): i is ToolItem => i.kind === "tool" && i.itemId === itemId);
  }

  private ensureView(sessionId: string): SessionView {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        sessionId,
        cli: "fake",
        title: "未知会话",
        status: "idle",
        permMode: "auto",
        model: "默认模型",
        projectId: null,
        cwd: null,
        dirIdentity: "none",
        worktreeName: null,
        items: [],
        pendingApproval: null,
        lastTurnInterrupted: false,
        lastError: null,
        skillConflicts: [],
        skillConflictDismissed: false,
        resumeState: { phase: "idle" },
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  private requireView(id: string): SessionView {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`会话未登记：${id}`);
    return s;
  }

  private changed(): void {
    this.version += 1;
    this.snapshot = null;
    for (const l of this.listeners) l();
  }
}
