// 用途：MemoryStore —— memory_batches 批次生命周期 + memory_candidates 候选追加/display_no 项目内递增/审核状态机（仅 pending 可流转、edit 仅 claim 与 scope、溯源不可变）+ Dice 冲突标注 + accepted md 双写序（Markdown 先写 temp+rename → SQLite 事务后提交）（spec #27 D/F/G 节，演进自 poc-5 review/store）
import { CONFLICT_THRESHOLD, diceSimilarity, type ExtractedCandidate } from "./similarity";
import { ensureMemoryTables, type SqliteDb } from "./ddl";
import { acceptedMdPath, renderAcceptedMd, writeAtomic } from "./markdown";

export type BatchStatus = "running" | "completed" | "failed" | "cancelled";
export type CandidateStatus = "pending" | "accepted" | "edited" | "ignored";
export type ReviewAction = "accept" | "edit" | "ignore";

/** 批次缺失会话（读取失败/PTY 无原生历史，明确列出原因不冒充完整） */
export interface MissingSession {
  sessionId: string;
  cli: string;
  reason: string;
}

/** 冲突/notes 提示项：对方编号 + 相似度 + 类别（仅提示不阻断，接受以并存落库） */
export interface SimilarityNote {
  displayNo: string;
  similarity: number;
  kind: "similar-to-accepted" | "similar-to-ignored-check-correction";
}

/** memory_batches 行投影 */
export interface MemoryBatchRecord {
  id: string;
  requirementId: string;
  projectId: string;
  status: BatchStatus;
  sourceSessionCount: number;
  missingSessions: MissingSession[];
  chunkCount: number;
  modelCallCount: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** memory_candidates 行投影 */
export interface MemoryCandidateRecord {
  id: string;
  displayNo: string;
  batchId: string;
  requirementId: string;
  projectId: string;
  claim: string;
  scope: string;
  evidence: string;
  sourceSessionIds: string[];
  status: CandidateStatus;
  editedClaim: string | null;
  editedScope: string | null;
  reviewedAt: string | null;
  conflicts: SimilarityNote[];
  notes: SimilarityNote[];
  mdPath: string | null;
  createdAt: string;
}

export class MemoryStore {
  private readonly db: SqliteDb;
  private readonly dataRoot: string;
  private readonly now: () => string;

  constructor(db: SqliteDb, dataRoot: string, opts?: { now?: () => string }) {
    this.db = db;
    this.dataRoot = dataRoot;
    ensureMemoryTables(db); // 幂等建三表（tracker Store 先例）
    this.now = opts?.now ?? (() => new Date().toISOString());
  }

  // ========== 批次（memory_batches） ==========

  /** 建批次（running）：提取开始时落行；sourceSessionCount 为触发时关联 structured 会话数 */
  createBatch(input: { id: string; requirementId: string; projectId: string; sourceSessionCount?: number }): MemoryBatchRecord {
    this.db
      .prepare(
        `INSERT INTO memory_batches (id, requirement_id, project_id, status, source_session_count, created_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(input.id, input.requirementId, input.projectId, "running", input.sourceSessionCount ?? 0, this.now());
    return this.getBatchOrThrow(input.id);
  }

  /** 批次过程元数据更新（提取中发现缺失会话/分段数/模型调用次数） */
  updateBatch(id: string, patch: { sourceSessionCount?: number; missingSessions?: MissingSession[]; chunkCount?: number; modelCallCount?: number }): void {
    const r = this.db
      .prepare(
        `UPDATE memory_batches SET
           source_session_count = COALESCE(?, source_session_count),
           missing_sessions_json = COALESCE(?, missing_sessions_json),
           chunk_count = COALESCE(?, chunk_count),
           model_call_count = COALESCE(?, model_call_count)
         WHERE id = ?`,
      )
      .run(
        patch.sourceSessionCount ?? null,
        patch.missingSessions ? JSON.stringify(patch.missingSessions) : null,
        patch.chunkCount ?? null,
        patch.modelCallCount ?? null,
        id,
      );
    if (r.changes === 0) throw new Error(`批次不存在: ${id}`);
  }

  /** 批次收尾（completed/failed/cancelled）：写终态与 finished_at */
  finishBatch(id: string, result: { status: "completed" | "failed" | "cancelled"; error?: string }): void {
    const r = this.db
      .prepare("UPDATE memory_batches SET status = ?, error = ?, finished_at = ? WHERE id = ?")
      .run(result.status, result.error ?? null, this.now(), id);
    if (r.changes === 0) throw new Error(`批次不存在: ${id}`);
  }

  getBatch(id: string): MemoryBatchRecord | null {
    const row = this.db.prepare("SELECT * FROM memory_batches WHERE id = ?").get(id) as BatchRow | undefined;
    return row ? rowToBatch(row) : null;
  }

  /** 需求全部批次（按创建序） */
  listBatches(requirementId: string): MemoryBatchRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM memory_batches WHERE requirement_id = ? ORDER BY created_at, rowid")
      .all(requirementId) as unknown as BatchRow[];
    return rows.map(rowToBatch);
  }

  private getBatchOrThrow(id: string): MemoryBatchRecord {
    const b = this.getBatch(id);
    if (!b) throw new Error(`批次不存在: ${id}`);
    return b;
  }

  // ========== 候选（memory_candidates） ==========

  /**
   * 批次候选落库：display_no 项目内递增分配 + 对既有知识跑冲突检测（accepted/edited 标 conflicts、
   * ignored 标 notes，基准 edited ?? 原值，阈值 CONFLICT_THRESHOLD，仅标注不阻断），单事务提交。
   */
  appendCandidates(batchId: string, candidates: ExtractedCandidate[]): MemoryCandidateRecord[] {
    const batch = this.getBatchOrThrow(batchId);
    const formal = this.listKnowledge(batch.projectId);
    const ignoredRows = this.db
      .prepare("SELECT * FROM memory_candidates WHERE project_id = ? AND status = 'ignored'")
      .all(batch.projectId) as unknown as CandidateRow[];
    const ignored = ignoredRows.map(rowToCandidate);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      let seq = this.maxDisplayNo(batch.projectId);
      const created: MemoryCandidateRecord[] = [];
      for (const cand of candidates) {
        const displayNo = `CAND-${String(++seq).padStart(4, "0")}`;
        const id = crypto.randomUUID();
        const conflicts = formal
          .filter((f) => diceSimilarity(cand.claim, f.editedClaim ?? f.claim) >= CONFLICT_THRESHOLD)
          .map((f) => noteOf(f, "similar-to-accepted", cand.claim));
        const notes = ignored
          .filter((g) => diceSimilarity(cand.claim, g.editedClaim ?? g.claim) >= CONFLICT_THRESHOLD)
          .map((g) => noteOf(g, "similar-to-ignored-check-correction", cand.claim));
        this.db
          .prepare(
            `INSERT INTO memory_candidates
             (id, display_no, batch_id, requirement_id, project_id, claim, scope, evidence, source_session_ids_json,
              status, edited_claim, edited_scope, reviewed_at, conflicts_json, notes_json, md_path, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,'pending',NULL,NULL,NULL,?,?,NULL,?)`,
          )
          .run(
            id, displayNo, batchId, batch.requirementId, batch.projectId,
            cand.claim, cand.scope, cand.evidence, JSON.stringify(cand.sourceSessionIds),
            JSON.stringify(conflicts), JSON.stringify(notes), this.now(),
          );
        created.push({
          id, displayNo, batchId, requirementId: batch.requirementId, projectId: batch.projectId,
          claim: cand.claim, scope: cand.scope, evidence: cand.evidence, sourceSessionIds: cand.sourceSessionIds,
          status: "pending", editedClaim: null, editedScope: null, reviewedAt: null,
          conflicts, notes, mdPath: null, createdAt: this.now(),
        });
      }
      this.db.exec("COMMIT");
      return created;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * 审核动作（状态机，spec #27 G 节）：仅 pending 可流转，终态不可再改；
   * accept/edit 走双写序——先写 accepted/CAND-xxxx.md（temp+rename）→ SQLite 事务后提交；
   * edit 仅 claim 与 scope（溯源不可变），忽略/接受不改溯源字段。
   */
  reviewCandidate(id: string, action: ReviewAction, edit?: { claim?: string; scope?: string }): MemoryCandidateRecord {
    const current = this.getCandidate(id);
    if (!current) throw new Error(`候选不存在: ${id}`);
    if (current.status !== "pending") {
      throw new Error(`候选 ${current.displayNo} 状态为 ${current.status}，仅 pending 可审核（终态不可覆盖）`);
    }
    if (action === "ignore") {
      this.db.prepare("UPDATE memory_candidates SET status = 'ignored', reviewed_at = ? WHERE id = ?").run(this.now(), id);
    } else if (action === "accept" || action === "edit") {
      let editedClaim: string | null = null;
      let editedScope: string | null = null;
      if (action === "edit") {
        editedClaim = edit?.claim?.trim() || null;
        editedScope = edit?.scope?.trim() || null;
        if (editedClaim == null && editedScope == null) {
          throw new Error("edit 需要 claim 或 scope 至少一项修改");
        }
      }
      const next: MemoryCandidateRecord = {
        ...current,
        status: action === "accept" ? "accepted" : "edited",
        editedClaim, editedScope, reviewedAt: this.now(),
      };
      // 双写序：Markdown 先写（temp+rename 原子）→ SQLite 事务后提交；崩溃窗口由启动修复收敛（孤儿 md 清理）
      const mdPath = acceptedMdPath(this.dataRoot, current.projectId, current.displayNo);
      writeAtomic(mdPath, renderAcceptedMd(next));
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare("UPDATE memory_candidates SET status = ?, edited_claim = ?, edited_scope = ?, reviewed_at = ?, md_path = ? WHERE id = ?")
          .run(next.status, editedClaim, editedScope, next.reviewedAt, mdPath, id);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    } else {
      const exhaustive: never = action; // 联合已全覆盖，运行时兜底（wire 层终态保护外的 store 层断言）
      throw new Error(`未知审核动作: ${String(exhaustive)}`);
    }
    return this.getCandidateOrThrow(id);
  }

  getCandidate(id: string): MemoryCandidateRecord | null {
    const row = this.db.prepare("SELECT * FROM memory_candidates WHERE id = ?").get(id) as CandidateRow | undefined;
    return row ? rowToCandidate(row) : null;
  }

  /** 项目内正式知识（accepted/edited，按编号序）—— 记忆视图与冲突基准共用 */
  listKnowledge(projectId: string): MemoryCandidateRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM memory_candidates WHERE project_id = ? AND status IN ('accepted','edited') ORDER BY display_no")
      .all(projectId) as unknown as CandidateRow[];
    return rows.map(rowToCandidate);
  }

  /** 需求全部候选（跨批次，按创建序）—— 详情面板 requirementMemory 一次读（US18：pending 跨批次累计 + 已处置按批次折叠共用同一数据源） */
  listRequirementCandidates(requirementId: string): MemoryCandidateRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM memory_candidates WHERE requirement_id = ? ORDER BY created_at, rowid")
      .all(requirementId) as unknown as CandidateRow[];
    return rows.map(rowToCandidate);
  }

  /**
   * 已接受知识再编辑（issue #31，US21：claim/适用范围可再编辑、溯源不可变）：仅 accepted/edited 可编辑；
   * 传入字段覆盖 edited 值（未提供保持既有），md 重写（双写序：Markdown 先写 → SQLite 事务后提交），
   * reviewed_at 保留原审核时间（再编辑不是审核）。
   */
  editAccepted(id: string, edit: { claim?: string; scope?: string }): MemoryCandidateRecord {
    const current = this.getCandidate(id);
    if (!current) throw new Error(`候选不存在: ${id}`);
    if (current.status !== "accepted" && current.status !== "edited") {
      throw new Error(`候选 ${current.displayNo} 状态为 ${current.status}，仅 accepted/edited 知识可再编辑`);
    }
    if (edit.claim == null && edit.scope == null) {
      throw new Error("editAccepted 需要 claim 或 scope 至少一项修改");
    }
    const next: MemoryCandidateRecord = {
      ...current,
      editedClaim: edit.claim != null ? edit.claim.trim() : current.editedClaim,
      editedScope: edit.scope != null ? edit.scope.trim() : current.editedScope,
    };
    const mdPath = current.mdPath ?? acceptedMdPath(this.dataRoot, current.projectId, current.displayNo);
    writeAtomic(mdPath, renderAcceptedMd(next));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE memory_candidates SET edited_claim = ?, edited_scope = ?, md_path = ? WHERE id = ?")
        .run(next.editedClaim, next.editedScope, mdPath, id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.getCandidateOrThrow(id);
  }

  private getCandidateOrThrow(id: string): MemoryCandidateRecord {
    const c = this.getCandidate(id);
    if (!c) throw new Error(`候选不存在: ${id}`);
    return c;
  }

  /** 项目内当前最大编号（CAND-xxxx 数值），无候选时为 0 */
  private maxDisplayNo(projectId: string): number {
    const rows = this.db
      .prepare("SELECT display_no FROM memory_candidates WHERE project_id = ?")
      .all(projectId) as unknown as Array<{ display_no: string }>;
    return rows.reduce((m, r) => Math.max(m, Number(/CAND-(\d+)/.exec(r.display_no)?.[1] ?? 0)), 0);
  }
}

// ========== 行投影与映射（内部） ==========

interface BatchRow {
  id: string;
  requirement_id: string;
  project_id: string;
  status: string;
  source_session_count: number;
  missing_sessions_json: string;
  chunk_count: number;
  model_call_count: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

interface CandidateRow {
  id: string;
  display_no: string;
  batch_id: string;
  requirement_id: string;
  project_id: string;
  claim: string;
  scope: string;
  evidence: string;
  source_session_ids_json: string;
  status: string;
  edited_claim: string | null;
  edited_scope: string | null;
  reviewed_at: string | null;
  conflicts_json: string;
  notes_json: string;
  md_path: string | null;
  created_at: string;
}

function rowToBatch(r: BatchRow): MemoryBatchRecord {
  return {
    id: r.id,
    requirementId: r.requirement_id,
    projectId: r.project_id,
    status: r.status as BatchStatus,
    sourceSessionCount: r.source_session_count,
    missingSessions: JSON.parse(r.missing_sessions_json) as MissingSession[],
    chunkCount: r.chunk_count,
    modelCallCount: r.model_call_count,
    error: r.error,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

function rowToCandidate(r: CandidateRow): MemoryCandidateRecord {
  return {
    id: r.id,
    displayNo: r.display_no,
    batchId: r.batch_id,
    requirementId: r.requirement_id,
    projectId: r.project_id,
    claim: r.claim,
    scope: r.scope,
    evidence: r.evidence,
    sourceSessionIds: JSON.parse(r.source_session_ids_json) as string[],
    status: r.status as CandidateStatus,
    editedClaim: r.edited_claim,
    editedScope: r.edited_scope,
    reviewedAt: r.reviewed_at,
    conflicts: JSON.parse(r.conflicts_json) as SimilarityNote[],
    notes: JSON.parse(r.notes_json) as SimilarityNote[],
    mdPath: r.md_path,
    createdAt: r.created_at,
  };
}

// 生成提示项：相似度三位小数（提示性质，稳定展示）
function noteOf(other: MemoryCandidateRecord, kind: SimilarityNote["kind"], newClaim: string): SimilarityNote {
  const sim = diceSimilarity(newClaim, other.editedClaim ?? other.claim);
  return { displayNo: other.displayNo, similarity: Number(sim.toFixed(3)), kind };
}
