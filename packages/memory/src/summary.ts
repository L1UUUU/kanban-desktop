// 用途：SummaryStore —— 需求开发总结防覆盖与版本（memory_summaries 行 + requirements/<REQ>/summary.md）：内容 hash 基准、人工编辑后重提取走 proposed 暂存不覆盖、resolveSummary 二选一、新 proposed 替换旧未处置 proposed（spec #27 D/F 节 US14/US23，演进自 poc-5 store.writeSummary）
import { existsSync, readFileSync, rmSync } from "node:fs";
import { proposedMdPath, sha256Text, summaryMdPath, writeAtomic } from "./markdown";
import { ensureMemoryTables, type SqliteDb } from "./ddl";

/** memory_summaries 行投影 */
export interface MemorySummaryRecord {
  requirementId: string;
  projectId: string;
  contentHash: string;
  mdPath: string;
  proposedBatchId: string | null;
  proposedMdPath: string | null;
  updatedAt: string;
}

/** writeSummary 结果：written=直接覆盖生效；proposed=检测到人工编辑、新版暂存待处置 */
export interface WriteSummaryResult {
  mode: "written" | "proposed";
  mdPath: string;
  proposedMdPath?: string;
}

export class SummaryStore {
  private readonly db: SqliteDb;
  private readonly dataRoot: string;
  private readonly now: () => string;

  constructor(db: SqliteDb, dataRoot: string, opts?: { now?: () => string }) {
    this.db = db;
    this.dataRoot = dataRoot;
    ensureMemoryTables(db);
    this.now = opts?.now ?? (() => new Date().toISOString());
  }

  /**
   * 批次总结写入（双写序：Markdown 先写 temp+rename → SQLite 事务后提交）。
   * 落盘前重读磁盘 summary hash：与库 content_hash 不一致（人工编辑过）→ 不覆盖，
   * 新版写 summary.proposed.<batchId>.md 暂存并替换旧未处置 proposed；一致或首写 → 直接覆盖并更新基准。
   */
  writeSummary(input: { requirementId: string; projectId: string; batchId: string; content: string }): WriteSummaryResult {
    const mdPath = summaryMdPath(this.dataRoot, input.projectId, input.requirementId);
    const row = this.getSummary(input.requirementId);
    const humanEdited =
      row != null && existsSync(row.mdPath) && sha256Text(readFileSync(row.mdPath, "utf8")) !== row.contentHash;

    if (humanEdited && row) {
      // 人工编辑过：不静默覆盖，暂存新版；旧未处置 proposed 先删除（不堆积）
      const proposed = proposedMdPath(this.dataRoot, input.projectId, input.requirementId, input.batchId);
      if (row.proposedMdPath && row.proposedMdPath !== proposed) rmSync(row.proposedMdPath, { force: true });
      writeAtomic(proposed, input.content);
      this.db
        .prepare(
          `UPDATE memory_summaries SET proposed_batch_id = ?, proposed_md_path = ?, updated_at = ?
           WHERE requirement_id = ?`,
        )
        .run(input.batchId, proposed, this.now(), input.requirementId);
      return { mode: "proposed", mdPath: row.mdPath, proposedMdPath: proposed };
    }

    // 首写或未被人工编辑：直接覆盖并更新 hash 基准（清掉历史 proposed 指针保持最终态自洽）
    writeAtomic(mdPath, input.content);
    if (row?.proposedMdPath) rmSync(row.proposedMdPath, { force: true });
    this.db
      .prepare(
        `INSERT INTO memory_summaries (requirement_id, project_id, content_hash, md_path, proposed_batch_id, proposed_md_path, updated_at)
         VALUES (?,?,?,?,NULL,NULL,?)
         ON CONFLICT(requirement_id) DO UPDATE SET
           content_hash = excluded.content_hash, md_path = excluded.md_path,
           proposed_batch_id = NULL, proposed_md_path = NULL, updated_at = excluded.updated_at`,
      )
      .run(input.requirementId, input.projectId, sha256Text(input.content), mdPath, this.now());
    return { mode: "written", mdPath };
  }

  /** 处置 proposed：accept-new 采纳新版（覆盖 summary.md 并更新 hash 基准）/ keep-human 保留人工版；处置后暂存清除 */
  resolveSummary(requirementId: string, choice: "accept-new" | "keep-human"): void {
    const row = this.getSummary(requirementId);
    if (!row || !row.proposedMdPath || row.proposedBatchId == null) {
      throw new Error(`需求 ${requirementId} 无未处置的 proposed 总结`);
    }
    if (choice === "accept-new") {
      if (!existsSync(row.proposedMdPath)) {
        throw new Error(`proposed 文件缺失: ${row.proposedMdPath}（以启动修复对账后再处置）`);
      }
      const content = readFileSync(row.proposedMdPath, "utf8");
      writeAtomic(row.mdPath, content);
      this.db
        .prepare(
          `UPDATE memory_summaries SET content_hash = ?, proposed_batch_id = NULL, proposed_md_path = NULL, updated_at = ?
           WHERE requirement_id = ?`,
        )
        .run(sha256Text(content), this.now(), requirementId);
    } else {
      this.db
        .prepare(
          `UPDATE memory_summaries SET proposed_batch_id = NULL, proposed_md_path = NULL, updated_at = ?
           WHERE requirement_id = ?`,
        )
        .run(this.now(), requirementId);
    }
    rmSync(row.proposedMdPath, { force: true });
  }

  getSummary(requirementId: string): MemorySummaryRecord | null {
    const row = this.db.prepare("SELECT * FROM memory_summaries WHERE requirement_id = ?").get(requirementId) as SummaryRow | undefined;
    if (!row) return null;
    return {
      requirementId: row.requirement_id,
      projectId: row.project_id,
      contentHash: row.content_hash,
      mdPath: row.md_path,
      proposedBatchId: row.proposed_batch_id,
      proposedMdPath: row.proposed_md_path,
      updatedAt: row.updated_at,
    };
  }
}

interface SummaryRow {
  requirement_id: string;
  project_id: string;
  content_hash: string;
  md_path: string;
  proposed_batch_id: string | null;
  proposed_md_path: string | null;
  updated_at: string;
}
