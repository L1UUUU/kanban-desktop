// 用途：会话视图类型单源（issue #71 搬移自 chat-store；arch C6 判别联合）—— SessionView 及其条目/审批/恢复态类型与
// wire→view 单点转换，供 chat/terminal/kanban/components 各渲染面共享；chat-store 过渡期 re-export 保持既有 import 不变
import { cliKindSchema, type ApprovalSuggestion, type CliKind, type PermMode, type SessionRow, type SessionStatus } from "@kanban/ipc-schema";
import { createScopedLogger } from "../../lib/logger";

// 本文件日志出口（scope 固定 chat，经 lib/logger 唯一出口发出）
const log = createScopedLogger("chat");

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

/** 结构化 CLI 会话视图（fake/codex/claude/opencode）：模型/审批/消息流/恢复等结构化专属运行态齐备 */
export interface StructuredSessionView {
  kind: "structured";
  sessionId: string;
  cli: CliKind;
  title: string;
  status: SessionStatus;
  /** 权限档位为 renderer 本地会话状态；模型为创建时选定值（chip 切换），undefined = 未选择/未就绪（恢复会话：显示层派生默认名，issue #77） */
  permMode: PermMode;
  model: string | undefined;
  /** #79：模型切换已成功、下一轮起生效（composer「下一轮起生效」提示数据源；下一 turn_started 自动清除） */
  modelChangePending: boolean;
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

/** PTY 终端会话视图（窄语义）：无模型/审批/消息流/恢复等结构化专属字段——终端数据在 TerminalManager，状态由 started/exit 事件直写 */
export interface PtySessionView {
  kind: "pty";
  sessionId: string;
  title: string;
  status: SessionStatus;
  /** 会话挂靠项目（null=无项目；侧栏按当前项目过滤） */
  projectId: string | null;
  /** 终端工作目录与目录身份徽标数据（spec I-3） */
  cwd: string | null;
  dirIdentity: SessionRow["dirIdentity"];
  worktreeName: string | null;
}

/** 会话视图判别联合：结构化 CLI 会话与 PTY 终端两种形态由 kind 显式表达（消费方一律 kind 收窄，不得比较字符串 "pty"） */
export type SessionView = StructuredSessionView | PtySessionView;

/** wire cli 解析结果：PTY 终端行，或结构化行（携带经契约校验的 CliKind） */
export type WireCli = { kind: "pty" } | { kind: "structured"; cli: CliKind };

/**
 * wire cli（string，"pty" 为合法值）→ 视图判别：全 renderer 唯一的 "pty" 字符串判定点
 * （wire 层 cli 仍为 string 保持兼容；本函数之外一律以 kind 判别）。
 */
export function parseWireCli(cli: string): WireCli {
  if (cli === "pty") return { kind: "pty" };
  const parsed = cliKindSchema.safeParse(cli);
  // shortcut: 未识别值不可达（sessions 表 cli 由 Main 单源写五值枚举），回落 fake 保渲染不崩；复查：wire 侧 cli 枚举扩员时同步
  if (!parsed.success) {
    log.warn("wire cli 未识别，回落 fake 结构化行", { cli });
    return { kind: "structured", cli: "fake" };
  }
  return { kind: "structured", cli: parsed.data };
}

/** wire 登记数据（registerSession/registerRestored 两入口归一后的公共形状；status 为登记时初始状态） */
export interface WireSessionInit {
  sessionId: string;
  /** wire cli（string；"pty" 合法值，经 parseWireCli 单点判别） */
  cli: string;
  title: string;
  status: SessionStatus;
  permMode: PermMode;
  model: string | undefined;
  projectId: string | null;
  cwd: string | null;
  dirIdentity: SessionRow["dirIdentity"];
  worktreeName: string | null;
  skillConflicts: string[];
}

/** wire→view 单点转换：构造全新视图行（两登记入口共用；事件先至占位后的元数据回填由 store 原位更新路径处理） */
export function sessionViewFromWire(init: WireSessionInit): SessionView {
  const wire = parseWireCli(init.cli);
  const common = {
    sessionId: init.sessionId,
    title: init.title,
    status: init.status,
    projectId: init.projectId,
    cwd: init.cwd,
    dirIdentity: init.dirIdentity,
    worktreeName: init.worktreeName,
  };
  if (wire.kind === "pty") return { kind: "pty", ...common };
  return {
    kind: "structured",
    ...common,
    cli: wire.cli,
    permMode: init.permMode,
    model: init.model,
    modelChangePending: false,
    items: [],
    pendingApproval: null,
    lastTurnInterrupted: false,
    lastError: null,
    skillConflicts: init.skillConflicts,
    skillConflictDismissed: false,
    resumeState: { phase: "idle" },
  };
}
