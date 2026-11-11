// 用途：sessions 表 store —— 会话落库/列表/状态与活跃时间更新（C3 表已在 db.ts 建好；重启恢复 = 新实例读同一库文件）；#58 起归档/取消归档/删除与未归档守卫（spec #57 D 节：迟到事件不得复活归档行）
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
  /** #58 归档时间（NULL=未归档；spec #57 D 节） */
  archivedAt: string | null;
}

const COLS = "id, kind, cli, native_session_id, project_id, title, cwd, perm_mode, status, last_active_at, archived_at";

/** sessions 表读写（INSERT 后状态流转经 updateStatus/touch 落库） */
export class SessionStore {
  constructor(private readonly db: SqliteDb) {}

  /** 新会话入库（id 为应用侧 uuid，由 Main 从 adapter.createSession 拿到后传入；新建恒未归档） */
  insert(rec: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO sessions (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        rec.archivedAt ?? null,
      );
  }

  /** 默认列表（projectId 省略=全部，按 created_at 倒序：新会话在前；#58 起排除已归档行） */
  list(projectId?: string): SessionRecord[] {
    const filter = projectId ? "project_id = ?" : "1 = 1";
    const sql = `SELECT ${COLS} FROM sessions WHERE archived_at IS NULL AND ${filter} ORDER BY created_at DESC, id`;
    const rows = (projectId ? this.db.prepare(sql).all(projectId) : this.db.prepare(sql).all()) as unknown as Array<Record<string, unknown>>;
    return rows.map(rowToRecord);
  }

  /** 全量列表（含已归档；仅退出收养/残留治理等内部路径用，spec #57 D 节） */
  listAll(): SessionRecord[] {
    const rows = this.db.prepare(`SELECT ${COLS} FROM sessions ORDER BY created_at DESC, id`).all() as unknown as Array<Record<string, unknown>>;
    return rows.map(rowToRecord);
  }

  /** 归档视图（设置面板用；按归档时间倒序，含归档时间展示字段） */
  listArchived(): SessionRecord[] {
    const rows = this.db
      .prepare(`SELECT ${COLS} FROM sessions WHERE archived_at IS NOT NULL ORDER BY archived_at DESC, id`)
      .all() as unknown as Array<Record<string, unknown>>;
    return rows.map(rowToRecord);
  }

  /** 单行查询（#16：事件泵按 sessionId 注入会话项目用；不存在返回 null） */
  get(id: string): SessionRecord | null {
    const row = this.db.prepare(`SELECT ${COLS} FROM sessions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** 状态落库（session_status 事件到达时；#58 守卫：已归档行不写——迟到事件不得复活归档行） */
  updateStatus(id: string, status: SessionStatus): void {
    this.db.prepare("UPDATE sessions SET status = ? WHERE id = ? AND archived_at IS NULL").run(status, id);
  }

  /** 活跃时间更新（turn_started 等事件到达时；#58 守卫：已归档行不写） */
  touch(id: string, at: string): void {
    this.db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ? AND archived_at IS NULL").run(at, id);
  }

  /** 归档（#58）：写归档时间标记；幂等——重复归档保留首次时间（COALESCE） */
  archive(id: string, at: string): void {
    this.db.prepare("UPDATE sessions SET archived_at = COALESCE(archived_at, ?) WHERE id = ?").run(at, id);
  }

  /** 取消归档（#58）：清标记 + 状态置 disconnected（进程已在归档时终止）+ 刷新活跃时间（自动归档基准重置）；幂等——仅已归档行被改动 */
  unarchive(id: string, at: string): void {
    this.db
      .prepare("UPDATE sessions SET archived_at = NULL, status = 'disconnected', last_active_at = ? WHERE id = ? AND archived_at IS NOT NULL")
      .run(at, id);
  }

  /** 删除（#58）：移除整行（含 native_session_id；#62 删除编排经 IPC 调用）；幂等——无行即 no-op */
  delete(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  /** 标题更新（#60：PTY 草稿先落库占位、spawn 成功后回写「终端 · shell」标题；spawn 失败回删占位行复用上方 #58 delete） */
  updateTitle(id: string, title: string): void {
    this.db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(title, id);
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
    archivedAt: (r.archived_at as string | null) ?? null,
  };
}
