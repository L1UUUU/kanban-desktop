// 用途：sessions 表 store 测试 —— 落库/列表过滤/状态与活跃时间更新/重启恢复（工单 #7 验收第 4/5 条）；#58 起归档/取消归档/删除与未归档守卫（spec #57 D 节）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDb } from "./db";
import { SessionStore, type SessionRecord } from "./session-store";

let tmpRoot = "";
let dbPath = "";
let db: SqliteDb | null = null;

afterEach(() => {
  db?.close();
  db = null;
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

/** 建临时 fixture：返回 store（db 文件落在临时目录内，afterEach 统一关连接）；预置 p-1/p-2 两个父项目行（FK 约束） */
function makeStore(): SessionStore {
  tmpRoot = mkdtempSync(join(tmpdir(), "kb-sessstore-"));
  dbPath = join(tmpRoot, "test.db");
  db = openDatabase(dbPath);
  for (const id of ["p-1", "p-2"]) {
    db.prepare("INSERT INTO projects (id, name, canonical_path, status, created_at) VALUES (?, ?, ?, 'ok', '2026-11-05T00:00:00.000Z')")
      .run(id, id, `C:\\${id}`);
  }
  return new SessionStore(db);
}

function makeRecord(partial: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s-1",
    kind: "structured",
    cli: "claude",
    nativeSessionId: null,
    projectId: "p-1",
    title: "新会话 · Claude",
    cwd: "C:\\repo",
    permMode: "auto",
    status: "idle",
    lastActiveAt: null,
    archivedAt: null,
    ...partial,
  };
}

describe("SessionStore", () => {
  it("insert + list：camelCase 往返；projectId 过滤", () => {
    const store = makeStore();
    store.insert(makeRecord({ id: "s-1", projectId: "p-1" }));
    store.insert(makeRecord({ id: "s-2", projectId: "p-2", cli: "codex", title: "新会话 · Codex" }));
    expect(store.list()).toHaveLength(2);
    const mine = store.list("p-1");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: "s-1", kind: "structured", cli: "claude", permMode: "auto", status: "idle" });
  });

  it("updateStatus / touch 落库并读回", () => {
    const store = makeStore();
    store.insert(makeRecord());
    store.updateStatus("s-1", "running");
    store.touch("s-1", "2026-11-05T01:02:03.000Z");
    const rec = store.list()[0];
    expect(rec.status).toBe("running");
    expect(rec.lastActiveAt).toBe("2026-11-05T01:02:03.000Z");
  });

  it("重启恢复：新实例读同一库文件，会话完整（含可空列与 PTY 形态）", () => {
    const store = makeStore();
    store.insert(makeRecord({ id: "s-1", nativeSessionId: "thread-abc", status: "waiting" }));
    store.insert(makeRecord({ id: "s-pty", kind: "pty", cli: "pty", nativeSessionId: null, projectId: null, permMode: null, title: "终端 · Codex" }));
    const reopenedDb = openDatabase(dbPath);
    const reopened = new SessionStore(reopenedDb);
    const byId = new Map(reopened.list().map((s) => [s.id, s]));
    expect(byId.get("s-1")).toMatchObject({ nativeSessionId: "thread-abc", status: "waiting" });
    expect(byId.get("s-pty")).toMatchObject({ kind: "pty", nativeSessionId: null, projectId: null, permMode: null });
    reopenedDb.close();
  });
});

describe("SessionStore 归档/取消归档/删除（#58 spec #57 D 节）", () => {
  it("archive：默认列表排除已归档；listArchived 返回归档时间；listAll 全量可见", () => {
    const store = makeStore();
    store.insert(makeRecord({ id: "s-1" }));
    store.insert(makeRecord({ id: "s-2", projectId: "p-2" }));
    store.archive("s-1", "2026-11-10T08:00:00.000Z");
    // 默认列表：只剩未归档行（projectId 过滤同样排除已归档）
    expect(store.list().map((r) => r.id)).toEqual(["s-2"]);
    expect(store.list("p-1")).toEqual([]);
    // 归档视图（设置面板）：含归档时间与展示字段
    expect(store.listArchived()).toEqual([
      expect.objectContaining({ id: "s-1", archivedAt: "2026-11-10T08:00:00.000Z", nativeSessionId: null, projectId: "p-1" }),
    ]);
    // 全量查询（退出收养/残留治理内部用）：归档行仍在
    expect(store.listAll().map((r) => r.id).sort()).toEqual(["s-1", "s-2"]);
  });

  it("重复归档幂等：首次归档时间保留，不产生重复副作用", () => {
    const store = makeStore();
    store.insert(makeRecord());
    store.archive("s-1", "2026-11-10T08:00:00.000Z");
    store.archive("s-1", "2026-11-11T09:00:00.000Z"); // 重复归档：返回成功、时间不覆盖
    expect(store.listArchived()[0].archivedAt).toBe("2026-11-10T08:00:00.000Z");
    // 未知 id 归档同样安全（无行可写）
    expect(() => store.archive("ghost", "2026-11-10T08:00:00.000Z")).not.toThrow();
  });

  it("unarchive：清归档标记、状态置 disconnected、刷新活跃时间、回默认列表", () => {
    const store = makeStore();
    store.insert(makeRecord({ status: "running" }));
    store.archive("s-1", "2026-11-10T08:00:00.000Z");
    store.unarchive("s-1", "2026-11-11T10:00:00.000Z");
    const rec = store.list()[0];
    expect(rec).toMatchObject({ id: "s-1", archivedAt: null, status: "disconnected", lastActiveAt: "2026-11-11T10:00:00.000Z" });
    expect(store.listArchived()).toEqual([]);
  });

  it("重复取消归档幂等：未归档行不再改动（活跃时间不重置）", () => {
    const store = makeStore();
    store.insert(makeRecord({ lastActiveAt: "2026-11-01T00:00:00.000Z" }));
    store.unarchive("s-1", "2026-11-11T10:00:00.000Z"); // 本就未归档：no-op
    expect(store.list()[0]).toMatchObject({ archivedAt: null, status: "idle", lastActiveAt: "2026-11-01T00:00:00.000Z" });
  });

  it("守卫：已归档行的 updateStatus/touch 不写库（迟到事件不得复活归档行）", () => {
    const store = makeStore();
    store.insert(makeRecord({ status: "idle" }));
    store.archive("s-1", "2026-11-10T08:00:00.000Z");
    store.updateStatus("s-1", "running"); // 迟到 session_status
    store.touch("s-1", "2026-11-12T00:00:00.000Z"); // 迟到 turn_started
    expect(store.listArchived()[0]).toMatchObject({ status: "idle", lastActiveAt: null });
  });

  it("delete：删除行（全量与归档视图均不可见）；重复删除幂等；数据与 native_session_id 一并移除", () => {
    const store = makeStore();
    store.insert(makeRecord({ id: "s-1", nativeSessionId: "thread-abc" }));
    store.archive("s-1", "2026-11-10T08:00:00.000Z");
    store.delete("s-1");
    expect(store.listAll()).toEqual([]);
    expect(store.listArchived()).toEqual([]);
    expect(() => store.delete("s-1")).not.toThrow(); // 幂等
  });

  it("shouldDropEvents（#62 迟到事件守卫）：已删除（内存墓碑）与已归档为 true，正常行为 false；未知 id 不拦截（新会话创建窗口期事件照常）", () => {
    const store = makeStore();
    store.insert(makeRecord({ id: "s-live" }));
    store.insert(makeRecord({ id: "s-arch", status: "idle" }));
    store.insert(makeRecord({ id: "s-gone" }));
    store.archive("s-arch", "2026-11-10T08:00:00.000Z");
    store.delete("s-gone");
    expect(store.shouldDropEvents("s-live")).toBe(false);
    expect(store.shouldDropEvents("s-arch")).toBe(true); // 已归档
    expect(store.shouldDropEvents("s-gone")).toBe(true); // 已删除（行已无，靠墓碑）
    expect(store.shouldDropEvents("ghost")).toBe(false); // 未知 id 放行（FakeAdapter 创建窗口期 session_status 照常转发）
  });

  it("重启读回：archived_at 随库文件往返（默认列表排除、归档视图可见）", () => {
    const store = makeStore();
    store.insert(makeRecord({ id: "s-1" }));
    store.archive("s-1", "2026-11-10T08:00:00.000Z");
    const reopenedDb = openDatabase(dbPath);
    const reopened = new SessionStore(reopenedDb);
    expect(reopened.list()).toEqual([]);
    expect(reopened.listArchived()[0]).toMatchObject({ id: "s-1", archivedAt: "2026-11-10T08:00:00.000Z" });
    reopenedDb.close();
  });
});
