// 用途：SQLite 访问层（D2 定版 node:sqlite）—— 打开数据库并按冻结契约 C3 建五表；纯 Node 模块，供 Electron 主进程与 vitest 共用
import * as nodeSqlite from "node:sqlite";

type SqliteDatabase = import("node:sqlite").DatabaseSync;

/** 底层连接类型别名（store 层构造函数签名复用） */
export type SqliteDb = SqliteDatabase;

// Node 24 仅导出 DatabaseSync（新名 Database 自 Node 25.7 起，见 decisions.md D2）；以实测为准优先新入口、回退别名
const exportsRecord = nodeSqlite as unknown as Record<string, unknown>;
const DatabaseCtor = (typeof exportsRecord.Database === "function"
  ? exportsRecord.Database
  : nodeSqlite.DatabaseSync) as new (path: string) => SqliteDatabase;

/** 实际使用的 node:sqlite 入口名（appInfo 冒烟展示与 D2 记录用） */
export const SQLITE_ENTRY: "Database" | "DatabaseSync" =
  typeof exportsRecord.Database === "function" ? "Database" : "DatabaseSync";

/** 当前 C3 基线版本号 */
export const SCHEMA_VERSION = 1;

/** C3 冻结表结构（v1）：projects/sessions 按 C3 列清单；requirements/stage_events 沿用 poc-4 冻结 DDL 不变 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('structured', 'pty')),
  cli TEXT NOT NULL,
  native_session_id TEXT,
  project_id TEXT REFERENCES projects(id),
  title TEXT,
  cwd TEXT,
  perm_mode TEXT,
  status TEXT,
  last_active_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- cli + native_session_id 唯一（可空：PTY 无 native id），部分唯一索引
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_cli_native
  ON sessions(cli, native_session_id) WHERE native_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  stage TEXT,
  stage_basis_at INTEGER,
  stage_basis_json TEXT,
  uncertain INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stage_events (
  event_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  session_id TEXT,
  cli TEXT,
  skill TEXT,
  stage TEXT,
  requirement_id TEXT,
  occurred_at TEXT,
  received_at TEXT,
  seq TEXT,
  evidence_level TEXT NOT NULL,
  source TEXT,
  payload_json TEXT NOT NULL,
  processed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
  VALUES (${SCHEMA_VERSION}, 'v1-c3-base', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
`;

/** 打开数据库（文件路径或 ":memory:"）并确保 C3 表结构就位 */
export function openDatabase(dbPath: string): SqliteDatabase {
  const db = new DatabaseCtor(dbPath);
  ensureSchema(db);
  return db;
}

/** 幂等建表（重复执行不报错、不重复插入迁移记录） */
export function ensureSchema(db: SqliteDatabase): void {
  db.exec(SCHEMA_SQL);
}

/** 列出全部用户表（测试/诊断用，按字母序） */
export function listTables(db: SqliteDatabase): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as unknown as Array<{ name: string }>;
  return rows.map((r) => r.name);
}
