// 用途：C1 AdapterEvent 的 ChatEvent 部分 zod 契约 —— spec B 13 成员冻结清单 + 合并键（itemId/partId）+ SkillObservation 形状（C2）
import { z } from "zod";

// 应用侧 session uuid（spec D：应用侧 id 为 PK，C1 全文 sessionId 统一指应用侧）
export const sessionIdSchema = z.string().min(1);

// 统一权限档位（产品语言：请求/自动/完全访问；Adapter 负责映射到各 CLI 原生机制）
export const permModeSchema = z.enum(["ask", "auto", "full"]);
export type PermMode = z.infer<typeof permModeSchema>;

// 统一审批决定枚举（spec B 审批映射表：allow-once/allow-always/deny）
export const approvalDecisionSchema = z.enum(["allow-once", "allow-always", "deny"]);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

// 会话活动状态（原型状态徽标五种）
export const sessionStatusSchema = z.enum(["idle", "running", "waiting", "interrupted", "disconnected"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

// 审批建议项（规则/目录，spec I-5：审批卡建议行）
export const approvalSuggestionSchema = z.object({
  kind: z.string().min(1),
  label: z.string(),
  detail: z.string(),
});
export type ApprovalSuggestion = z.infer<typeof approvalSuggestionSchema>;

// ChatEvent 公共底座：seq 为 session 内单调递增整数（快照/增量无缝拼接依据，不变量 3/4；不用时间戳）
const chatEventBase = z.object({
  sessionId: sessionIdSchema,
  seq: z.number().int().nonnegative(),
  at: z.string().min(1),
});

// ChatEvent 13 成员（spec B 冻结清单，discriminatedUnion on type）
export const chatEventSchema = z.discriminatedUnion("type", [
  chatEventBase.extend({ type: z.literal("turn_started"), turnId: z.string().min(1) }),
  chatEventBase.extend({
    type: z.literal("message_delta"),
    itemId: z.string().min(1),
    partId: z.string().min(1),
    delta: z.string(),
  }),
  chatEventBase.extend({ type: z.literal("message_completed"), itemId: z.string().min(1), partId: z.string().min(1) }),
  chatEventBase.extend({
    type: z.literal("tool_started"),
    itemId: z.string().min(1),
    tool: z.string().min(1),
    argsSummary: z.string(),
  }),
  chatEventBase.extend({ type: z.literal("tool_update"), itemId: z.string().min(1), outputDelta: z.string() }),
  chatEventBase.extend({
    type: z.literal("tool_completed"),
    itemId: z.string().min(1),
    status: z.enum(["completed", "denied", "interrupted"]),
    durationMs: z.number().int().nonnegative(),
    output: z.string(),
  }),
  chatEventBase.extend({
    type: z.literal("approval_requested"),
    requestId: z.string().min(1),
    itemId: z.string().min(1),
    command: z.string().min(1),
    suggestions: z.array(approvalSuggestionSchema),
  }),
  chatEventBase.extend({ type: z.literal("approval_expired"), requestId: z.string().min(1), reason: z.string() }),
  chatEventBase.extend({ type: z.literal("turn_completed") }),
  chatEventBase.extend({ type: z.literal("turn_interrupted"), reason: z.string().optional() }),
  chatEventBase.extend({ type: z.literal("session_status"), status: sessionStatusSchema }),
  chatEventBase.extend({ type: z.literal("session_error"), code: z.string().min(1), message: z.string() }),
  chatEventBase.extend({ type: z.literal("session_exit"), exitCode: z.number().int(), reason: z.string().optional() }),
]);
export type ChatEvent = z.infer<typeof chatEventSchema>;

/** Omit 在联合上不分布：经泛型 helper 逐成员 Omit，供事件生产方构造「待补底座」的事件体 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type ChatEventSeed = DistributiveOmit<ChatEvent, "sessionId" | "seq" | "at">;

// SkillObservation：沿用 poc-4 冻结形状（spec C2），#6 仅形状不消费
export const skillObservationSchema = z.object({
  eventId: z.string().min(1),
  kind: z.literal("skill"),
  sessionId: sessionIdSchema,
  cli: z.enum(["claude-code", "codex", "opencode"]),
  skill: z.string().min(1),
  stage: z.string().nullable(),
  requirementId: z.string().nullable(),
  occurredAt: z.string().min(1),
  receivedAt: z.string().min(1),
  seq: z.number().int().nullable(),
  evidenceLevel: z.enum(["verified", "self_reported", "simulated"]),
  source: z.string().min(1),
});
export type SkillObservation = z.infer<typeof skillObservationSchema>;

// AdapterEvent = ChatEvent ∪ SkillObservation（spec B）
export const adapterEventSchema = z.union([chatEventSchema, skillObservationSchema]);
export type AdapterEvent = z.infer<typeof adapterEventSchema>;
