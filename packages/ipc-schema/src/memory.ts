// 用途：memory wire 契约（issue #31，spec #27 H 节）—— memory:ipc 七请求单通道联合 + 结果形状（业务拒绝 ok:false + reason，不新增全局错误码）+ memory:event 推送（批次状态与段进度），对齐 kanban:ipc 既有模式（Main 入站 zod 强制校验）
import { z } from "zod";

// 批次状态（与 @kanban/memory BatchStatus 对齐：running 进行中 / completed 完整产出 / failed 整批失败 / cancelled 用户取消）
export const memoryBatchStatusSchema = z.enum(["running", "completed", "failed", "cancelled"]);
export type MemoryBatchStatus = z.infer<typeof memoryBatchStatusSchema>;

// 候选状态（与 CandidateStatus 对齐：pending 待审 / accepted|edited|ignored 终态不可再流转）
export const memoryCandidateStatusSchema = z.enum(["pending", "accepted", "edited", "ignored"]);
export type MemoryCandidateStatus = z.infer<typeof memoryCandidateStatusSchema>;

// 审核动作（spec #27 G 节：接受（并存）/ 编辑后接受 / 忽略）
export const memoryReviewActionSchema = z.enum(["accept", "edit", "ignore"]);
export type MemoryReviewAction = z.infer<typeof memoryReviewActionSchema>;

// 总结 proposed 处置二选一（US14：采纳新版 / 保留人工版）
export const memorySummaryChoiceSchema = z.enum(["accept-new", "keep-human"]);
export type MemorySummaryChoice = z.infer<typeof memorySummaryChoiceSchema>;

// 批次缺失会话（PTY/读取失败会话明确列出原因不冒充完整，US3）
export const missingSessionSchema = z.object({
  sessionId: z.string().min(1),
  cli: z.string().min(1),
  reason: z.string().min(1),
});
export type MissingSessionWire = z.infer<typeof missingSessionSchema>;

// 相似提示项（与 @kanban/memory SimilarityNote 对齐：对方编号 + 三位小数相似度 + 类别，仅提示不阻断，US17）
export const similarityNoteSchema = z.object({
  displayNo: z.string().min(1),
  similarity: z.number().nonnegative(),
  kind: z.enum(["similar-to-accepted", "similar-to-ignored-check-correction"]),
});
export type SimilarityNoteWire = z.infer<typeof similarityNoteSchema>;

// 批次行（memory_batches 行投影；批次卡元信息：来源数/缺失/分段/模型调用次数/状态与时间，US12）
export const memoryBatchRowSchema = z.object({
  id: z.string().min(1),
  requirementId: z.string().min(1),
  projectId: z.string().min(1),
  status: memoryBatchStatusSchema,
  sourceSessionCount: z.number().int().nonnegative(),
  missingSessions: z.array(missingSessionSchema),
  chunkCount: z.number().int().nonnegative(),
  modelCallCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
  createdAt: z.string().min(1),
  finishedAt: z.string().nullable(),
});
export type MemoryBatchRow = z.infer<typeof memoryBatchRowSchema>;

// 候选行（memory_candidates 行投影；claim 正文/适用范围/证据摘录/来源会话/状态/冲突提示/md 复制路径，US15–18/US21）
export const memoryCandidateRowSchema = z.object({
  id: z.string().min(1),
  displayNo: z.string().min(1),
  batchId: z.string().min(1),
  requirementId: z.string().min(1),
  projectId: z.string().min(1),
  claim: z.string(),
  scope: z.string(),
  evidence: z.string(),
  sourceSessionIds: z.array(z.string().min(1)),
  status: memoryCandidateStatusSchema,
  editedClaim: z.string().nullable(),
  editedScope: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  conflicts: z.array(similarityNoteSchema),
  notes: z.array(similarityNoteSchema),
  mdPath: z.string().nullable(),
  createdAt: z.string().min(1),
});
export type MemoryCandidateRow = z.infer<typeof memoryCandidateRowSchema>;

// 总结行（记忆视图/详情一次读：mdPath 复制路径 + 正文内容 + proposed 对比内容 + 需求标题（搜索「标题+正文」的标题字段，Main 查 tracker 注入））
export const memorySummaryRowSchema = z.object({
  requirementId: z.string().min(1),
  projectId: z.string().min(1),
  mdPath: z.string().min(1),
  proposedBatchId: z.string().nullable(),
  proposedMdPath: z.string().nullable(),
  updatedAt: z.string().min(1),
  title: z.string().nullable(),
  content: z.string().nullable(),
  proposedContent: z.string().nullable(),
});
export type MemorySummaryRow = z.infer<typeof memorySummaryRowSchema>;

// memory:ipc 请求单通道七联合（对齐 kanban:ipc discriminatedUnion 模式；Main 入站强制校验）
export const memoryRequestSchema = z.discriminatedUnion("channel", [
  /** 提取需求经验（手动触发，US1）；本票占位拒绝，真实管线 S3-05 */
  z.object({ channel: z.literal("memory:extract"), requirementId: z.string().min(1) }),
  /** 取消进行中的提取（整批丢弃，US9）；本票占位拒绝 */
  z.object({ channel: z.literal("memory:cancel"), requirementId: z.string().min(1) }),
  /** 候选审核三动作（US16：接受并存/编辑后接受——仅 claim 与范围可编辑、溯源只读/忽略；终态拒绝） */
  z.object({
    channel: z.literal("memory:reviewCandidate"),
    candidateId: z.string().min(1),
    action: memoryReviewActionSchema,
    edit: z.object({ claim: z.string().min(1).optional(), scope: z.string().optional() }).optional(),
  }),
  /** 总结 proposed 二选一处置（US14：采纳新版/保留人工版；处置后暂存清除） */
  z.object({
    channel: z.literal("memory:resolveSummary"),
    requirementId: z.string().min(1),
    choice: memorySummaryChoiceSchema,
  }),
  /** 详情面板一次读：批次 + 跨批次全部候选 + 总结（US13/US18） */
  z.object({ channel: z.literal("memory:requirementMemory"), requirementId: z.string().min(1) }),
  /** 记忆视图一次读：项目已接受知识 + 总结（含正文，可选大小写不敏感子串查询，US20/US21） */
  z.object({ channel: z.literal("memory:projectMemory"), projectId: z.string().min(1), query: z.string().optional() }),
  /** 已接受知识再编辑（仅 claim/适用范围，溯源只读，US21；至少一项编辑） */
  z
    .object({
      channel: z.literal("memory:editAccepted"),
      candidateId: z.string().min(1),
      claim: z.string().min(1).optional(),
      scope: z.string().optional(),
    })
    .refine((v) => v.claim != null || v.scope != null, { message: "claim 与 scope 至少提供一项" }),
]);
export type MemoryRequest = z.infer<typeof memoryRequestSchema>;

// 业务拒绝：ok:false + reason 自由字符串（no-sessions/extraction-running/cli-unavailable/candidate-final/...，spec #27 H：不新增全局错误码）；detail 为可读补充
export const memoryRejectionSchema = z.object({
  ok: z.literal(false),
  reason: z.string().min(1),
  detail: z.string().optional(),
});
export type MemoryRejection = z.infer<typeof memoryRejectionSchema>;

// 成功结果：ok:true + 按通道的可选载荷（对齐 ipcOkSchema 模式）
export const memoryOkSchema = z.object({
  ok: z.literal(true),
  /** memory:extract：是否已启动新批次 */
  started: z.boolean().optional(),
  /** extract 启动成功时的批次 id */
  batchId: z.string().optional(),
  /** memory:cancel：是否已取消 */
  cancelled: z.boolean().optional(),
  /** memory:reviewCandidate / memory:editAccepted：处置后的候选行 */
  candidate: memoryCandidateRowSchema.optional(),
  /** memory:requirementMemory：需求全部批次（按创建序） */
  batches: z.array(memoryBatchRowSchema).optional(),
  /** memory:requirementMemory：跨批次全部候选（pending 累计 + 已处置，按创建序） */
  candidates: z.array(memoryCandidateRowSchema).optional(),
  /** memory:requirementMemory：需求总结行（无总结为 null） */
  summary: memorySummaryRowSchema.nullable().optional(),
  /** memory:projectMemory：项目已接受知识（编号序，查询过滤后） */
  knowledge: z.array(memoryCandidateRowSchema).optional(),
  /** memory:projectMemory：项目总结（更新时间序，查询过滤后） */
  summaries: z.array(memorySummaryRowSchema).optional(),
});
export type MemoryOk = z.infer<typeof memoryOkSchema>;

export const memoryResultSchema = z.discriminatedUnion("ok", [memoryRejectionSchema, memoryOkSchema]);
export type MemoryResult = z.infer<typeof memoryResultSchema>;

// memory:event 推送载荷（Main→renderer）：批次状态变更 + 段进度（US8 四步：读取历史→分段→逐段提取 i/n→合并写库）
export const memoryEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("batch-status"),
    batchId: z.string().min(1),
    requirementId: z.string().min(1),
    status: memoryBatchStatusSchema,
    /** failed 时的失败原因 */
    error: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal("chunk-progress"),
    batchId: z.string().min(1),
    requirementId: z.string().min(1),
    step: z.enum(["reading", "chunking", "extracting", "merging"]),
    /** extracting 步的当前段序（0 起）与总段数；其余步骤为 0 */
    chunkIndex: z.number().int().nonnegative(),
    chunkCount: z.number().int().nonnegative(),
  }),
]);
export type MemoryEventWire = z.infer<typeof memoryEventSchema>;

// 提取段输出契约（issue #32，spec #27 F 节）—— Claude headless stdout 的结构化输出 wire（外部 CLI 进程 → 提取管线的进程边界契约）：
// prompt 约束只输出单个 JSON 对象；类型宽松 + 缺省值（candidates 允许缺省为空——一段无候选是合法结果），
// 来源归属不在此校验（管线按段内会话强制 clamp）；校验失败由管线重试一次。
export const memorySegmentCandidateSchema = z.object({
  claim: z.string(),
  evidence: z.string().default(""),
  scope: z.string().default(""),
  sourceSessionIds: z.array(z.string()).default([]),
});
export type MemorySegmentCandidate = z.infer<typeof memorySegmentCandidateSchema>;

export const memorySegmentOutputSchema = z.object({
  summary: z.string(),
  candidates: z.array(memorySegmentCandidateSchema).default([]),
});
export type MemorySegmentOutput = z.infer<typeof memorySegmentOutputSchema>;
