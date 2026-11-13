// 用途：session:event 轻通道 main→renderer 推送契约（#95 / ADR 0003 决策 2 摘要段）—— 摘要标题异步完成后推送 renderer 刷新侧栏；独立于 ChatEvent（13 成员冻结 union 与 seq 单调不变量不动，main 合成事件无从取 seq）
import { z } from "zod";
import { sessionIdSchema } from "./chat";

/**
 * 会话级事件（当前仅 title：摘要完成后的新标题）。
 * 与 chat:event 的边界：ChatEvent 是 adapter 事件流的落库/回放事实源；本通道只承载
 * 「main 侧异步任务完成、DB 已更新」的通知，renderer 收到后本地刷新即可（无 seq、无落库）。
 */
export const sessionEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("title"), sessionId: sessionIdSchema, title: z.string().min(1) }),
]);
export type SessionEventWire = z.infer<typeof sessionEventSchema>;
