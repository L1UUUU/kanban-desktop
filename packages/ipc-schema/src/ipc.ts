// 用途：最小 IPC 请求/结果/错误码契约 —— 单通道 kanban:ipc + channel 判别（spec E/C4；错误码形状由 ipc-schema 定义，不变量 6）
import { z } from "zod";
import { approvalDecisionSchema, permModeSchema, sessionIdSchema } from "./chat";

// 首版错误码：E_SCHEMA 入站不合契约 / E_SESSION_NOT_FOUND 未知会话 / E_APPROVAL_EXPIRED 过期或已决审批 / E_INTERNAL 兜底
export const ERROR_CODES = ["E_SCHEMA", "E_SESSION_NOT_FOUND", "E_APPROVAL_EXPIRED", "E_INTERNAL"] as const;
export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

// 最小消息集：会话创建/发送/中断/审批决定（#6 cli 仅 fake；三 CLI 枚举随 #7/#9/#10 放开）
export const ipcRequestSchema = z.discriminatedUnion("channel", [
  z.object({
    channel: z.literal("session:create"),
    cli: z.literal("fake"),
    cwd: z.string().min(1),
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
]);
export type IpcRequest = z.infer<typeof ipcRequestSchema>;

// 错误结果：code + 可读 message（入站校验拒绝时 message 含 zod 摘要）
export const ipcErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: errorCodeSchema, message: z.string() }),
});
export type IpcError = z.infer<typeof ipcErrorSchema>;

// 成功结果：session:create 附会话元数据（renderer 据此登记会话列表），其余通道仅 ok（内容一律经事件流，不变量 1）
export const ipcOkSchema = z.object({
  ok: z.literal(true),
  sessionId: z.string().optional(),
  cli: z.string().optional(),
  title: z.string().optional(),
});
export type IpcOk = z.infer<typeof ipcOkSchema>;

export const ipcResultSchema = z.discriminatedUnion("ok", [ipcErrorSchema, ipcOkSchema]);
export type IpcResult = z.infer<typeof ipcResultSchema>;
