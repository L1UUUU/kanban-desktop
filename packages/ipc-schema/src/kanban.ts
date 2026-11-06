// 用途：看板 wire 契约（#17 spec #15 C/D 节）—— 需求卡片行 + TrackerChange 推送载荷的 zod 形状；tracker 包 TS 联合（StageBasis/TrackerChange）的 renderer 侧镜像，renderer 不依赖 tracker 包，preload 转发类型经本包声明
import { z } from "zod";

// 看板阶段（与 tracker STAGES 对齐；stage=null 表示未开始，请求 wire 上用 "none" 字面量）
export const kanbanStageSchema = z.enum(["Design", "Implement", "PR", "Retro"]);
export type KanbanStage = z.infer<typeof kanbanStageSchema>;

// kanban:setStage 请求的阶段入参：四阶段 + none（未开始；uncertain 确认 = setStage 当前阶段）
export const kanbanStageInputSchema = z.enum(["Design", "Implement", "PR", "Retro", "none"]);
export type KanbanStageInput = z.infer<typeof kanbanStageInputSchema>;

// tracker CLI 名（与 tracker CLIS 一致：三真实 CLI + pty）
export const trackerCliSchema = z.enum(["claude-code", "codex", "opencode", "pty"]);

// 阶段依据（tracker StageBasis 的 zod 镜像）：skill 实际发生信号 或 用户手动修正；详情面板「当前依据展示」消费
export const stageBasisSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("skill"),
    skill: z.string().min(1),
    cli: trackerCliSchema,
    evidenceLevel: z.enum(["verified", "self_reported", "simulated"]),
    eventId: z.string().nullable(),
    at: z.string().min(1),
  }),
  z.object({
    kind: z.literal("manual"),
    eventId: z.string().min(1),
    at: z.string().min(1),
    source: z.string().nullable(),
  }),
]);
export type StageBasisWire = z.infer<typeof stageBasisSchema>;

// 需求卡片行（kanban:list 返回；tracker RequirementSnapshot 的 wire 形状）
export const requirementCardRowSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  stage: kanbanStageSchema.nullable(),
  stageBasis: stageBasisSchema.nullable(),
  uncertain: z.boolean(),
  projectId: z.string().nullable(),
  sessions: z.array(z.string().min(1)),
});
export type RequirementCardRow = z.infer<typeof requirementCardRowSchema>;

// TrackerChange 推送载荷（tracker 包 TrackerChange 六成员联合的 zod 镜像；Main→renderer tracker:event 通道转发，
// restore() 重放不产生推送，renderer 启动靠 kanban:list 再水化）
export const trackerChangeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("requirement_created"),
    requirementId: z.string().min(1),
    stage: kanbanStageSchema.nullable(),
    sessionId: z.string().nullable(), // 手动建卡无会话（#16 起可空）
  }),
  z.object({
    type: z.literal("stage_changed"),
    requirementId: z.string().min(1),
    stage: kanbanStageSchema.nullable(),
    basis: stageBasisSchema,
    uncertain: z.boolean(),
  }),
  z.object({
    type: z.literal("session_linked"),
    requirementId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal("session_unlinked"),
    requirementId: z.string().min(1),
    sessionId: z.string().min(1),
    stageKept: kanbanStageSchema.nullable(),
  }),
  z.object({
    type: z.literal("requirement_renamed"),
    requirementId: z.string().min(1),
    title: z.string().min(1),
  }),
  z.object({
    type: z.literal("requirement_deleted"),
    requirementId: z.string().min(1),
  }),
]);
export type TrackerChangeWire = z.infer<typeof trackerChangeSchema>;
