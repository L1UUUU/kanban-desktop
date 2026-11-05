// 用途：聊天会话视图 store —— ChatEvent 按合并键归并成每会话 items（不变量 3/4 的 renderer 侧），useSyncExternalStore 兼容（快照引用稳定）
import type { ApprovalSuggestion, ChatEvent, PermMode, SessionRow, SessionStatus } from "@kanban/ipc-schema";

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
}

export interface ChatSnapshot {
  sessions: SessionView[];
  activeId: string | null;
  version: number;
}

let userItemSeq = 0;

export class ChatStore {
  private sessions = new Map<string, SessionView>();
  private activeId: string | null = null;
  private listeners = new Set<() => void>();
  private version = 0;
  private snapshot: ChatSnapshot | null = null;

  /** useSyncExternalStore 数据源：变更间引用稳定（箭头属性保证 this 绑定） */
  getSnapshot = (): ChatSnapshot => {
    if (!this.snapshot) {
      this.snapshot = { sessions: [...this.sessions.values()], activeId: this.activeId, version: this.version };
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
    });
    this.activeId = meta.sessionId;
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

  /** 用户已做出审批决定：卡片立即消失（决定即时生效；后续状态经事件流到达） */
  clearApproval(id: string): void {
    const s = this.sessions.get(id);
    if (s?.pendingApproval) {
      s.pendingApproval = null;
      this.changed();
    }
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
        for (const i of s.items) if (i.kind === "assistant") i.streaming = false;
        for (const i of s.items) if (i.kind === "tool" && i.status === "running") i.status = "interrupted";
        s.pendingApproval = null;
        s.lastTurnInterrupted = true;
        break;
      case "session_status":
        s.status = event.status;
        break;
      case "session_error":
        s.lastError = { code: event.code, message: event.message };
        s.pendingApproval = null;
        break;
      case "session_exit":
        // 会话退出：状态流转由 session_status 承载，这里不额外处理
        break;
    }
    this.changed();
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
