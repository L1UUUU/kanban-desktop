// 用途：SQLite 持久化层（node:sqlite DatabaseSync）—— requirements/sessions/stage_events 三张表，落库幂等（INSERT OR IGNORE），支持进程重启后恢复 tracker 全量状态
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const DDL = `
CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  stage TEXT,
  stage_basis_at INTEGER,
  stage_basis_json TEXT,
  uncertain INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  cli TEXT NOT NULL,
  requirement_id TEXT,
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
`;

export class Store {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(DDL);
    this.now = () => new Date().toISOString();
  }

  // 事件落库（同 eventId 重放天然幂等）
  appendEvent(ev) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO stage_events
         (event_id, kind, session_id, cli, skill, stage, requirement_id, occurred_at, received_at, seq, evidence_level, source, payload_json, processed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        ev.eventId, ev.kind, ev.sessionId, ev.cli, ev.skill, ev.stage, ev.requirementId,
        ev.occurredAt, ev.receivedAt, ev.seq == null ? null : String(ev.seq), ev.evidenceLevel, ev.source,
        JSON.stringify(ev), this.now(),
      );
  }

  // tracker 需求状态落库（全量 upsert，状态量小）
  saveRequirement(r) {
    this.db
      .prepare(
        `INSERT INTO requirements (id,title,stage,stage_basis_at,stage_basis_json,uncertain,created_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, stage=excluded.stage,
           stage_basis_at=excluded.stage_basis_at, stage_basis_json=excluded.stage_basis_json, uncertain=excluded.uncertain`,
      )
      .run(r.id, r.title, r.stage, r.stageBasisAt, JSON.stringify(r.stageBasis ?? null), r.uncertain ? 1 : 0, this.now());
  }

  saveSession(sessionId, cli, requirementId) {
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, cli, requirement_id, created_at) VALUES (?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET cli=excluded.cli, requirement_id=excluded.requirement_id`,
      )
      .run(sessionId, cli, requirementId, this.now());
  }

  // 全量导出 tracker 恢复态（重启恢复用）：需求终态 + session 映射 + 已处理事件 id + 各 session 已见 skill 事件
  loadTrackerState() {
    const reqRows = this.db.prepare("SELECT * FROM requirements ORDER BY id").all();
    const sessRows = this.db.prepare("SELECT * FROM sessions").all();
    const evRows = this.db.prepare("SELECT * FROM stage_events ORDER BY processed_at, rowid").all();
    const events = evRows.map((row) => JSON.parse(row.payload_json));

    const requirements = reqRows.map((r) => ({
      id: r.id,
      title: r.title,
      stage: r.stage,
      stageBasisAt: r.stage_basis_at,
      stageBasis: r.stage_basis_json ? JSON.parse(r.stage_basis_json) : null,
      uncertain: !!r.uncertain,
      sessions: sessRows.filter((s) => s.requirement_id === r.id).map((s) => s.session_id),
    }));

    const sessionEvents = new Map();
    for (const ev of events) {
      if (ev.kind !== "skill") continue;
      if (!sessionEvents.has(ev.sessionId)) sessionEvents.set(ev.sessionId, []);
      sessionEvents.get(ev.sessionId).push(ev);
    }

    return {
      requirements,
      sessionToReq: sessRows.filter((s) => s.requirement_id).map((s) => [s.session_id, s.requirement_id]),
      sessionCli: sessRows.map((s) => [s.session_id, s.cli]),
      sessionEvents: [...sessionEvents.entries()],
      processedEventIds: events.map((e) => e.eventId),
      nextId: requirements.length ? Math.max(...requirements.map((r) => Number(r.id.replace("REQ-", "")))) + 1 : 1,
    };
  }

  // 历史查询（解除关联后验证历史仍在 / RESULT 证据用）
  listEvents({ sessionId, requirementId } = {}) {
    let rows = this.db.prepare("SELECT * FROM stage_events ORDER BY processed_at, rowid").all();
    if (sessionId) rows = rows.filter((r) => r.session_id === sessionId);
    if (requirementId) rows = rows.filter((r) => r.requirement_id === requirementId);
    return rows.map(({ payload_json }) => JSON.parse(payload_json));
  }

  snapshotTables() {
    return {
      requirements: this.db.prepare("SELECT id,title,stage,stage_basis_at,uncertain FROM requirements ORDER BY id").all(),
      sessions: this.db.prepare("SELECT session_id,cli,requirement_id FROM sessions ORDER BY created_at").all(),
      stageEventCount: this.db.prepare("SELECT count(*) AS n FROM stage_events").get().n,
      eventsByEvidence: this.db.prepare("SELECT evidence_level, count(*) AS n FROM stage_events GROUP BY evidence_level").all(),
    };
  }

  close() {
    this.db.close();
  }
}

// 便捷函数：从 JSONL 文件读取归一化事件数组（复现/回放用）
export function readEventsJsonl(file) {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}
