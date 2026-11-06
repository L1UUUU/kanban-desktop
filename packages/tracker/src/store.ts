// 用途：SQLite 持久化层（演进自 poc-4 store.mjs；#16 起 requirements 加 project_id 列，与 apps/desktop db.ts v2 形态一致）—— requirements/stage_events 两表、stage_events INSERT OR IGNORE 落库幂等；DB 连接经注入（node:sqlite 实例，可临时文件/内存库）
import type { DatabaseSync } from "node:sqlite";
import type { NormalizedEvent } from "./schema";
import type { RequirementState } from "./tracker";

// C3 + #16 v2（spec #15 F 节）：requirements 加 project_id；stage_events 沿用冻结 DDL（新库直建 v2 形态；老库迁移在 apps/desktop db.ts）
const DDL = `
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
`;

/** stage_events 行的投影形状（诊断/断言用） */
export interface StageEventRow {
  event_id: string;
  kind: string;
  session_id: string | null;
  cli: string | null;
  skill: string | null;
  stage: string | null;
  requirement_id: string | null;
  occurred_at: string | null;
  received_at: string | null;
  seq: string | null;
  evidence_level: string;
  source: string | null;
  payload_json: string;
  processed_at: string;
}

/** requirements 表投影行 */
export interface RequirementRow {
  id: string;
  title: string;
  stage: string | null;
  stage_basis_at: number | null;
  stage_basis_json: string | null;
  uncertain: number;
  created_at: string;
  project_id: string | null;
}

export class Store {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(db: DatabaseSync, opts?: { now?: () => string }) {
    this.db = db;
    this.db.exec(DDL);
    this.now = opts?.now ?? (() => new Date().toISOString());
  }

  /** 事件落库（同 eventId 重放天然幂等） */
  appendEvent(ev: NormalizedEvent): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO stage_events
         (event_id, kind, session_id, cli, skill, stage, requirement_id, occurred_at, received_at, seq, evidence_level, source, payload_json, processed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        ev.eventId,
        ev.kind,
        ev.sessionId,
        ev.cli,
        ev.skill,
        ev.stage,
        ev.requirementId,
        ev.occurredAt,
        ev.receivedAt,
        ev.seq == null ? null : String(ev.seq),
        ev.evidenceLevel,
        ev.source || null,
        JSON.stringify(ev),
        this.now(),
      );
  }

  /** tracker 需求状态落库（全量 upsert 投影，状态量小；#16 起写 project_id） */
  saveRequirement(r: RequirementState & { stageBasisAt: number | null; stageBasis: RequirementState["stageBasis"] }): void {
    this.db
      .prepare(
        `INSERT INTO requirements (id,title,stage,stage_basis_at,stage_basis_json,uncertain,created_at,project_id)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, stage=excluded.stage,
           stage_basis_at=excluded.stage_basis_at, stage_basis_json=excluded.stage_basis_json, uncertain=excluded.uncertain,
           project_id=excluded.project_id`,
      )
      .run(r.id, r.title, r.stage, r.stageBasisAt, JSON.stringify(r.stageBasis ?? null), r.uncertain ? 1 : 0, this.now(), r.projectId ?? null);
  }

  /** 删除需求投影行（#16 墓碑：投影删行；事件日志 stage_events 永不删除） */
  deleteRequirement(id: string): void {
    this.db.prepare("DELETE FROM requirements WHERE id = ?").run(id);
  }

  /** 事件日志查询（按落库顺序；sessionId/requirementId 过滤）—— 恢复重放与历史审计共用 */
  listEvents(filter: { sessionId?: string; requirementId?: string } = {}): NormalizedEvent[] {
    const rows = this.db.prepare("SELECT * FROM stage_events ORDER BY processed_at, rowid").all() as unknown as StageEventRow[];
    let out = rows;
    if (filter.sessionId) out = out.filter((r) => r.session_id === filter.sessionId);
    if (filter.requirementId) out = out.filter((r) => r.requirement_id === filter.requirementId);
    return out.map((row) => JSON.parse(row.payload_json) as NormalizedEvent);
  }

  /** requirements 投影表行（一致性断言/阶段 2 看板读取用） */
  listRequirements(): RequirementRow[] {
    return this.db.prepare("SELECT * FROM requirements ORDER BY id").all() as unknown as RequirementRow[];
  }

  /** 关闭底层连接（Windows 上先关连接才能删临时文件） */
  close(): void {
    this.db.close();
  }

  /** 诊断/断言快照 */  snapshotTables(): {
    requirements: Array<{ id: string; stage: string | null; uncertain: number }>;
    stageEventCount: number;
    eventsByEvidence: Array<{ evidence_level: string; n: number }>;
  } {
    return {
      requirements: this.db.prepare("SELECT id, stage, uncertain FROM requirements ORDER BY id").all() as unknown as Array<{
        id: string;
        stage: string | null;
        uncertain: number;
      }>,
      stageEventCount: (this.db.prepare("SELECT count(*) AS n FROM stage_events").get() as { n: number }).n,
      eventsByEvidence: this.db.prepare("SELECT evidence_level, count(*) AS n FROM stage_events GROUP BY evidence_level").all() as unknown as Array<{
        evidence_level: string;
        n: number;
      }>,
    };
  }
}
