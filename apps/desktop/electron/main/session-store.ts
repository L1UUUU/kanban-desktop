// 用途：sessions 表 store（纯数据面，#70 C2 微加深）—— 会话落库/列表/状态与活跃时间更新（C3 表已在 db.ts 建好；重启恢复 = 新实例读同一库文件）；#58 起归档/取消归档/删除与未归档守卫（spec #57 D 节：迟到事件不得复活归档行）；#70 起 ChatEvent 落库收口 applyEvent + insert 缺省 idle（「新建恒 idle」决策收进 store），状态流转编排决策在 session-lifecycle；#94 起标题来源四态门控（ADR 0003：applyDerivedTitle 单向升级 / renameTitle 置 manual 终态 / updateTitle 保持 PTY 无条件写豁免）
import type { ChatEvent, PermMode, SessionStatus } from "@kanban/ipc-schema";
import type { SqliteDb } from "./db";

/** 会话标题来源四态（#94 / ADR 0003）：default（默认）→ derived（首条消息截断派生，单向）→ summarized（首轮摘要，T2）；manual（用户重命名，终态权威，吸收一切前态） */
export type TitleSource = "default" | "derived" | "summarized" | "manual";

/** sessions 行（wire 形状见 sessionRowSchema；此处为 DB 记录面，目录身份由 Main 按需判定不入库） */
export interface SessionRecord {
  id: string;
  kind: "structured" | "pty";
  cli: string;
  nativeSessionId: string | null;
  projectId: string | null;
  title: string | null;
  /** #94：标题来源（INSERT 可省略——缺省落 'default'；PTY 行永不进状态机，恒 'default' 无行为影响） */
  titleSource?: TitleSource;
  cwd: string | null;
  permMode: PermMode | null;
  /** 会话状态（INSERT 可省略——缺省落 idle，新建恒 idle；SELECT 读回恒非 undefined） */
  status?: SessionStatus | null;
  lastActiveAt: string | null;
  /** #58 归档时间（NULL=未归档；spec #57 D 节） */
  archivedAt: string | null;
  /** #64：创建时间（DB 默认生成，SELECT 读出携带；INSERT 可省略走默认。自动归档基准 COALESCE(last_active_at, created_at) 的回落数据源） */
  createdAt?: string | null;
}

/** INSERT 列（created_at 走 DB 默认值不显式写入） */
const COLS = "id, kind, cli, native_session_id, project_id, title, title_source, cwd, perm_mode, status, last_active_at, archived_at";
/** SELECT 列（INSERT 列 + created_at） */
const SELECT_COLS = `${COLS}, created_at`;

/** sessions 表读写（INSERT 后状态流转经 updateStatus/touch 落库） */
export class SessionStore {
  /** #62 已删除会话墓碑（内存态）：行删除后迟到事件守卫的判定依据——删除时进程已终止，重启后无迟到事件源，故不持久化 */
  private readonly deletedIds = new Set<string>();

  constructor(private readonly db: SqliteDb) {}

  /** 新会话入库（id 为应用侧 uuid，由 Main 从 adapter.createSession 拿到后传入；新建恒未归档恒 idle（status 缺省值）；createdAt 可省略走 DB 默认当前时刻；
   *  #62×#60：同 id 重插入（PTY 草稿 spawn 失败回删占位行后重试复用同 id）清除删除墓碑——重建即活会话 */
  insert(rec: SessionRecord): void {
    this.deletedIds.delete(rec.id);
    this.db
      .prepare(
        // created_at：显式值优先（测试/回填），缺省回落 DB 同款默认表达式（保持新库直建与老路径时间格式一致）
        `INSERT INTO sessions (${SELECT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`,
      )
      .run(
        rec.id,
        rec.kind,
        rec.cli,
        rec.nativeSessionId,
        rec.projectId,
        rec.title,
        rec.titleSource ?? "default", // #94：缺省 default（v5 列 NOT NULL DEFAULT 同款决策收进 store）
        rec.cwd,
        rec.permMode,
        rec.status ?? "idle", // #70：缺省 idle——「新建恒 idle」决策收进 store（调用方不再传）
        rec.lastActiveAt,
        rec.archivedAt ?? null,
        rec.createdAt ?? null,
      );
  }

  /** 默认列表（projectId 省略=全部，按 created_at 倒序：新会话在前；#58 起排除已归档行） */
  list(projectId?: string): SessionRecord[] {
    const filter = projectId ? "project_id = ?" : "1 = 1";
    const sql = `SELECT ${SELECT_COLS} FROM sessions WHERE archived_at IS NULL AND ${filter} ORDER BY created_at DESC, id`;
    const rows = (projectId ? this.db.prepare(sql).all(projectId) : this.db.prepare(sql).all()) as unknown as Array<Record<string, unknown>>;
    return rows.map(rowToRecord);
  }

  /** 全量列表（含已归档；仅退出收养/残留治理等内部路径用，spec #57 D 节） */
  listAll(): SessionRecord[] {
    const rows = this.db.prepare(`SELECT ${SELECT_COLS} FROM sessions ORDER BY created_at DESC, id`).all() as unknown as Array<Record<string, unknown>>;
    return rows.map(rowToRecord);
  }

  /** 归档视图（设置面板用；按归档时间倒序，含归档时间展示字段） */
  listArchived(): SessionRecord[] {
    const rows = this.db
      .prepare(`SELECT ${SELECT_COLS} FROM sessions WHERE archived_at IS NOT NULL ORDER BY archived_at DESC, id`)
      .all() as unknown as Array<Record<string, unknown>>;
    return rows.map(rowToRecord);
  }

  /** 单行查询（#16：事件泵按 sessionId 注入会话项目用；不存在返回 null） */
  get(id: string): SessionRecord | null {
    const row = this.db.prepare(`SELECT ${SELECT_COLS} FROM sessions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
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

  /** 删除（#58/#62）：移除整行（含 native_session_id；#62 删除编排经 IPC 调用）并记内存墓碑；幂等——无行即 no-op；
   *  #59 复用：session:create+firstMessage 发送失败回滚（回滚后重试生成全新 sessionId，不撞墓碑）；#60 复用：PTY spawn 失败回删占位行 */
  delete(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    this.deletedIds.add(id);
  }

  /** #62 迟到事件守卫（spec #57 D 节）：已删除（墓碑）或已归档的会话——迟到事件不写库不转发（杜绝幽灵行）；
   *  未知 id 放行（新建会话在 insert 前的窗口期事件照常，如 FakeAdapter createSession 返回前同步发出的 session_status） */
  shouldDropEvents(id: string): boolean {
    return this.deletedIds.has(id) || this.get(id)?.archivedAt != null;
  }

  /** ChatEvent 落库收口（#70 C2，事件泵唯一写入口）：迟到守卫（墓碑/归档行 → "dropped"，调用方不得转发/进 tracker）+
   *  session_status 写状态 / turn_started 写活跃时间（at 由调用方给，与原接线同取当前时刻）；其余 ChatEvent（session_error 等，#41）只吃守卫判定零写入 */
  applyEvent(ev: ChatEvent, at: string): "dropped" | "applied" {
    if (this.shouldDropEvents(ev.sessionId)) return "dropped";
    if (ev.type === "session_status") this.updateStatus(ev.sessionId, ev.status);
    else if (ev.type === "turn_started") this.touch(ev.sessionId, at);
    return "applied";
  }

  /** 标题更新（#60：PTY 草稿先落库占位、spawn 成功后回写「终端 · shell」标题；spawn 失败回删占位行复用上方 #58 delete；
   *  #94 / ADR 0003 PTY 豁免：无条件写且不动 title_source——PTY 行永不进状态机） */
  updateTitle(id: string, title: string): void {
    this.db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(title, id);
  }

  /** #94 / ADR 0003 派生标题门控写：仅 title_source='default' 时升级为 derived（单向，derived/manual 不被覆盖）；返回是否生效 */
  applyDerivedTitle(id: string, title: string): boolean {
    const r = this.db
      .prepare("UPDATE sessions SET title = ?, title_source = 'derived' WHERE id = ? AND title_source = 'default'")
      .run(title, id);
    return Number(r.changes) > 0;
  }

  /** #94 / ADR 0003 手动重命名：无条件写 title 并置 manual（终态权威，吸收一切前态；此后自动机制不再触碰该行标题） */
  renameTitle(id: string, title: string): void {
    this.db.prepare("UPDATE sessions SET title = ?, title_source = 'manual' WHERE id = ?").run(title, id);
  }

  /** #95 / ADR 0003 摘要标题门控写：仅 title_source='derived' 时升级为 summarized（单向；竞态下的 manual/已删行/已 summarized 均零行命中）；返回是否生效 */
  applySummarizedTitle(id: string, title: string): boolean {
    const r = this.db
      .prepare("UPDATE sessions SET title = ?, title_source = 'summarized' WHERE id = ? AND title_source = 'derived'")
      .run(title, id);
    return Number(r.changes) > 0;
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
    titleSource: ((r.title_source as TitleSource | null) ?? "default"),
    cwd: (r.cwd as string | null) ?? null,
    permMode: (r.perm_mode as PermMode | null) ?? null,
    status: (r.status as SessionStatus | null) ?? null,
    lastActiveAt: (r.last_active_at as string | null) ?? null,
    archivedAt: (r.archived_at as string | null) ?? null,
    createdAt: (r.created_at as string | null) ?? null,
  };
}
