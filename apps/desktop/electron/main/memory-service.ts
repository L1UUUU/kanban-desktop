// 用途：MemoryService（issue #31，spec #27 A 节）—— Main 进程内的 memory 深模块骨架：store 级动作全量（审核三动作/终态拒绝/resolveSummary/需求一次读/项目一次读含查询过滤/知识再编辑）+ extract/cancel 业务拒绝占位 + openMemoryService 启动对账装配；db 句柄与数据根目录经注入，需求关联会话/标题由 Main 查询后传入（memory 不依赖 tracker）
import { existsSync, readFileSync } from "node:fs";
import type { MemoryEventWire, MemorySummaryRow } from "@kanban/ipc-schema";
import {
  MemoryStore,
  SummaryStore,
  reconcileMemory,
  type MemoryBatchRecord,
  type MemoryCandidateRecord,
  type MemorySummaryRecord,
  type ReconcileReport,
  type ReviewAction,
  type SqliteDb,
} from "@kanban/memory";

/** 业务拒绝形状（wire memoryRejectionSchema 同构；reason 为自由字符串，不新增全局错误码） */
export interface MemoryRejectionResult {
  ok: false;
  reason: string;
  detail?: string;
}

/** reviewCandidate / editAccepted 成功形状 */
export interface CandidateResult {
  ok: true;
  candidate: MemoryCandidateRecord;
}

/** MemoryService 依赖注入 seam（可测）：db 句柄 + 数据根目录 + Main 侧 tracker 查询 + memory:event 推送 */
export interface MemoryServiceDeps {
  db: SqliteDb;
  /** Markdown 数据根（<userData>/memory，spec #27 D 节布局） */
  dataRoot: string;
  /** 需求当前关联 structured 会话（Main 查 tracker 后传入；PTY 会话不入提取范围，US2） */
  listLinkedStructuredSessions(requirementId: string): Array<{ sessionId: string; cli: string }>;
  /** 需求标题（Main 查 tracker 注入；记忆视图总结行标题与「标题+正文」搜索的标题字段） */
  getRequirementTitle(requirementId: string): string | null;
  /** memory:event 推送（批次状态/段进度；提取管线 S3-05 发，缺省丢弃供不需要推送的测试） */
  emitMemoryEvent?(event: MemoryEventWire): void;
}

export class MemoryService {
  readonly store: MemoryStore;
  readonly summaries: SummaryStore;
  private readonly deps: MemoryServiceDeps;

  constructor(deps: MemoryServiceDeps) {
    this.deps = deps;
    this.store = new MemoryStore(deps.db, deps.dataRoot);
    this.summaries = new SummaryStore(deps.db, deps.dataRoot);
  }

  // shortcut: extract/cancel 为业务拒绝占位（提取管线 S3-05/#32 接线后实现真实启动/取消）；复查触发条件 = issue #32 落地
  /**
   * 提取需求经验（US1 手动触发）。本票占位：真实管线 S3-05 接线，当前三种业务拒绝——
   * no-sessions（零关联 structured 会话）/ extraction-running（该需求已有 running 批次，US11 防重复触发）/
   * cli-unavailable（提取桥未接线，无法真实启动）。
   */
  extract(requirementId: string): MemoryRejectionResult | { ok: true; started: true; batchId: string } {
    const sessions = this.deps.listLinkedStructuredSessions(requirementId);
    if (sessions.length === 0) {
      return { ok: false, reason: "no-sessions", detail: "该需求当前没有关联的结构化会话，无历史可提取" };
    }
    if (this.hasRunningBatch(requirementId)) {
      return { ok: false, reason: "extraction-running", detail: "该需求已有进行中的提取批次，禁止重复触发" };
    }
    return { ok: false, reason: "cli-unavailable", detail: "提取管线尚未接入（S3-05），当前版本无法启动提取" };
  }

  // shortcut: cancel 占位同 extract；S3-05 实现终止临时进程 + 整批丢弃（cancelled）
  /** 取消进行中的提取（US9）。本票占位：无 running 批次 → no-extraction-running；有 → 占位拒绝（取消能力随提取管线）。 */
  cancel(requirementId: string): MemoryRejectionResult | { ok: true; cancelled: true } {
    if (!this.hasRunningBatch(requirementId)) {
      return { ok: false, reason: "no-extraction-running", detail: "该需求没有进行中的提取批次" };
    }
    return { ok: false, reason: "extraction-running", detail: "取消管线随提取实现（S3-05）接入，当前版本无法取消" };
  }

  /** 候选审核三动作（US16：仅 pending 可流转、终态拒绝；edit 仅 claim/scope、溯源只读） */
  reviewCandidate(
    candidateId: string,
    action: ReviewAction,
    edit?: { claim?: string; scope?: string },
  ): CandidateResult | MemoryRejectionResult {
    const current = this.store.getCandidate(candidateId);
    if (!current) return { ok: false, reason: "candidate-not-found", detail: `候选不存在：${candidateId}` };
    if (current.status !== "pending") {
      return {
        ok: false,
        reason: "candidate-final",
        detail: `候选 ${current.displayNo} 状态为 ${current.status}，终态不可再流转`,
      };
    }
    if (action === "edit" && !(edit?.claim?.trim() || edit?.scope?.trim())) {
      return { ok: false, reason: "edit-empty", detail: "编辑后接受需要 claim 或 scope 至少一项修改" };
    }
    return { ok: true, candidate: this.store.reviewCandidate(candidateId, action, edit) };
  }

  /** 总结 proposed 二选一处置（US14：accept-new 采纳新版 / keep-human 保留人工版；处置后暂存清除） */
  resolveSummary(requirementId: string, choice: "accept-new" | "keep-human"): MemoryRejectionResult | { ok: true } {
    const row = this.summaries.getSummary(requirementId);
    if (!row || row.proposedMdPath == null || row.proposedBatchId == null) {
      return { ok: false, reason: "no-proposed", detail: `需求 ${requirementId} 无未处置的 proposed 总结` };
    }
    this.summaries.resolveSummary(requirementId, choice);
    return { ok: true };
  }

  /** 详情面板一次读（US13/US18）：需求全部批次 + 跨批次全部候选 + 总结（无数据宽容返回空集） */
  requirementMemory(requirementId: string): {
    ok: true;
    batches: MemoryBatchRecord[];
    candidates: MemoryCandidateRecord[];
    summary: MemorySummaryRow | null;
  } {
    return {
      ok: true,
      batches: this.store.listBatches(requirementId),
      candidates: this.store.listRequirementCandidates(requirementId),
      summary: this.toSummaryWire(this.summaries.getSummary(requirementId)),
    };
  }

  /**
   * 记忆视图一次读（US20/US21）：项目已接受知识（accepted/edited，pending/ignored 不进）+ 总结行（含正文）；
   * 可选 query 大小写不敏感子串——知识匹配 claim（标题）与 scope/evidence（正文，取编辑后有效值），
   * 总结匹配需求标题（标题）与 summary.md 正文。
   */
  projectMemory(projectId: string, query?: string): {
    ok: true;
    knowledge: MemoryCandidateRecord[];
    summaries: MemorySummaryRow[];
  } {
    const q = query?.trim().toLowerCase() ?? "";
    const knowledge = this.store.listKnowledge(projectId).filter((k) => {
      if (!q) return true;
      const claim = k.editedClaim ?? k.claim;
      const scope = k.editedScope ?? k.scope;
      return [claim, scope, k.evidence].some((field) => field.toLowerCase().includes(q));
    });
    const summaries = this.summaries
      .listSummaries(projectId)
      .map((row) => this.toSummaryWire(row))
      .filter((s): s is MemorySummaryRow => s != null) // 库行必有 → wire 行非空（toSummaryWire 仅对 null 入参返回 null）
      .filter((s) => {
        if (!q) return true;
        return [s.title ?? "", s.content ?? ""].some((field) => field.toLowerCase().includes(q));
      });
    return { ok: true, knowledge, summaries };
  }

  /** 已接受知识再编辑（US21：claim/适用范围可再编辑、溯源不可变；pending/ignored 不是知识，拒绝） */
  editAccepted(candidateId: string, edit: { claim?: string; scope?: string }): CandidateResult | MemoryRejectionResult {
    const current = this.store.getCandidate(candidateId);
    if (!current) return { ok: false, reason: "candidate-not-found", detail: `候选不存在：${candidateId}` };
    if (current.status !== "accepted" && current.status !== "edited") {
      return {
        ok: false,
        reason: "candidate-not-editable",
        detail: `候选 ${current.displayNo} 状态为 ${current.status}，仅已接受知识可编辑（pending 请走审核 edit）`,
      };
    }
    return { ok: true, candidate: this.store.editAccepted(candidateId, edit) };
  }

  /** 该需求是否存在 running 批次（extract 防重复触发 / cancel 对象判定共用） */
  private hasRunningBatch(requirementId: string): boolean {
    return this.store.listBatches(requirementId).some((b) => b.status === "running");
  }

  /** 库行 → wire 总结行（补标题与正文：md 正文读取 + proposed 对比内容；文件缺失防御性返回 null） */
  private toSummaryWire(row: MemorySummaryRecord | null): MemorySummaryRow | null {
    if (!row) return null;
    return {
      requirementId: row.requirementId,
      projectId: row.projectId,
      mdPath: row.mdPath,
      proposedBatchId: row.proposedBatchId,
      proposedMdPath: row.proposedMdPath,
      updatedAt: row.updatedAt,
      title: this.deps.getRequirementTitle(row.requirementId),
      content: readTextIfExists(row.mdPath),
      proposedContent: row.proposedMdPath != null ? readTextIfExists(row.proposedMdPath) : null,
    };
  }
}

/** 读文本文件；不存在返回 null（启动修复前的中间态防御） */
function readTextIfExists(file: string): string | null {
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8");
}

/**
 * 打开库装配 memory 面（issue #31，spec #27 C 节）：先跑启动对账与修复四规则（running 批次→failed 等，
 * 复用 #30 reconcileMemory；崩溃窗口由此收敛、不锁死需求），再实例化 MemoryService。
 * index.ts 生产路径与测试的「重启模拟」共用本入口。
 */
export function openMemoryService(deps: MemoryServiceDeps): { service: MemoryService; report: ReconcileReport } {
  const report = reconcileMemory(deps.db, deps.dataRoot);
  return { service: new MemoryService(deps), report };
}
