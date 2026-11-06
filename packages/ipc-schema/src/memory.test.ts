// 用途：memory wire 契约测试 —— memory:ipc 七请求联合 + 结果形状（业务拒绝 reason 模式）+ memory:event 推送载荷（issue #31，spec #27 H 节）+ 提取段输出契约（#32，spec #27 F 节）
import { describe, expect, it } from "vitest";
import {
  memoryBatchRowSchema,
  memoryCandidateRowSchema,
  memoryEventSchema,
  memoryRequestSchema,
  memoryResultSchema,
  memorySegmentOutputSchema,
  memorySummaryRowSchema,
} from "./memory";

/** 最小合法批次行（行形状测试基线） */
const batchRow = {
  id: "b1",
  requirementId: "REQ-001",
  projectId: "P1",
  status: "completed",
  sourceSessionCount: 2,
  missingSessions: [{ sessionId: "s2", cli: "claude-code", reason: "PTY 会话无原生历史" }],
  chunkCount: 3,
  modelCallCount: 4,
  error: null,
  createdAt: "2026-11-06T00:00:00.000Z",
  finishedAt: "2026-11-06T00:01:00.000Z",
};

/** 最小合法候选行（行形状测试基线） */
const candidateRow = {
  id: "c1",
  displayNo: "CAND-0001",
  batchId: "b1",
  requirementId: "REQ-001",
  projectId: "P1",
  claim: "Windows 下 spawn 须直连 exe 不经 shell",
  scope: "桌面端 CLI 集成",
  evidence: "PoC 2 实测 MSYS 改写参数",
  sourceSessionIds: ["s1"],
  status: "pending",
  editedClaim: null,
  editedScope: null,
  reviewedAt: null,
  conflicts: [{ displayNo: "CAND-0002", similarity: 0.612, kind: "similar-to-accepted" }],
  notes: [],
  mdPath: null,
  createdAt: "2026-11-06T00:00:00.000Z",
};

/** 最小合法总结行（含正文与复制路径字段，记忆视图/对比查看用） */
const summaryRow = {
  requirementId: "REQ-001",
  projectId: "P1",
  mdPath: "C:\\data\\memory\\P1\\requirements\\REQ-001\\summary.md",
  proposedBatchId: null,
  proposedMdPath: null,
  updatedAt: "2026-11-06T00:00:00.000Z",
  title: "需求一",
  content: "# 总结正文",
  proposedContent: null,
};

describe("memory:ipc 八请求联合（Main 入站强制校验形状）", () => {
  it("八种请求的合法形状全部通过", () => {
    const reqs: unknown[] = [
      { channel: "memory:extract", requirementId: "REQ-001" },
      { channel: "memory:cancel", requirementId: "REQ-001" },
      { channel: "memory:reviewCandidate", candidateId: "c1", action: "accept" },
      {
        channel: "memory:reviewCandidate",
        candidateId: "c1",
        action: "edit",
        edit: { claim: "编辑后的 claim", scope: "编辑后的范围" },
      },
      { channel: "memory:reviewCandidate", candidateId: "c1", action: "ignore" },
      { channel: "memory:resolveSummary", requirementId: "REQ-001", choice: "accept-new" },
      { channel: "memory:resolveSummary", requirementId: "REQ-001", choice: "keep-human" },
      { channel: "memory:requirementMemory", requirementId: "REQ-001" },
      { channel: "memory:projectMemory", projectId: "P1" },
      { channel: "memory:projectMemory", projectId: "P1", query: "spawn" },
      { channel: "memory:editAccepted", candidateId: "c1", claim: "修订后的 claim" },
      { channel: "memory:editAccepted", candidateId: "c1", scope: "修订后的范围" },
      // 总结正文编辑（issue #38，spec #27 I-8/US13：requirementId + 完整正文，空白与否交 UI，非空下限在此守住）
      { channel: "memory:editSummary", requirementId: "REQ-001", content: "# 人工编辑后的总结正文" },
    ];
    for (const raw of reqs) {
      expect(memoryRequestSchema.safeParse(raw).success).toBe(true);
    }
  });

  it("非法请求被拒：未知通道 / 空标识 / 非法动作与选项", () => {
    const bad: unknown[] = [
      null,
      { channel: "memory:extract" }, // 缺 requirementId
      { channel: "memory:extract", requirementId: "" },
      { channel: "memory:nuke" },
      { channel: "memory:reviewCandidate", candidateId: "c1", action: "destroy" },
      { channel: "memory:resolveSummary", requirementId: "REQ-001", choice: "discard" },
      { channel: "memory:editAccepted", candidateId: "c1" }, // 至少一项编辑
      { channel: "memory:projectMemory" }, // 缺 projectId
      { channel: "memory:editSummary", requirementId: "REQ-001" }, // 缺正文
      { channel: "memory:editSummary", requirementId: "REQ-001", content: "" }, // 空正文
      { channel: "memory:editSummary", requirementId: "", content: "正文" }, // 空需求标识
    ];
    for (const raw of bad) {
      expect(memoryRequestSchema.safeParse(raw).success).toBe(false);
    }
  });
});

describe("memory wire 行形状", () => {
  it("批次行：四状态枚举合法、越界拒绝、缺失会话载荷形状校验", () => {
    for (const status of ["running", "completed", "failed", "cancelled"] as const) {
      expect(memoryBatchRowSchema.safeParse({ ...batchRow, status }).success).toBe(true);
    }
    expect(memoryBatchRowSchema.safeParse({ ...batchRow, status: "paused" }).success).toBe(false);
    expect(memoryBatchRowSchema.safeParse({ ...batchRow, missingSessions: [{ sessionId: "s" }] }).success).toBe(false);
  });

  it("候选行：四状态枚举合法、终态形状（edited 覆盖值 + md 路径 + 冲突提示）通过、越界拒绝", () => {
    for (const status of ["pending", "accepted", "edited", "ignored"] as const) {
      expect(memoryCandidateRowSchema.safeParse({ ...candidateRow, status }).success).toBe(true);
    }
    expect(
      memoryCandidateRowSchema.safeParse({
        ...candidateRow,
        status: "edited",
        editedClaim: "编辑后",
        editedScope: "范围",
        reviewedAt: "2026-11-06T00:02:00.000Z",
        mdPath: "C:\\data\\memory\\P1\\accepted\\CAND-0001.md",
        notes: [{ displayNo: "CAND-0003", similarity: 0.5, kind: "similar-to-ignored-check-correction" }],
      }).success,
    ).toBe(true);
    expect(memoryCandidateRowSchema.safeParse({ ...candidateRow, status: "deleted" }).success).toBe(false);
  });

  it("总结行：标题/正文/proposed 内容与路径字段（复制与对比查看所需）通过，缺字段拒绝", () => {
    expect(memorySummaryRowSchema.safeParse(summaryRow).success).toBe(true);
    expect(
      memorySummaryRowSchema.safeParse({
        ...summaryRow,
        proposedBatchId: "b2",
        proposedMdPath: "C:\\data\\memory\\P1\\requirements\\REQ-001\\summary.proposed.b2.md",
        proposedContent: "# 新版总结",
      }).success,
    ).toBe(true);
    // 标题允许 null（需求可能已被改名/删除后仍保留总结资产）；正文允许 null（md 文件缺失的防御形状）
    expect(memorySummaryRowSchema.safeParse({ ...summaryRow, title: null, content: null }).success).toBe(true);
    expect(memorySummaryRowSchema.safeParse({ ...summaryRow, mdPath: "" }).success).toBe(false);
  });
});

describe("memory:ipc 结果形状（业务拒绝 ok:false + reason，不新增全局错误码）", () => {
  it("业务拒绝：reason 必填（no-sessions / extraction-running / cli-unavailable 等自由字符串）", () => {
    const parsed = memoryResultSchema.parse({ ok: false, reason: "no-sessions", detail: "该需求没有关联的结构化会话" });
    expect(parsed.ok).toBe(false);
    expect(memoryResultSchema.safeParse({ ok: false }).success).toBe(false);
    expect(memoryResultSchema.safeParse({ ok: false, reason: "" }).success).toBe(false);
  });

  it("成功结果：extract 启动 / cancel / 审核与编辑回候选 / 需求一次读 / 项目一次读 / editSummary 无载荷确认 各载荷通过", () => {
    const cases: unknown[] = [
      { ok: true, started: true, batchId: "b1" },
      { ok: true, cancelled: true },
      { ok: true, candidate: candidateRow },
      { ok: true, batches: [batchRow], candidates: [candidateRow], summary: summaryRow },
      { ok: true, batches: [], candidates: [], summary: null },
      { ok: true, knowledge: [candidateRow], summaries: [summaryRow] },
      // memory:editSummary / memory:resolveSummary 成功形状：ok:true 无附加载荷（UI 成功后经一次读刷新）
      { ok: true },
    ];
    for (const raw of cases) {
      expect(memoryResultSchema.safeParse(raw).success).toBe(true);
    }
  });
});

describe("memory:event 推送载荷（批次状态与段进度）", () => {
  it("batch-status：四状态 + 可选失败原因通过，未知状态拒绝", () => {
    for (const status of ["running", "completed", "failed", "cancelled"] as const) {
      expect(
        memoryEventSchema.safeParse({ type: "batch-status", batchId: "b1", requirementId: "REQ-001", status }).success,
      ).toBe(true);
    }
    expect(
      memoryEventSchema.safeParse({
        type: "batch-status",
        batchId: "b1",
        requirementId: "REQ-001",
        status: "failed",
        error: "段输出校验失败",
      }).success,
    ).toBe(true);
    expect(
      memoryEventSchema.safeParse({ type: "batch-status", batchId: "b1", requirementId: "REQ-001", status: "paused" })
        .success,
    ).toBe(false);
  });

  it("chunk-progress：四步进度 + 段序 i/n 通过，未知步骤与非负整数约束拒绝", () => {
    for (const step of ["reading", "chunking", "extracting", "merging"] as const) {
      expect(
        memoryEventSchema.safeParse({
          type: "chunk-progress",
          batchId: "b1",
          requirementId: "REQ-001",
          step,
          chunkIndex: 0,
          chunkCount: 0,
        }).success,
      ).toBe(true);
    }
    expect(
      memoryEventSchema.safeParse({
        type: "chunk-progress",
        batchId: "b1",
        requirementId: "REQ-001",
        step: "extracting",
        chunkIndex: 2,
        chunkCount: 5,
      }).success,
    ).toBe(true);
    expect(
      memoryEventSchema.safeParse({ type: "chunk-progress", batchId: "b1", requirementId: "REQ-001", step: "waiting" })
        .success,
    ).toBe(false);
    expect(
      memoryEventSchema.safeParse({
        type: "chunk-progress",
        batchId: "b1",
        requirementId: "REQ-001",
        step: "extracting",
        chunkIndex: -1,
        chunkCount: 5,
      }).success,
    ).toBe(false);
  });
});

describe("memorySegmentOutputSchema：提取段输出契约（#32，spec #27 F 节）", () => {
  it("合法输出解析：summary + candidates 完整形状", () => {
    const r = memorySegmentOutputSchema.parse({
      summary: "段小结。",
      candidates: [{ claim: "规则甲", evidence: "依据", scope: "构建", sourceSessionIds: ["s1"] }],
    });
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0]).toMatchObject({ claim: "规则甲", evidence: "依据", scope: "构建", sourceSessionIds: ["s1"] });
  });

  it("宽松缺省：candidates 可缺省为空数组、evidence/scope/sourceSessionIds 缺省补空（一段无候选是合法结果）", () => {
    const r = memorySegmentOutputSchema.parse({ summary: "无候选段小结。" });
    expect(r).toEqual({ summary: "无候选段小结。", candidates: [] });
    const one = memorySegmentOutputSchema.parse({ summary: "s", candidates: [{ claim: "只有断言" }] });
    expect(one.candidates[0]).toMatchObject({ claim: "只有断言", evidence: "", scope: "", sourceSessionIds: [] });
  });

  it("类型不符拒绝（管线据此重试一次）：summary 非字符串 / candidates 非数组 / claim 非字符串", () => {
    expect(memorySegmentOutputSchema.safeParse({ summary: 123, candidates: [] }).success).toBe(false);
    expect(memorySegmentOutputSchema.safeParse({ summary: "s", candidates: "oops" }).success).toBe(false);
    expect(memorySegmentOutputSchema.safeParse({ summary: "s", candidates: [{ claim: 42 }] }).success).toBe(false);
  });
});
