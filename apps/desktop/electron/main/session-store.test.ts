// 用途：sessions 表 store 测试 —— 落库/列表过滤/状态与活跃时间更新/重启恢复（工单 #7 验收第 4/5 条）
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
