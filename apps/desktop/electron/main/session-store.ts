// 用途：sessions 表 store —— 会话落库/列表/状态与活跃时间更新（C3 表已在 db.ts 建好；重启恢复 = 新实例读同一库文件）
import type { PermMode, SessionStatus } from "@kanban/ipc-schema";
import type { SqliteDb } from "./db";

/** sessions 行（wire 形状见 sessionRowSchema；此处为 DB 记录面，目录身份由 Main 按需判定不入库） */
export interface SessionRecord {
  id: string;
  kind: "structured" | "pty";
  cli: string;
  nativeSessionId: string | null;
  projectId: string | null;
  title: string | null;
  cwd: string | null;
  permMode: PermMode | null;
  status: SessionStatus | null;
  lastActiveAt: string | null;
}

const COLS = "id, kind, cli, native_session_id, project_id, title, cwd, perm_mode, status, last_active_at";

/** sessions 表读写（INSERT 后状态流转经 updateStatus/touch 落库） */
export class SessionStore {
  constructor(private readonly db: SqliteDb) {}

  /** 新会话入库（id 为应用侧 uuid，由 Main 从 adapter.createSession 拿到后传入） */
  insert(rec: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO sessions (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.kind,
        rec.cli,
        rec.nativeSessionId,
        rec.projectId,
        rec.title,
        rec.cwd,
        rec.permMode,
        rec.status,
        rec.lastActiveAt,
      );
  }

  /** 列表（projectId 省略=全部，按 created_at 倒序：新会话在前） */
  list(projectId?: string): SessionRecord[] {
    const sql = projectId
      ? `SELECT ${COLS} FROM sessions WHERE project_id = ? ORDER BY created_at DESC, id`
      : `SELECT ${COLS} FROM sessions ORDER BY created_at DESC, id`;
    const rows = (projectId ? this.db.prepare(sql).all(projectId) : this.db.prepare(sql).all()) as unknown as Array<Record<string, unknown>>;
    return rows.map(rowToRecord);
  }

  /** 单行查询（#16：事件泵按 sessionId 注入会话项目用；不存在返回 null） */
  get(id: string): SessionRecord | null {
    const row = this.db.prepare(`SELECT ${COLS} FROM sessions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** 状态落库（session_status 事件到达时） */
  updateStatus(id: string, status: SessionStatus): void {
    this.db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(status, id);
  }

  /** 活跃时间更新（turn_started 等事件到达时） */
  touch(id: string, at: string): void {
    this.db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?").run(at, id);
  }

  /** 删除会话记录（#59 首条消息发送失败回滚用；幂等：不存在时静默成功） */
  delete(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }
}

/** snake_case 行 → camelCase 记录 */
function rowToRecord(r: Record<string, unknown>): SessionRecord {
  return {
    id: String(r.id),
    kind: r.kind as SessionRecord["kind"],
    cli: String(r.cli),
    nativeSessionId: (r.native_session_id as string | null) ?? null,
    projectId: (r.project_id as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    cwd: (r.cwd as string | null) ?? null,
    permMode: (r.perm_mode as PermMode | null) ?? null,
    status: (r.status as SessionStatus | null) ?? null,
    lastActiveAt: (r.last_active_at as string | null) ?? null,
  };
}
