// 用途：SQLite 迁移单测 —— v2（#16，spec #15 F 节）：v1 库加 project_id 列 + 按最早关联会话回填 + 补写旧事件 payload projectId + 单事务（中断重入幂等、无关联会话失败回滚）+ 迁移后重放态=迁移前在线态 + TD6 跨项目旧 link 重放兼容性钉子；v3（#30，spec #27 D 节）：memory 三表单事务迁移/幂等重入/新库直建；v4（#58，spec #57）：sessions 加 archived_at 可空列（现存行全部未归档）/单事务/中断回滚/新库直建
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nodeSqlite from "node:sqlite";
import { ensureMemoryTables } from "@kanban/memory";
import { TrackerEngine } from "@kanban/tracker";
import { afterAll, describe, expect, it } from "vitest";
import { listTables, openDatabase, type SqliteDb } from "./db";

// 与 db.ts 相同的 node:sqlite 入口回退（测试需绕过 openDatabase 直造 v1 库）
const exportsRecord = nodeSqlite as unknown as Record<string, unknown>;
const RawDb = (typeof exportsRecord.Database === "function"
  ? exportsRecord.Database
  : nodeSqlite.DatabaseSync) as new (path: string) => nodeSqlite.DatabaseSync;

const dbFiles: string[] = [];
const openDbs: SqliteDb[] = [];
afterAll(() => {
  for (const db of openDbs) db.close();
  for (const f of dbFiles) rmSync(f, { force: true });
});
function tmpDbPath(tag: string): string {
  const f = join(tmpdir(), `kb-db-migration-${tag}-${process.pid}-${Date.now()}.db`);
  dbFiles.push(f);
  return f;
}

// v1 形态最小库（requirements 无 project_id；五表齐备以满足外键）
const V1_DDL = `
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, canonical_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ok', created_at TEXT NOT NULL);
CREATE TABLE sessions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, cli TEXT NOT NULL, native_session_id TEXT, project_id TEXT REFERENCES projects(id), title TEXT, cwd TEXT, perm_mode TEXT, status TEXT, last_active_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE requirements (id TEXT PRIMARY KEY, title TEXT NOT NULL, stage TEXT, stage_basis_at INTEGER, stage_basis_json TEXT, uncertain INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE stage_events (event_id TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT, cli TEXT, skill TEXT, stage TEXT, requirement_id TEXT, occurred_at TEXT, received_at TEXT, seq TEXT, evidence_level TEXT NOT NULL, source TEXT, payload_json TEXT NOT NULL, processed_at TEXT NOT NULL);
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'v1-c3-base', '2026-11-05T00:00:00.000Z');
`;

/** v1 skill 事件行（payload 无 projectId——迁移前旧事件形态） */
function seedSkillEvent(db: nodeSqlite.DatabaseSync, eventId: string, sessionId: string, skill: string, at: string, evidence = "verified"): void {
  const payload = {
    eventId,
    kind: "skill",
    sessionId,
    cli: "claude-code",
    skill,
    stage: null,
    requirementId: null,
    occurredAt: at,
    receivedAt: at,
    seq: null,
    evidenceLevel: evidence,
    source: "claude-hook",
  };
  db.prepare(
    "INSERT INTO stage_events (event_id, kind, session_id, cli, skill, stage, requirement_id, occurred_at, received_at, seq, evidence_level, source, payload_json, processed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(eventId, "skill", sessionId, "claude-code", skill, null, null, at, at, null, evidence, "claude-hook", JSON.stringify(payload), at);
}

/** v1 link 事件行 */
function seedLinkEvent(db: nodeSqlite.DatabaseSync, eventId: string, sessionId: string, reqId: string, at: string): void {
  const payload = {
    eventId,
    kind: "link",
    sessionId,
    cli: "codex",
    skill: null,
    stage: null,
    requirementId: reqId,
    occurredAt: at,
    receivedAt: at,
    seq: null,
    evidenceLevel: "verified",
    source: "gui-card",
  };
  db.prepare(
    "INSERT INTO stage_events (event_id, kind, session_id, cli, skill, stage, requirement_id, occurred_at, received_at, seq, evidence_level, source, payload_json, processed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(eventId, "link", sessionId, "codex", null, null, reqId, at, at, null, "verified", "gui-card", JSON.stringify(payload), at);
}

function seedProject(db: nodeSqlite.DatabaseSync, id: string): void {
  db.prepare("INSERT INTO projects (id, name, canonical_path, status, created_at) VALUES (?, 'n', 'C:\\x', 'ok', '2026-11-05T00:00:00.000Z')").run(id);
}

function seedSession(db: nodeSqlite.DatabaseSync, id: string, projectId: string | null): void {
  db.prepare(
    "INSERT INTO sessions (id, kind, cli, native_session_id, project_id, title, cwd, perm_mode, status, last_active_at, created_at) VALUES (?,'structured','claude-code',NULL,?,NULL,'C:\\x','auto','idle',NULL,'2026-11-05T00:00:00.000Z')",
  ).run(id, projectId);
}

function seedRequirement(db: nodeSqlite.DatabaseSync, id: string, stage: string | null): void {
  db.prepare("INSERT INTO requirements (id, title, stage, stage_basis_at, stage_basis_json, uncertain, created_at) VALUES (?, '待命名需求', ?, 1000, NULL, 0, '2026-11-05T00:00:00.000Z')").run(id, stage);
}

/** 直造 v1 库（不走 openDatabase，避免触发 v2 建表/迁移） */
function buildV1Db(path: string, seed: (db: nodeSqlite.DatabaseSync) => void): void {
  const db = new RawDb(path);
  db.exec(V1_DDL);
  seed(db);
  db.close();
}

function columnsOf(db: nodeSqlite.DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map((r) => r.name);
}

// ========== 迁移 v2 主路径 ==========
describe("迁移 v2：v1 库 → project_id 回填 + payload 补写", () => {
  it("v1 库迁移：加列、按建卡会话回填 project_id、补写旧事件 payload、记 v2 迁移", () => {
    const path = tmpDbPath("main");
    buildV1Db(path, (db) => {
      seedProject(db, "p-1");
      seedSession(db, "s-1", "p-1");
      seedSkillEvent(db, "ev-1", "s-1", "design-feature", "2026-11-05T10:00:01.000Z");
      seedRequirement(db, "REQ-001", "Design");
    });
    const db = openDatabase(path);
    openDbs.push(db);
    expect(columnsOf(db, "requirements")).toContain("project_id");
    expect(db.prepare("SELECT project_id FROM requirements WHERE id = 'REQ-001'").get()).toEqual({ project_id: "p-1" });
    // 补写旧事件 payload（事件日志不可变原则的有意破例——schema 演进迁移，依据 spec #15 F 节）
    const payload = JSON.parse((db.prepare("SELECT payload_json FROM stage_events WHERE event_id = 'ev-1'").get() as { payload_json: string }).payload_json) as { projectId?: string };
    expect(payload.projectId).toBe("p-1");
    const migrations = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as unknown as Array<{ version: number; name: string }>;
    expect(migrations).toEqual([
      { version: 1, name: "v1-c3-base" },
      { version: 2, name: "v2-requirements-project" },
      { version: 3, name: "v3-memory-tables" },
      { version: 4, name: "v4-sessions-archived" },
    ]);
  });

  it("迁移后重放态=迁移前在线态：restore 重建需求带正确 project_id、阶段与关联", () => {
    const path = tmpDbPath("replay");
    buildV1Db(path, (db) => {
      seedProject(db, "p-1");
      seedSession(db, "s-1", "p-1");
      seedSkillEvent(db, "ev-1", "s-1", "design-feature", "2026-11-05T10:00:01.000Z");
      seedSkillEvent(db, "ev-2", "s-1", "implement-spec", "2026-11-05T10:00:02.000Z");
      seedRequirement(db, "REQ-001", "Implement");
    });
    const db = openDatabase(path);
    openDbs.push(db);
    const eng = new TrackerEngine(db);
    eng.restore();
    expect(eng.snapshot()).toEqual([
      {
        id: "REQ-001",
        title: "待命名需求",
        stage: "Implement",
        stageBasis: { kind: "skill", skill: "implement-spec", cli: "claude-code", evidenceLevel: "verified", eventId: "ev-2", at: "2026-11-05T10:00:02.000Z" },
        uncertain: false,
        sessions: ["s-1"],
        projectId: "p-1",
      },
    ]);
    // 重放态投影与迁移回填一致（无分叉）
    expect(eng.store.listRequirements().map((r) => ({ id: r.id, project_id: r.project_id }))).toEqual([{ id: "REQ-001", project_id: "p-1" }]);
  });

  it("最早关联会话 tie-break：多个 link 会话时取事件顺序最早者推导项目", () => {
    const path = tmpDbPath("tiebreak");
    buildV1Db(path, (db) => {
      seedProject(db, "p-1");
      seedProject(db, "p-2");
      seedSession(db, "s-a", "p-2"); // 最早关联（t1）
      seedSession(db, "s-b", "p-1"); // 次早（t2）
      seedLinkEvent(db, "l-2", "s-a", "REQ-009", "2026-11-05T10:00:01.000Z");
      seedLinkEvent(db, "l-3", "s-b", "REQ-009", "2026-11-05T10:00:02.000Z");
      seedRequirement(db, "REQ-009", null);
    });
    const db = openDatabase(path);
    openDbs.push(db);
    expect(db.prepare("SELECT project_id FROM requirements WHERE id = 'REQ-009'").get(), "最早 link 的 s-a 属 p-2").toEqual({ project_id: "p-2" });
    // TD6（spec #15 F/TD6）：迁移后 restore 重放——本用例的 link-only 合成形态（需求行无建卡事件）重放不可重建 REQ-009，
    // 两条旧跨项目 link 均按拒绝处理（link_no_requirement），不产生任何关联（s-b 未关联）；
    // 回填投影不被 restore 改写（restore 纯重放不落库，若误触持久化会被墓碑对账删行 → 断言失败）
    const eng = new TrackerEngine(db);
    eng.restore();
    expect(eng.tracker.log.filter((l) => l.decision === "link_no_requirement")).toHaveLength(2);
    expect(eng.tracker.sessionToReq.size).toBe(0);
    expect(eng.snapshot()).toEqual([]);
    expect(db.prepare("SELECT project_id, stage FROM requirements WHERE id = 'REQ-009'").get()).toEqual({ project_id: "p-2", stage: null });
  });

  it("TD6 兼容：跨项目旧 link 事件迁移后重放被拒（link_project_mismatch），需求保持回填原态且 s-b 未关联", () => {
    const path = tmpDbPath("td6-cross-link");
    buildV1Db(path, (db) => {
      seedProject(db, "p-1");
      seedProject(db, "p-2");
      seedSession(db, "s-f", "p-1"); // REQ-001 建卡会话
      seedSession(db, "s-a", "p-2"); // REQ-002 建卡会话（目标需求）
      seedSession(db, "s-b", "p-1"); // 跨项目旧 link 来源
      seedSkillEvent(db, "ev-f", "s-f", "design-feature", "2026-11-05T10:00:00.000Z"); // → REQ-001
      seedSkillEvent(db, "ev-a", "s-a", "design-feature", "2026-11-05T10:00:01.000Z"); // → REQ-002
      // s-b 对 REQ-003 的最早 link：使回填把 s-b 全部旧事件 payload 补写 p-1（重放时 s-b 项目可知）
      seedLinkEvent(db, "l-3a", "s-b", "REQ-003", "2026-11-05T10:00:02.000Z");
      // 跨项目旧 link：v1 无项目校验可存在；v2 重放应按 link_project_mismatch 拒绝（spec #15 TD6）
      seedLinkEvent(db, "l-old", "s-b", "REQ-002", "2026-11-05T10:00:03.000Z");
      seedRequirement(db, "REQ-001", "Design");
      seedRequirement(db, "REQ-002", "Design");
      seedRequirement(db, "REQ-003", null);
    });
    const db = openDatabase(path);
    openDbs.push(db);
    expect(db.prepare("SELECT id, project_id FROM requirements ORDER BY id").all(), "回填：REQ-002 取建卡会话 s-a 属 p-2；s-b 关联的 REQ-003 属 p-1（其旧事件含 l-old 补写 p-1）").toEqual([
      { id: "REQ-001", project_id: "p-1" },
      { id: "REQ-002", project_id: "p-2" },
      { id: "REQ-003", project_id: "p-1" },
    ]);
    const eng = new TrackerEngine(db);
    eng.restore();
    // 旧跨项目 link 在新规则下重放被拒（l-3a 因 REQ-003 不可重建按 link_no_requirement 拒；l-old 按跨项目拒）
    expect(eng.tracker.log.some((l) => l.decision === "link_project_mismatch" && l.sessionId === "s-b" && l.requirementId === "REQ-002")).toBe(true);
    expect(eng.tracker.sessionToReq.get("s-b")).toBeUndefined();
    // REQ-002 保持回填原态：项目 p-2 / Design / 仅建卡会话 s-a，不因拒绝事件分叉（REQ-003 无建卡事件重放不重建）
    expect(eng.snapshot()).toEqual([
      {
        id: "REQ-001",
        title: "待命名需求",
        stage: "Design",
        stageBasis: { kind: "skill", skill: "design-feature", cli: "claude-code", evidenceLevel: "verified", eventId: "ev-f", at: "2026-11-05T10:00:00.000Z" },
        uncertain: false,
        sessions: ["s-f"],
        projectId: "p-1",
      },
      {
        id: "REQ-002",
        title: "待命名需求",
        stage: "Design",
        stageBasis: { kind: "skill", skill: "design-feature", cli: "claude-code", evidenceLevel: "verified", eventId: "ev-a", at: "2026-11-05T10:00:01.000Z" },
        uncertain: false,
        sessions: ["s-a"],
        projectId: "p-2",
      },
    ]);
    // 投影不分叉：restore 纯重放不落库，回填的 project_id/stage 保持
    expect(db.prepare("SELECT id, project_id, stage FROM requirements ORDER BY id").all()).toEqual([
      { id: "REQ-001", project_id: "p-1", stage: "Design" },
      { id: "REQ-002", project_id: "p-2", stage: "Design" },
      { id: "REQ-003", project_id: "p-1", stage: null },
    ]);
  });

  it("自动建卡会话早于后续 link 时以建卡会话为准", () => {
    const path = tmpDbPath("create-wins");
    buildV1Db(path, (db) => {
      seedProject(db, "p-1");
      seedProject(db, "p-2");
      seedSession(db, "s-1", "p-1");
      seedSession(db, "s-2", "p-2");
      seedSkillEvent(db, "ev-1", "s-1", "design-feature", "2026-11-05T10:00:01.000Z"); // 建卡事件（t1）
      seedLinkEvent(db, "l-1", "s-2", "REQ-001", "2026-11-05T10:00:05.000Z"); // 次晚 link
      seedRequirement(db, "REQ-001", "Design");
    });
    const db = openDatabase(path);
    openDbs.push(db);
    expect(db.prepare("SELECT project_id FROM requirements WHERE id = 'REQ-001'").get()).toEqual({ project_id: "p-1" });
  });
});

// ========== 失败回滚与重入幂等 ==========
describe("迁移 v2：单事务（失败回滚 + 中断重入幂等）", () => {
  it("无关联会话的存量需求 → 迁移失败回滚（列/记录/payload 全部未动），补数据后重入成功", () => {
    const path = tmpDbPath("orphan");
    buildV1Db(path, (db) => {
      seedProject(db, "p-1");
      seedSession(db, "s-1", "p-1");
      seedSkillEvent(db, "ev-1", "s-1", "design-feature", "2026-11-05T10:00:01.000Z");
      seedRequirement(db, "REQ-001", "Design");
      seedRequirement(db, "REQ-009", null); // 孤儿需求：无任何关联事件
    });
    expect(() => openDatabase(path), "宁可不迁移不分叉").toThrow(/REQ-009/);
    {
      // 回滚验证：v1 形态保持（无 project_id 列、无 v2 记录、payload 未补写）
      const raw = new RawDb(path);
      expect(columnsOf(raw, "requirements")).not.toContain("project_id");
      expect((raw.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version = 2").get() as { n: number }).n).toBe(0);
      const payload = JSON.parse((raw.prepare("SELECT payload_json FROM stage_events WHERE event_id = 'ev-1'").get() as { payload_json: string }).payload_json) as { projectId?: string };
      expect(payload.projectId).toBeUndefined();
      raw.close();
    }
    {
      // 修复数据（给孤儿需求补最早关联会话）后重入 → 迁移成功
      const raw = new RawDb(path);
      seedProject(raw, "p-3");
      seedSession(raw, "s-9", "p-3");
      seedLinkEvent(raw, "l-9", "s-9", "REQ-009", "2026-11-05T10:00:09.000Z");
      raw.close();
    }
    const db = openDatabase(path);
    openDbs.push(db);
    expect(db.prepare("SELECT id, project_id FROM requirements ORDER BY id").all()).toEqual([
      { id: "REQ-001", project_id: "p-1" },
      { id: "REQ-009", project_id: "p-3" },
    ]);
  });

  it("事务中断（DDL 已执行未提交）重入：迁移从头完整执行且幂等", () => {
    const path = tmpDbPath("interrupted");
    buildV1Db(path, (db) => {
      seedProject(db, "p-1");
      seedSession(db, "s-1", "p-1");
      seedSkillEvent(db, "ev-1", "s-1", "design-feature", "2026-11-05T10:00:01.000Z");
      seedRequirement(db, "REQ-001", "Design");
    });
    {
      // 模拟迁移中途进程被杀：BEGIN 后 ALTER 未提交即断连（SQLite 自动回滚 DDL）
      const raw = new RawDb(path);
      raw.exec("BEGIN");
      raw.exec("ALTER TABLE requirements ADD COLUMN project_id TEXT");
      raw.close();
    }
    const db = openDatabase(path); // 重入：完整迁移
    openDbs.push(db);
    expect(columnsOf(db, "requirements")).toContain("project_id");
    expect(db.prepare("SELECT project_id FROM requirements WHERE id = 'REQ-001'").get()).toEqual({ project_id: "p-1" });
    // 二次打开幂等：不重复迁移、记录不重复
    const again = openDatabase(path);
    openDbs.push(again);
    const migrations = again.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as unknown as Array<{ version: number }>;
    expect(migrations.map((m) => m.version)).toEqual([1, 2, 3, 4]);
  });
});

// ========== 迁移 v3（memory 三表，#30 spec #27 D 节） ==========
describe("迁移 v3：v2 老库 → memory 三表", () => {
  /** v2 形态库（无 memory 三表；带一条 v2 数据验证不受影响） */
  function buildV2Db(path: string): void {
    const raw = new RawDb(path);
    raw.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, canonical_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ok', created_at TEXT NOT NULL);
      CREATE TABLE requirements (id TEXT PRIMARY KEY, title TEXT NOT NULL, stage TEXT, stage_basis_at INTEGER, stage_basis_json TEXT, uncertain INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, project_id TEXT);
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'v1-c3-base', '2026-11-05T00:00:00.000Z');
      INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, 'v2-requirements-project', '2026-11-05T00:00:00.000Z');
      INSERT INTO requirements (id, title, created_at, project_id) VALUES ('REQ-001', '老需求', '2026-11-05T00:00:00.000Z', 'p-1');
    `);
    raw.close();
  }

  it("v2 老库迁移：memory 三表就位、v1/v2 既有数据不受影响、记录 v3", () => {
    const path = tmpDbPath("v3-from-v2");
    buildV2Db(path);
    const db = openDatabase(path);
    openDbs.push(db);
    for (const table of ["memory_batches", "memory_candidates"]) {
      expect(columnsOf(db, table), `迁移建表 ${table}`).toContain("id");
    }
    expect(columnsOf(db, "memory_summaries"), "memory_summaries 以 requirement_id 为主键").toContain("requirement_id");
    expect(columnsOf(db, "memory_candidates")).toEqual(
      expect.arrayContaining(["display_no", "edited_claim", "edited_scope", "conflicts_json", "notes_json", "md_path"]),
    );
    expect(db.prepare("SELECT title, project_id FROM requirements WHERE id = 'REQ-001'").get()).toEqual({ title: "老需求", project_id: "p-1" });
    const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as unknown as Array<{ version: number }>;
    expect(versions.map((r) => r.version)).toEqual([1, 2, 3, 4]);
  });

  it("v3 幂等重入：同库二次 openDatabase 不重复迁移、记录唯一", () => {
    const path = tmpDbPath("v3-idempotent");
    buildV2Db(path);
    openDbs.push(openDatabase(path));
    openDbs.push(openDatabase(path)); // 二次打开：v3 已记录 → 快路径跳过
    const n = (openDbs[openDbs.length - 1].prepare("SELECT count(*) AS n FROM schema_migrations WHERE version = 3").get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it("新库直建：openDatabase 内存库即 v4 形态（八表 + sessions 归档列 + 完整版本链），openDatabase 幂等", () => {
    const db = openDatabase(":memory:");
    openDbs.push(db);
    expect(listTables(db)).toEqual([
      "memory_batches", "memory_candidates", "memory_summaries",
      "projects", "requirements", "schema_migrations", "sessions", "stage_events",
    ]);
    const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as unknown as Array<{ version: number }>;
    expect(versions.map((r) => r.version)).toEqual([1, 2, 3, 4]);
    const again = openDatabase(":memory:");
    openDbs.push(again);
    expect(again.prepare("SELECT count(*) AS n FROM schema_migrations").get()).toEqual({ n: 4 });
  });

  it("迁移后 memory 三表可用（批次行写入往返）", () => {
    const path = tmpDbPath("v3-usable");
    buildV2Db(path);
    const db = openDatabase(path);
    openDbs.push(db);
    db.prepare("INSERT INTO memory_batches (id, requirement_id, project_id, status, created_at) VALUES ('B1','REQ-001','p-1','running','t')").run();
    expect(db.prepare("SELECT status FROM memory_batches WHERE id = 'B1'").get()).toEqual({ status: "running" });
  });
});

// ========== 新库直建 v2 形态 ==========
describe("迁移 v2：新库", () => {
  it("新库 requirements 直建 v2 形态（含 project_id 列），openDatabase 幂等", () => {
    const db = openDatabase(":memory:");
    openDbs.push(db);
    expect(listTables(db)).toEqual([
      "memory_batches", "memory_candidates", "memory_summaries",
      "projects", "requirements", "schema_migrations", "sessions", "stage_events",
    ]);
    expect(columnsOf(db, "requirements")).toContain("project_id");
    const again = openDatabase(":memory:");
    openDbs.push(again);
    expect(again.prepare("SELECT count(*) AS n FROM schema_migrations").get()).toEqual({ n: 4 });
  });
});

// ========== 迁移 v4（sessions 归档列，#58 spec #57 D 节） ==========
describe("迁移 v4：v3 老库 → sessions.archived_at", () => {
  /** v3 形态库：C3 五表（sessions 无 archived_at）+ memory 三表 + 版本行 [1,2,3]（真实 v3 库形状） */
  function buildV3Db(path: string, seed: (db: nodeSqlite.DatabaseSync) => void = () => {}): void {
    const raw = new RawDb(path);
    raw.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, canonical_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ok', created_at TEXT NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, cli TEXT NOT NULL, native_session_id TEXT, project_id TEXT REFERENCES projects(id), title TEXT, cwd TEXT, perm_mode TEXT, status TEXT, last_active_at TEXT, created_at TEXT NOT NULL);
      CREATE TABLE requirements (id TEXT PRIMARY KEY, title TEXT NOT NULL, stage TEXT, stage_basis_at INTEGER, stage_basis_json TEXT, uncertain INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, project_id TEXT);
      CREATE TABLE stage_events (event_id TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT, cli TEXT, skill TEXT, stage TEXT, requirement_id TEXT, occurred_at TEXT, received_at TEXT, seq TEXT, evidence_level TEXT NOT NULL, source TEXT, payload_json TEXT NOT NULL, processed_at TEXT NOT NULL);
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'v1-c3-base', '2026-11-05T00:00:00.000Z');
      INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, 'v2-requirements-project', '2026-11-06T00:00:00.000Z');
      INSERT INTO schema_migrations (version, name, applied_at) VALUES (3, 'v3-memory-tables', '2026-11-07T00:00:00.000Z');
    `);
    ensureMemoryTables(raw);
    seed(raw);
    raw.close();
  }

  it("v3 老库迁移：sessions 加 archived_at 可空列、现存行全部未归档、既有数据不动、记录 v4", () => {
    const path = tmpDbPath("v4-from-v3");
    buildV3Db(path, (db) => {
      seedProject(db, "p-1");
      seedSession(db, "s-1", "p-1");
      seedSession(db, "s-pty", null);
    });
    const db = openDatabase(path);
    openDbs.push(db);
    expect(columnsOf(db, "sessions")).toContain("archived_at");
    // 升级不搬动数据：现存行全部未归档（spec #57「老用户已有历史会话原样保留」）
    expect(db.prepare("SELECT count(*) AS n FROM sessions WHERE archived_at IS NOT NULL").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 2 });
    const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as unknown as Array<{ version: number }>;
    expect(versions.map((r) => r.version)).toEqual([1, 2, 3, 4]);
  });

  it("v4 幂等重入：同库二次 openDatabase 不重复迁移、版本记录唯一", () => {
    const path = tmpDbPath("v4-idempotent");
    buildV3Db(path);
    openDbs.push(openDatabase(path));
    openDbs.push(openDatabase(path)); // 二次打开：v4 已记录 → 快路径跳过
    const n = (openDbs[openDbs.length - 1].prepare("SELECT count(*) AS n FROM schema_migrations WHERE version = 4").get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it("事务中断（ALTER 已执行未提交）重入：SQLite 自动回滚 DDL，重入完整迁移（中途被杀安全）", () => {
    const path = tmpDbPath("v4-interrupted");
    buildV3Db(path, (db) => {
      seedProject(db, "p-1");
      seedSession(db, "s-1", "p-1");
    });
    {
      // 模拟迁移中途进程被杀：BEGIN 后 ALTER 未提交即断连（SQLite 自动回滚 DDL）
      const raw = new RawDb(path);
      raw.exec("BEGIN");
      raw.exec("ALTER TABLE sessions ADD COLUMN archived_at TEXT");
      raw.close();
    }
    const db = openDatabase(path); // 重入：完整迁移
    openDbs.push(db);
    expect(columnsOf(db, "sessions")).toContain("archived_at");
    expect(db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version = 4").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM sessions WHERE archived_at IS NOT NULL").get()).toEqual({ n: 0 });
  });

  it("新库直建 v4：sessions 含 archived_at 列，版本链 [1,2,3,4]", () => {
    const db = openDatabase(":memory:");
    openDbs.push(db);
    expect(columnsOf(db, "sessions")).toContain("archived_at");
    const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as unknown as Array<{ version: number }>;
    expect(versions.map((r) => r.version)).toEqual([1, 2, 3, 4]);
  });
});
