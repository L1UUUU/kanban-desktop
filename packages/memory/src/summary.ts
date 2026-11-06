// 用途：SummaryStore —— 需求开发总结防覆盖与版本（memory_summaries 行 + requirements/<REQ>/summary.md）：内容 hash 基准、人工编辑后重提取走 proposed 暂存不覆盖、resolveSummary 二选一、新 proposed 替换旧未处置 proposed、应用内总结编辑写回（issue #38，spec #27 D/F/I 节 US13/US23，演进自 poc-5 store.writeSummary）
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

  /**
   * 应用内总结正文编辑写回（issue #38，spec #27 I-8/US13）：summary.md 落人工版（temp+rename 双写序，
   * Markdown 先写 → SQLite 后提交）+ updated_at 刷新。
   * content_hash 基准刻意保持「机器最后写出版」：磁盘（人工版）≠ 基准即人工编辑标记，后续重提取的
   * writeSummary 由此走 proposed 不覆盖——与外部编辑器直接改文件同一待遇，防覆盖闭环（#30）自然衔接。
   * 未处置 proposed 的指针与暂存文件不受影响（编辑的是当前正文，对比处置仍可用）。
   */
  editSummary(requirementId: string, content: string): void {
    const row = this.getSummary(requirementId);
    if (!row) {
      throw new Error(`需求 ${requirementId} 无总结（应用内编辑的前提是已有总结）`);
    }
    writeAtomic(row.mdPath, content);
    this.db
      .prepare("UPDATE memory_summaries SET updated_at = ? WHERE requirement_id = ?")
      .run(this.now(), requirementId);
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

  /** 项目全部总结行（最近更新优先）—— 记忆视图 projectMemory 一次读（issue #31） */
  listSummaries(projectId: string): MemorySummaryRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM memory_summaries WHERE project_id = ? ORDER BY updated_at DESC, rowid DESC")
      .all(projectId) as unknown as SummaryRow[];
    return rows.map(rowToSummary);
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

// 行投影（getSummary/listSummaries 共用同一映射）
function rowToSummary(r: SummaryRow): MemorySummaryRecord {
  return {
    requirementId: r.requirement_id,
    projectId: r.project_id,
    contentHash: r.content_hash,
    mdPath: r.md_path,
    proposedBatchId: r.proposed_batch_id,
    proposedMdPath: r.proposed_md_path,
    updatedAt: r.updated_at,
  };
}
