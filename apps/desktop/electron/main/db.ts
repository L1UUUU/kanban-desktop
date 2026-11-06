// 用途：SQLite 访问层（D2 定版 node:sqlite；#16 起 v2：requirements.project_id；#30 起 v3：memory 三表由 @kanban/memory 迁移）—— 纯 Node 模块，供 Electron 主进程与 vitest 共用
import { migrateMemoryToV3 } from "@kanban/memory";
import { formatRequirementId } from "@kanban/tracker";
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

/** 当前 C3 基线版本号（#30 起 v3：memory 三表，spec #27 D 节；DDL/迁移由 @kanban/memory 导出） */
export const SCHEMA_VERSION = 3;

/** C3 表结构：projects/sessions 按 C3 列清单；requirements/stage_events 沿用 poc-4 冻结 DDL（#16 v2 起 requirements 加 project_id，新库直建 v2 形态；老库由 migrateToV2 在单事务内 ALTER） */
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
  created_at TEXT NOT NULL,
  project_id TEXT
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
  VALUES (1, 'v1-c3-base', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
`;

/** 打开数据库（文件路径或 ":memory:"）并确保表结构就位（新库直建最新形态，老库逐版本单事务迁移） */
export function openDatabase(dbPath: string): SqliteDatabase {
  const db = new DatabaseCtor(dbPath);
  try {
    ensureSchema(db);
    migrateToV2(db);
    migrateMemoryToV3(db); // v3：memory 三表（#30，spec #27 D 节；tracker store.ts 先例——DDL/迁移随包）
    return db;
  } catch (err) {
    db.close(); // 迁移失败连接不外泄（Windows 文件锁）
    throw err;
  }
}

/** 幂等建表（重复执行不报错、不重复插入迁移记录） */
export function ensureSchema(db: SqliteDatabase): void {
  db.exec(SCHEMA_SQL);
}

/**
 * 迁移 v2（#16，spec #15 F 节）：requirements 加 project_id + 按最早关联会话回填 + 补写旧事件 payload 的 projectId，
 * DDL/回填/迁移记录在单事务内完成（中断重入幂等；无关联会话的存量需求失败回滚——宁可不迁移不分叉）。
 * 注意：补写 stage_events.payload_json 是事件日志不可变原则的有意破例（schema 演进迁移），依据 spec #15 F 节。
 */
function migrateToV2(db: SqliteDatabase): void {
  const recorded = (db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version = 2").get() as { n: number }).n;
  if (recorded > 0) return; // 已迁移（或迁移后建的新库二次打开）
  db.exec("BEGIN IMMEDIATE");
  try {
    const cols = (db.prepare("PRAGMA table_info(requirements)").all() as unknown as Array<{ name: string }>).map((r) => r.name);
    if (!cols.includes("project_id")) db.exec("ALTER TABLE requirements ADD COLUMN project_id TEXT");
    backfillProjectId(db);
    db
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, 'v2-requirements-project', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))")
      .run();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** 回填规则（spec #15 F 节）：每张存量需求按其最早关联会话（v1 事件日志中建卡 skill/link 事件，按落库顺序）→ sessions.project_id 推导 project_id */
function backfillProjectId(db: SqliteDatabase): void {
  // 轻量重放 v1 关联规则，推导每张需求的最早关联会话（建卡事件或最早 link，取先者）
  type EvRow = { kind: string; session_id: string | null; requirement_id: string | null; skill: string | null; evidence_level: string };
  const events = db
    .prepare("SELECT kind, session_id, requirement_id, skill, evidence_level FROM stage_events ORDER BY processed_at, rowid")
    .all() as unknown as EvRow[];
  const sessionToReq = new Map<string, string>();
  const firstSession = new Map<string, string>(); // requirementId -> 最早关联会话
  let next = 1;
  for (const ev of events) {
    if (ev.kind === "skill" && ev.skill === "design-feature" && ev.evidence_level === "verified" && ev.session_id && !sessionToReq.has(ev.session_id)) {
      const id = formatRequirementId(next++); // v1 只有自动建卡，编号按建卡顺序（REQ 格式权威在 @kanban/tracker）
      sessionToReq.set(ev.session_id, id);
      if (!firstSession.has(id)) firstSession.set(id, ev.session_id);
    } else if (ev.kind === "link" && ev.session_id && ev.requirement_id) {
      sessionToReq.set(ev.session_id, ev.requirement_id);
      if (!firstSession.has(ev.requirement_id)) firstSession.set(ev.requirement_id, ev.session_id);
    } else if (ev.kind === "unlink" && ev.session_id) {
      sessionToReq.delete(ev.session_id);
    }
  }
  const reqRows = db.prepare("SELECT id FROM requirements").all() as unknown as Array<{ id: string }>;
  const updateReq = db.prepare("UPDATE requirements SET project_id = ? WHERE id = ?");
  const pickSession = db.prepare("SELECT project_id FROM sessions WHERE id = ?");
  const pickEvents = db.prepare("SELECT event_id, payload_json FROM stage_events WHERE session_id = ?");
  const updatePayload = db.prepare("UPDATE stage_events SET payload_json = ? WHERE event_id = ?");
  for (const { id } of reqRows) {
    const sessionId = firstSession.get(id);
    if (!sessionId) {
      throw new Error(`requirements v2 迁移：存量需求 ${id} 无关联会话，无法推导 project_id（宁可不迁移不分叉，spec #15 F）`);
    }
    const session = pickSession.get(sessionId) as { project_id: string | null } | undefined;
    if (!session || session.project_id == null) {
      throw new Error(`requirements v2 迁移：需求 ${id} 的关联会话 ${sessionId} 无项目归属，无法推导 project_id（spec #15 F）`);
    }
    const projectId = session.project_id;
    updateReq.run(projectId, id);
    // 同步补写该会话旧事件 payload 的 projectId（保证重放态=迁移前在线态；事件日志不可变的有意破例）
    const evRows = pickEvents.all(sessionId) as unknown as Array<{ event_id: string; payload_json: string }>;
    for (const row of evRows) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      if (payload.projectId === projectId) continue; // 已补写（重复会话幂等）
      payload.projectId = projectId;
      updatePayload.run(JSON.stringify(payload), row.event_id);
    }
  }
}

/** 列出全部用户表（测试/诊断用，按字母序） */
export function listTables(db: SqliteDatabase): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as unknown as Array<{ name: string }>;
  return rows.map((r) => r.name);
}
