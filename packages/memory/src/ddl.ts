// 用途：memory SQLite v3 三表 DDL 与迁移函数（spec #27 D 节；演进自 tracker store.ts DDL 随包先例）—— 由本包导出、apps/desktop db 层 v3 调用，沿用 SCHEMA_VERSION 单事务迁移机制
import type { DatabaseSync } from "node:sqlite";

/** db 句柄类型别名（node:sqlite DatabaseSync，测试注入 :memory:） */
export type SqliteDb = DatabaseSync;

/** v3 迁移记录名（schema_migrations 行） */
export const MEMORY_V3_MIGRATION_NAME = "v3-memory-tables";

// C3 演进 v3（spec #27 D 节，纯增量三表）：SQLite 是批次/候选/状态/冲突/审核元数据的唯一真相源，Markdown 承载正式内容
export const MEMORY_TABLES_DDL = `
CREATE TABLE IF NOT EXISTS memory_batches (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled')),
  source_session_count INTEGER NOT NULL DEFAULT 0,
  missing_sessions_json TEXT NOT NULL DEFAULT '[]',
  chunk_count INTEGER NOT NULL DEFAULT 0,
  model_call_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS memory_candidates (
  id TEXT PRIMARY KEY,
  display_no TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  requirement_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  claim TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '',
  source_session_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','edited','ignored')),
  edited_claim TEXT,
  edited_scope TEXT,
  reviewed_at TEXT,
  conflicts_json TEXT NOT NULL DEFAULT '[]',
  notes_json TEXT NOT NULL DEFAULT '[]',
  md_path TEXT,
  created_at TEXT NOT NULL
);

-- display_no 项目内递增（CAND-xxxx），唯一索引防并发/重放重复分配
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_candidates_project_display
  ON memory_candidates (project_id, display_no);

CREATE TABLE IF NOT EXISTS memory_summaries (
  requirement_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  md_path TEXT NOT NULL,
  proposed_batch_id TEXT,
  proposed_md_path TEXT,
  updated_at TEXT NOT NULL
);
`;

/** 幂等建三表（重复执行不报错；MemoryStore 构造与迁移共用） */
export function ensureMemoryTables(db: SqliteDb): void {
  db.exec(MEMORY_TABLES_DDL);
}

/**
 * 迁移 v3（issue #30，spec #27 D 节）：老库在单事务内建 memory 三表并记 schema_migrations(3)。
 * 与 desktop db.ts migrateToV2 同机制：已记录快路径返回；中断重入幂等（未提交 DDL 随事务回滚，重入完整执行）。
 * 新库直建由调用方先 ensureSchema 再走本迁移（记录 v3 即达新库直建形态）。
 */
export function migrateMemoryToV3(db: SqliteDb): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const recorded = (db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version = 3").get() as { n: number }).n;
  if (recorded > 0) return; // 已迁移（或迁移后建的新库二次打开）
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureMemoryTables(db);
    db
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (3, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))")
      .run(MEMORY_V3_MIGRATION_NAME);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** 列出 memory 三表（测试/诊断用） */
export function listMemoryTables(db: SqliteDb): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory_%' ORDER BY name")
    .all() as unknown as Array<{ name: string }>;
  return rows.map((r) => r.name);
}
