// 用途：ddl 密封测试 —— memory 三表 DDL（memory_batches/memory_candidates/memory_summaries）与 v3 迁移（单事务、幂等重入、新库直建；spec #27 D 节，tracker store 先例）
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as nodeSqlite from "node:sqlite";
import { ensureMemoryTables, listMemoryTables, migrateMemoryToV3 } from "./ddl";

// 与 desktop db.ts 相同的 node:sqlite 入口回退（双入口兼容）
const exportsRecord = nodeSqlite as unknown as Record<string, unknown>;
const RawDb = (typeof exportsRecord.Database === "function"
  ? exportsRecord.Database
  : nodeSqlite.DatabaseSync) as new (path: string) => nodeSqlite.DatabaseSync;

const dbFiles: string[] = [];
const openDbs: nodeSqlite.DatabaseSync[] = [];
afterAll(() => {
  for (const db of openDbs) db.close();
  for (const f of dbFiles) rmSync(f, { force: true });
});
function tmpDbPath(tag: string): string {
  const f = join(tmpdir(), `kb-memory-ddl-${tag}-${process.pid}-${Date.now()}.db`);
  dbFiles.push(f);
  return f;
}

/** v2 形态老库基座（五表最小子集 + 迁移记录 v1/v2；memory 三表尚不存在） */
function buildV2Base(db: nodeSqlite.DatabaseSync): void {
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'v1-c3-base', '2026-11-05T00:00:00.000Z');
    INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, 'v2-requirements-project', '2026-11-05T00:00:00.000Z');
    INSERT INTO projects (id, name) VALUES ('p-1', 'old-project');
  `);
}

function columnsOf(db: nodeSqlite.DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map((r) => r.name);
}

describe("ensureMemoryTables（幂等建表）", () => {
  it("裸库上直接建三表；重复执行不抛错、不重复", () => {
    const db = new RawDb(":memory:");
    openDbs.push(db);
    ensureMemoryTables(db);
    ensureMemoryTables(db);
    expect(listMemoryTables(db).sort()).toEqual(["memory_batches", "memory_candidates", "memory_summaries"]);
    // v3 契约关键列（spec #27 D 节）
    expect(columnsOf(db, "memory_candidates")).toEqual(
      expect.arrayContaining(["display_no", "edited_claim", "edited_scope", "conflicts_json", "notes_json", "md_path"]),
    );
    expect(columnsOf(db, "memory_batches")).toEqual(
      expect.arrayContaining(["status", "missing_sessions_json", "chunk_count", "model_call_count", "error", "finished_at"]),
    );
    expect(columnsOf(db, "memory_summaries")).toEqual(
      expect.arrayContaining(["content_hash", "md_path", "proposed_batch_id", "proposed_md_path"]),
    );
  });

  it("状态列受 CHECK 约束：非法批次/候选状态写入被拒（wire 层终态保护的第一道闸）", () => {
    const db = new RawDb(":memory:");
    openDbs.push(db);
    ensureMemoryTables(db);
    expect(() =>
      db.prepare("INSERT INTO memory_batches (id, requirement_id, project_id, status, created_at) VALUES ('b','r','p','weird','t')").run(),
    ).toThrow();
    expect(() =>
      db.prepare("INSERT INTO memory_candidates (id, display_no, batch_id, requirement_id, project_id, claim, status, created_at) VALUES ('c','CAND-0001','b','r','p','x','weird','t')").run(),
    ).toThrow();
  });

  it("display_no 项目内唯一（唯一索引拒绝同项目重复编号）", () => {
    const db = new RawDb(":memory:");
    openDbs.push(db);
    ensureMemoryTables(db);
    db.prepare("INSERT INTO memory_batches (id, requirement_id, project_id, status, created_at) VALUES ('b','r','p1','running','t')").run();
    const ins = db.prepare("INSERT INTO memory_candidates (id, display_no, batch_id, requirement_id, project_id, claim, status, created_at) VALUES (?,?,'b','r',?,?,'pending','t')");
    ins.run("c1", "CAND-0001", "p1", "x");
    expect(() => ins.run("c2", "CAND-0001", "p1", "y"), "同项目重复编号被唯一索引拒绝").toThrow();
    // 不同项目同编号允许
    expect(() => ins.run("c3", "CAND-0001", "p2", "z")).not.toThrow();
  });
});

describe("migrateMemoryToV3（老库单事务迁移 / 新库直建 / 幂等重入）", () => {
  it("v2 老库迁移：单事务建三表 + 记 v3，既有 v2 数据不受影响", () => {
    const path = tmpDbPath("v2-old");
    {
      const raw = new RawDb(path);
      buildV2Base(raw);
      raw.close();
    }
    const db = new RawDb(path);
    openDbs.push(db);
    migrateMemoryToV3(db);
    expect(listMemoryTables(db).sort()).toEqual(["memory_batches", "memory_candidates", "memory_summaries"]);
    const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as unknown as Array<{ version: number }>;
    expect(versions.map((r) => r.version)).toEqual([1, 2, 3]);
    // v2 既有数据不受影响
    expect(db.prepare("SELECT name FROM projects WHERE id = 'p-1'").get()).toEqual({ name: "old-project" });
  });

  it("幂等重入：二次执行不抛错、迁移记录不重复", () => {
    const db = new RawDb(":memory:");
    openDbs.push(db);
    buildV2Base(db);
    migrateMemoryToV3(db);
    migrateMemoryToV3(db);
    const n = (db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version = 3").get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it("事务中断（部分 DDL 已执行未提交）重入：迁移从头完整执行且幂等", () => {
    const path = tmpDbPath("interrupted");
    {
      const raw = new RawDb(path);
      buildV2Base(raw);
      // 模拟迁移中途进程被杀：BEGIN 后仅建一表即断连（SQLite 自动回滚未提交 DDL）
      raw.exec("BEGIN IMMEDIATE");
      raw.exec("CREATE TABLE memory_batches (id TEXT PRIMARY KEY)");
      raw.close();
    }
    const db = new RawDb(path);
    openDbs.push(db);
    migrateMemoryToV3(db);
    expect(listMemoryTables(db).sort()).toEqual(["memory_batches", "memory_candidates", "memory_summaries"]);
    // 中断未留半个表：memory_batches 是完整三表 DDL 形态（含 status 列）
    expect(columnsOf(db, "memory_batches")).toContain("status");
    expect(() =>
      db.prepare("INSERT INTO memory_batches (id, requirement_id, project_id, status, created_at) VALUES ('b','r','p','running','t')").run(),
    ).not.toThrow();
  });

  it("v3 已记录的老库：迁移直接跳过（快路径）", () => {
    const db = new RawDb(":memory:");
    openDbs.push(db);
    buildV2Base(db);
    db.exec("INSERT INTO schema_migrations (version, name, applied_at) VALUES (3, 'v3-memory-tables', '2026-11-06T00:00:00.000Z')");
    migrateMemoryToV3(db);
    expect(listMemoryTables(db)).toEqual([]); // 已记录则完全不建表（desktop 新库直建路径由 openDatabase 先 ensure 再迁移）
  });
});
