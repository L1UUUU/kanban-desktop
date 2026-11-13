// 用途：IPC 请求/结果/错误码契约 —— 单通道 kanban:ipc + channel 判别（spec E/C4；错误码形状由 ipc-schema 定义，不变量 6；#17 起 kanban:* 七通道，spec #15 C 节）
import { z } from "zod";
import { approvalDecisionSchema, chatEventSchema, permModeSchema, sessionIdSchema, sessionStatusSchema } from "./chat";
import { cliKindSchema } from "./cli-kind";
import { commandEntrySchema } from "./commands";
import { kanbanStageInputSchema, requirementCardRowSchema } from "./kanban";
import { terminalCreatePayloadSchema, terminalIdSchema } from "./terminal";

// 首版错误码：E_SCHEMA 入站不合契约 / E_SESSION_NOT_FOUND 未知会话 / E_APPROVAL_EXPIRED 过期或已决审批 / E_PROJECT_NOT_FOUND 未知项目 / E_INTERNAL 兜底；#17 加 E_REQUIREMENT_NOT_FOUND 未知需求 id
// #46 加 E_SPAWN_NOT_FOUND：CLI exe 解析失败（spawn 失败）的协议级映射——Adapter 侧以 AdapterError 此码回传，renderer classify 归 spawn_not_found 卡（spec #40 B 节「SPAWN_NOT_FOUND（IPC 侧映射）」）
// #60 加 E_SESSION_EXISTS：terminal:create 携带的渲染端预生成终端 id 与既有会话行冲突（单一 id 空间保护，明确报错）
export const ERROR_CODES = [
  "E_SCHEMA",
  "E_SESSION_NOT_FOUND",
  "E_APPROVAL_EXPIRED",
  "E_PROJECT_NOT_FOUND",
  "E_REQUIREMENT_NOT_FOUND",
  "E_INTERNAL",
  "E_SPAWN_NOT_FOUND",
  "E_SESSION_EXISTS",
] as const;
export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

// 会话 CLI 枚举（#7 起放开三 CLI；fake 为 #6 演示链路；pty 会话不经 session:create 建）——定义已拆至 cli-kind.ts（跨域共用单源），此处 re-export 保持既有 import 面不变
export { cliKindSchema, type CliKind } from "./cli-kind";

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
  /** 创建时间（DB created_at 直读；#64 自动归档基准回落源、#86 启动自动选中「全部无活跃时间取最新创建」数据源） */
  createdAt: z.string().nullable(),
  /** #58 归档时间（NULL=未归档；默认列表恒 null，归档视图（session:archivedList）行必带） */
  archivedAt: z.string().nullable(),
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
    /** #17（spec #15 C 节）：创建成功后由 Main 原子落 link 事件（会话须与需求同项目，避免 renderer 两步编排竞态） */
    requirementId: z.string().min(1).optional(),
    /** #59（spec #57）：草稿提交携带的首条消息 —— Main 内原子完成「创建原生会话→落库→发送」；发送失败受控终止并回滚删除记录 */
    firstMessage: z.string().min(1).optional(),
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
  /** 会话中途切换模型（issue #79 / spec #75）：三 CLI 统一 idle 可切、下一轮生效；忙态/断开由 Main 侧校验拒绝 */
  z.object({
    channel: z.literal("session:setModel"),
    sessionId: sessionIdSchema,
    model: z.string().min(1),
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
  /** #58 归档：中断当前 turn → 受控终止单会话 → 写归档标记（幂等；结果行经 session:list/archivedList 查询） */
  z.object({ channel: z.literal("session:archive"), sessionId: sessionIdSchema }),
  /** #58 取消归档：先重新登记可恢复句柄（adopt）→ 成功才清标记并刷新活跃时间；失败留在归档态报错可重试 */
  z.object({ channel: z.literal("session:unarchive"), sessionId: sessionIdSchema }),
  /** #58 归档视图查询（设置面板用；wire 行含归档时间） */
  z.object({ channel: z.literal("session:archivedList") }),
  /** #62 删除（spec #57 D 节）：先解除看板关联（落 unlink 事件）→ 终止进程 → 删记录；幂等（记录不存在返回成功）；不删 CLI 原生历史 */
  z.object({ channel: z.literal("session:delete"), sessionId: sessionIdSchema }),
  /** #94 / ADR 0003 手动重命名：置 title_source=manual（终态权威，此后自动派生/摘要不再覆盖）；PTY 行不经此通道 */
  z.object({ channel: z.literal("session:rename"), sessionId: sessionIdSchema, title: z.string().min(1) }),
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
  // 看板通道（#17 spec #15 C 节：全部经 TrackerEngine.process 落事件流；link 业务拒绝是合法结果不走错误码）
  z.object({ channel: z.literal("kanban:list"), projectId: z.string().min(1).optional() }),
  z.object({
    channel: z.literal("kanban:create"),
    projectId: z.string().min(1),
    /** 缺省「待命名需求」（S2-09：初始标题可编辑） */
    title: z.string().min(1).optional(),
  }),
  z.object({ channel: z.literal("kanban:rename"), requirementId: z.string().min(1), title: z.string().min(1) }),
  z.object({ channel: z.literal("kanban:setStage"), requirementId: z.string().min(1), stage: kanbanStageInputSchema }),
  z.object({ channel: z.literal("kanban:link"), sessionId: sessionIdSchema, requirementId: z.string().min(1) }),
  z.object({ channel: z.literal("kanban:unlink"), sessionId: sessionIdSchema }),
  z.object({ channel: z.literal("kanban:delete"), requirementId: z.string().min(1) }),
  /** 斜杠命令列举（issue #89 / spec #82 E 块）：按 CLI 返回统一命令目录（claude skills / codex prompts 目录扫描 + opencode 原生 API；Main 侧短 TTL 缓存） */
  z.object({
    channel: z.literal("composer:listCommands"),
    cli: cliKindSchema,
    cwd: z.string().min(1),
  }),
  /** codex 斜杠命令客户端展开（issue #92 / spec #82 E 块派发）：读来源文件替换参数占位符返回普通文本（app-server 不解析 / 前缀；sourcePath 越出 prompts 目录或文件不可读 → E_INTERNAL fail-closed） */
  z.object({
    channel: z.literal("composer:expandCommand"),
    sourcePath: z.string().min(1),
    args: z.string(),
    /** 请求方 cwd（项目级 .codex/prompts 安全边界；Main 校验 sourcePath 必须位于用户级或该项目级 prompts 目录之下） */
    cwd: z.string().min(1),
  }),
]);
export type IpcRequest = z.infer<typeof ipcRequestSchema>;

// 错误结果：code + 可读 message（入站校验拒绝时 message 含 zod 摘要）；
// #59：rolledBackSessionId 仅 session:create+firstMessage 发送失败回滚时附带（渲染端撤销事件先至的占位会话行，不留空会话）
export const ipcErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: errorCodeSchema, message: z.string(), rolledBackSessionId: z.string().optional() }),
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
  /** session:create 附带（issue #76 / spec #75）：该会话实际采用的模型（codex=探测结果、opencode=显式或 /config 默认、fake/claude 透传；供调用方回显） */
  model: z.string().optional(),
  worktreeName: z.string().nullable().optional(),
  canceled: z.boolean().optional(),
  duplicate: z.boolean().optional(),
  project: projectRowSchema.optional(),
  projects: z.array(projectRowSchema).optional(),
  currentProjectId: z.string().nullable().optional(),
  sessions: z.array(sessionRowSchema).optional(),
  /** session:readHistory 附带：原生历史快照（ChatEvent 日志，与实时流同键同 seq） */
  events: z.array(chatEventSchema).optional(),
  /** #17 kanban:list 附带：需求卡片行数组（按 projectId 过滤后的终态视图） */
  requirements: z.array(requirementCardRowSchema).optional(),
  /** #17 kanban:list 附带：会话→需求反查映射（侧栏会话行徽标用） */
  sessionToReq: z.record(z.string(), z.string()).optional(),
  /** #17 kanban:link / session:create+requirementId 附带：关联结果（业务拒绝是合法结果） */
  linked: z.boolean().optional(),
  /** linked=false 时的拒绝原因（已关联他卡/跨项目/无项目会话，直达调用方） */
  reason: z.string().optional(),
  /** #17 kanban:create 附带：新建需求的确定性 id（详情面板即开即用） */
  requirementId: z.string().optional(),
  /** session:create（cli=claude）附带：项目级/用户级同名 skill 冲突名（#21 真实检测：项目 .claude/skills ∩ 用户级 skills；Codex/OpenCode 不带该字段） */
  skillConflicts: z.array(z.string()).optional(),
  /** composer:listCommands 附带（issue #89 / spec #82 E 块）：该 CLI 的统一命令目录（名称/描述/参数提示/来源/所属 CLI/来源文件路径/仅用户调用标记） */
  commands: z.array(commandEntrySchema).optional(),
  /** composer:expandCommand 附带（issue #92 / spec #82 E 块）：展开后普通文本（frontmatter 已剥离、占位符已替换） */
  text: z.string().optional(),
});
export type IpcOk = z.infer<typeof ipcOkSchema>;

export const ipcResultSchema = z.discriminatedUnion("ok", [ipcErrorSchema, ipcOkSchema]);
export type IpcResult = z.infer<typeof ipcResultSchema>;
