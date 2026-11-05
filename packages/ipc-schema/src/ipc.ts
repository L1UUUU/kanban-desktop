// 用途：IPC 请求/结果/错误码契约 —— 单通道 kanban:ipc + channel 判别（spec E/C4；错误码形状由 ipc-schema 定义，不变量 6）
import { z } from "zod";
import { approvalDecisionSchema, chatEventSchema, permModeSchema, sessionIdSchema, sessionStatusSchema } from "./chat";
import { terminalCreatePayloadSchema, terminalIdSchema } from "./terminal";

// 首版错误码：E_SCHEMA 入站不合契约 / E_SESSION_NOT_FOUND 未知会话 / E_APPROVAL_EXPIRED 过期或已决审批 / E_PROJECT_NOT_FOUND 未知项目 / E_INTERNAL 兜底
export const ERROR_CODES = [
  "E_SCHEMA",
  "E_SESSION_NOT_FOUND",
  "E_APPROVAL_EXPIRED",
  "E_PROJECT_NOT_FOUND",
  "E_INTERNAL",
] as const;
export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

// 会话 CLI 枚举（#7 起放开三 CLI；fake 为 #6 演示链路；pty 会话不经 session:create 建）
export const cliKindSchema = z.enum(["fake", "codex", "claude", "opencode"]);
export type CliKind = z.infer<typeof cliKindSchema>;

// projects 表 wire 行（C3：id/name/canonical_path/status/created_at）
export const projectRowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  canonicalPath: z.string().min(1),
  status: z.enum(["ok", "missing"]),
  createdAt: z.string().min(1),
});
export type ProjectRow = z.infer<typeof projectRowSchema>;

// sessions 表 wire 行（C3 列 + Main 侧判定的目录身份徽标数据）
export const sessionRowSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["structured", "pty"]),
  cli: z.string().min(1),
  nativeSessionId: z.string().nullable(),
  projectId: z.string().nullable(),
  title: z.string().nullable(),
  cwd: z.string().nullable(),
  permMode: permModeSchema.nullable(),
  status: sessionStatusSchema.nullable(),
  lastActiveAt: z.string().nullable(),
  /** 目录身份（spec I-3）：main=主仓库绿徽标 / worktree=蓝徽标（name 见 worktreeName）/ none=非 git 目录不渲染 */
  dirIdentity: z.enum(["main", "worktree", "none"]),
  worktreeName: z.string().nullable(),
});
export type SessionRow = z.infer<typeof sessionRowSchema>;

// 消息集：session CRUD（#6）+ project/session 持久化通道（#7）
export const ipcRequestSchema = z.discriminatedUnion("channel", [
  z.object({
    channel: z.literal("session:create"),
    cli: cliKindSchema,
    cwd: z.string().min(1),
    /** 新建会话挂靠的项目（缺省=无项目演示会话） */
    projectId: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    permMode: permModeSchema.optional(),
  }),
  z.object({
    channel: z.literal("session:send"),
    sessionId: sessionIdSchema,
    text: z.string().min(1),
  }),
  z.object({
    channel: z.literal("session:interrupt"),
    sessionId: sessionIdSchema,
  }),
  z.object({
    channel: z.literal("session:resolveApproval"),
    sessionId: sessionIdSchema,
    requestId: z.string().min(1),
    decision: approvalDecisionSchema,
  }),
  /** 断开会话「读取原生历史并恢复」：readHistory 快照（不变量 4，消息流恢复，缓存不替代原生历史） */
  z.object({ channel: z.literal("session:readHistory"), sessionId: sessionIdSchema }),
  /** 断开会话恢复续连：Adapter.resume 重连原生会话（真实 CLI 由 #8/#10/#11 实现，Fake 复位语义） */
  z.object({ channel: z.literal("session:resume"), sessionId: sessionIdSchema }),
  z.object({ channel: z.literal("session:list"), projectId: z.string().min(1).optional() }),
  z.object({ channel: z.literal("project:list") }),
  /** 注册项目：Main 弹原生目录选择对话框，路径归一化与去重在 Main 侧完成 */
  z.object({ channel: z.literal("project:register") }),
  z.object({ channel: z.literal("project:switch"), projectId: z.string().min(1) }),
  // PTY 终端通道（spec E：terminalApi × terminalId 参数化；spawn 在 terminal:create 内完成）
  terminalCreatePayloadSchema.extend({ channel: z.literal("terminal:create") }),
  z.object({ channel: z.literal("terminal:write"), terminalId: terminalIdSchema, data: z.string() }),
  z.object({
    channel: z.literal("terminal:resize"),
    terminalId: terminalIdSchema,
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  z.object({ channel: z.literal("terminal:kill"), terminalId: terminalIdSchema }),
]);
export type IpcRequest = z.infer<typeof ipcRequestSchema>;

// 错误结果：code + 可读 message（入站校验拒绝时 message 含 zod 摘要）
export const ipcErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: errorCodeSchema, message: z.string() }),
});
export type IpcError = z.infer<typeof ipcErrorSchema>;

// 成功结果：ok=true + 按 channel 的可选载荷（session:create 附会话元数据；project:register 取消时 canceled；列表通道附行数组）
export const ipcOkSchema = z.object({
  ok: z.literal(true),
  sessionId: z.string().optional(),
  cli: z.string().optional(),
  title: z.string().optional(),
  /** session:create 附带：新会话 cwd 的目录身份（徽标即时渲染依据） */
  dirIdentity: sessionRowSchema.shape.dirIdentity.optional(),
  worktreeName: z.string().nullable().optional(),
  canceled: z.boolean().optional(),
  duplicate: z.boolean().optional(),
  project: projectRowSchema.optional(),
  projects: z.array(projectRowSchema).optional(),
  currentProjectId: z.string().nullable().optional(),
  sessions: z.array(sessionRowSchema).optional(),
  /** session:readHistory 附带：原生历史快照（ChatEvent 日志，与实时流同键同 seq） */
  events: z.array(chatEventSchema).optional(),
});
export type IpcOk = z.infer<typeof ipcOkSchema>;

export const ipcResultSchema = z.discriminatedUnion("ok", [ipcErrorSchema, ipcOkSchema]);
export type IpcResult = z.infer<typeof ipcResultSchema>;
