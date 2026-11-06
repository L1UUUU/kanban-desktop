// 用途：启动对账与修复（spec #27 E 节四规则）—— ① running 批次→failed（应用中断）② accepted/ 下无库行引用的孤儿 md 删除 ③ summary.md 存在而无库行→以文件 hash 建档 ④ 非 completed 批次的 proposed 文件删除并清行指针；打开库后调用一次，崩溃窗口（Markdown 已写事务未提交）由此收敛
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256Text } from "./markdown";
import { ensureMemoryTables, type SqliteDb } from "./ddl";

/** 对账修复报告（四类动作的清单，测试与诊断用） */
export interface ReconcileReport {
  failedBatches: string[];
  removedOrphanMds: string[];
  createdSummaryRows: string[];
  removedProposed: string[];
}

/** proposed 文件名模式：summary.proposed.<batchId>.md */
const PROPOSED_RE = /^summary\.proposed\.(.+)\.md$/;

/**
 * 启动对账与修复四规则（spec #27 E 节）。数据布局约定与 markdown.ts 一致：
 * <dataRoot>/<projectId>/accepted/ 与 <dataRoot>/<projectId>/requirements/<REQ>/。
 */
export function reconcileMemory(db: SqliteDb, dataRoot: string, opts?: { now?: () => string }): ReconcileReport {
  ensureMemoryTables(db);
  const now = opts?.now ?? (() => new Date().toISOString());
  const report: ReconcileReport = { failedBatches: [], removedOrphanMds: [], createdSummaryRows: [], removedProposed: [] };

  // 规则一：running 批次 → failed（应用中断：崩溃/强杀后不锁死需求，US24）
  const running = db.prepare("SELECT id FROM memory_batches WHERE status = 'running'").all() as unknown as Array<{ id: string }>;
  const markFailed = db.prepare("UPDATE memory_batches SET status = 'failed', error = ?, finished_at = ? WHERE id = ?");
  for (const { id } of running) {
    markFailed.run("应用中断", now(), id);
    report.failedBatches.push(id);
  }

  if (!existsSync(dataRoot)) return report; // 无数据目录（首启）→ 后三条无对象

  // 规则二：accepted/ 下无库行引用的孤儿 md 删除（崩溃窗口：md 已写事务未提交）
  const referenced = new Set(
    (db.prepare("SELECT md_path FROM memory_candidates WHERE md_path IS NOT NULL").all() as unknown as Array<{ md_path: string }>)
      .map((r) => resolve(r.md_path)),
  );
  for (const projectId of listDirs(dataRoot)) {
    const acceptedDir = join(dataRoot, projectId, "accepted");
    if (!existsSync(acceptedDir)) continue;
    for (const file of readdirSync(acceptedDir)) {
      const full = join(acceptedDir, file);
      if (!referenced.has(resolve(full))) {
        rmSync(full, { force: true });
        report.removedOrphanMds.push(full);
      }
    }
  }

  // 规则三：summary.md 存在而无库行 → 以文件 hash 建档（SQLite 是元数据真相源，hash 基准补齐后人工编辑检测可用）
  const hasSummaryRow = db.prepare("SELECT count(*) AS n FROM memory_summaries WHERE requirement_id = ?");
  const insertSummary = db.prepare(
    "INSERT INTO memory_summaries (requirement_id, project_id, content_hash, md_path, updated_at) VALUES (?,?,?,?,?)",
  );
  for (const projectId of listDirs(dataRoot)) {
    const reqRoot = join(dataRoot, projectId, "requirements");
    if (!existsSync(reqRoot)) continue;
    for (const reqId of listDirs(reqRoot)) {
      const mdPath = join(reqRoot, reqId, "summary.md");
      if (!existsSync(mdPath)) continue;
      const n = (hasSummaryRow.get(reqId) as { n: number }).n;
      if (n > 0) continue;
      insertSummary.run(reqId, projectId, sha256Text(readFileSync(mdPath, "utf8")), mdPath, now());
      report.createdSummaryRows.push(reqId);
    }
  }

  // 规则四：非 completed 批次的 proposed 文件删除（行指针同步清空；completed 批次的未处置 proposed 是正常待审态，保留）
  const batchStatus = db.prepare("SELECT status FROM memory_batches WHERE id = ?");
  const isCompleted = (batchId: string): boolean =>
    (batchStatus.get(batchId) as { status: string } | undefined)?.status === "completed";
  for (const projectId of listDirs(dataRoot)) {
    const reqRoot = join(dataRoot, projectId, "requirements");
    if (!existsSync(reqRoot)) continue;
    for (const reqId of listDirs(reqRoot)) {
      for (const file of readdirSync(join(reqRoot, reqId))) {
        const m = PROPOSED_RE.exec(file);
        if (!m) continue;
        if (!isCompleted(m[1])) {
          const full = join(reqRoot, reqId, file);
          rmSync(full, { force: true });
          report.removedProposed.push(full);
        }
      }
    }
  }
  // 行指针指向非 completed 批次 → 清指针（文件已由上面扫描删除；completed 保留）
  const pointerRows = db
    .prepare("SELECT requirement_id, proposed_batch_id FROM memory_summaries WHERE proposed_batch_id IS NOT NULL")
    .all() as unknown as Array<{ requirement_id: string; proposed_batch_id: string }>;
  const clearPointer = db.prepare("UPDATE memory_summaries SET proposed_batch_id = NULL, proposed_md_path = NULL WHERE requirement_id = ?");
  for (const row of pointerRows) {
    if (!isCompleted(row.proposed_batch_id)) clearPointer.run(row.requirement_id);
  }

  return report;
}

// 列目录下的子目录名（非目录项跳过）
function listDirs(dir: string): string[] {
  return readdirSync(dir).filter((name) => {
    try {
      return statSync(join(dir, name)).isDirectory();
    } catch {
      return false;
    }
  });
}
