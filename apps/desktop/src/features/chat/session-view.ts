// 用途：会话视图类型单源（issue #71 搭车：type-only 搬移自 chat-store）—— SessionView 及其条目/审批/恢复态类型，
// 供 chat/terminal/kanban/components 各渲染面共享；chat-store 过渡期 re-export 保持既有 import 不变
import type { ApprovalSuggestion, PermMode, SessionRow, SessionStatus } from "@kanban/ipc-schema";

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

export interface SessionView {
  sessionId: string;
  cli: string;
  title: string;
  status: SessionStatus;
  /** 权限档位为 renderer 本地会话状态；模型为创建时选定值（chip 切换），undefined = 未选择/未就绪（恢复会话：显示层派生默认名，issue #77） */
  permMode: PermMode;
  model: string | undefined;
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
