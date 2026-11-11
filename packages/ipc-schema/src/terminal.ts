// 用途：terminalApi wire 契约（spec E/C4）—— PTY 会话按 terminalId 多路复用；请求（create/write/resize/kill）并入 kanban:ipc 单通道，事件（started/data/exit/error）经 terminal:event 推送；载荷形状沿用旧 Kanban terminalApi（PoC 6 实证 0 diff 抽离）
import { z } from "zod";

// 应用侧终端会话 id（= sessions 表 PK，spec D：PTY 无 native session id，cli+native_session_id 可空）
export const terminalIdSchema = z.string().min(1);
export type TerminalId = z.infer<typeof terminalIdSchema>;

// 终端内直接执行的命令（如 claude 直接跑 TUI）：exe 为绝对路径或裸名（Main 侧经 config 覆盖/where 探测解析）
export const terminalCommandSchema = z.object({
  exe: z.string().min(1),
  args: z.array(z.string()).default([]),
});
export type TerminalCommand = z.infer<typeof terminalCommandSchema>;

// terminal:create 请求载荷（cwd 必填=终端工作目录；cols/rows 初始尺寸缺省 80×30）。
// #60（spec #57 PTY 草稿）：terminalId 由渲染端预生成（草稿在首输入触发创建时携带，Main 按 uuid 同格式校验保护单一 id 空间）；
// firstInput 为草稿期缓冲的首输入（含多字符/中文，Main 启动成功后重放，首输入不丢失）
export const terminalCreatePayloadSchema = z.object({
  terminalId: z.uuid(),
  cwd: z.string().min(1),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  command: terminalCommandSchema.optional(),
  projectId: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  /** #20（spec #15 C/D 节）：从需求卡片建 PTY 终端时创建成功后由 Main 原子落 link 事件（与 session:create+requirementId 同语义） */
  requirementId: z.string().min(1).optional(),
  /** #60：草稿首输入缓冲（创建成功后由 Main 写入 PTY） */
  firstInput: z.string().optional(),
});
export type TerminalCreatePayload = z.infer<typeof terminalCreatePayloadSchema>;

// terminal:event 推送载荷：四成员全部以 terminalId 为路由键；started/exit/error 字段形状与旧 Kanban 契约一致
export const terminalEventSchema = z.discriminatedUnion("type", [
  z.object({
    terminalId: terminalIdSchema,
    type: z.literal("started"),
    shell: z.string().min(1),
    cwd: z.string().min(1),
    pid: z.number().int().positive(),
  }),
  z.object({
    terminalId: terminalIdSchema,
    type: z.literal("data"),
    data: z.string(),
  }),
  z.object({
    terminalId: terminalIdSchema,
    type: z.literal("exit"),
    exitCode: z.number().int(),
    signal: z.number().int().optional(),
  }),
  z.object({
    terminalId: terminalIdSchema,
    type: z.literal("error"),
    message: z.string().min(1),
  }),
]);
export type TerminalEvent = z.infer<typeof terminalEventSchema>;
