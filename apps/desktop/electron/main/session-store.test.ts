// 用途：sessions 表 store 测试 —— 落库/列表过滤/状态与活跃时间更新/重启恢复（工单 #7 验收第 4/5 条）；#58 起归档/取消归档/删除与未归档守卫（spec #57 D 节）；#70 起 applyEvent 落库收口（守卫+写入一体）与 insert 缺省 idle 密封钉住；arch C11 起忙态/进程存活谓词单点直测
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "@kanban/ipc-schema";
import { openDatabase, type SqliteDb } from "./db";
import { isSessionBusy, isStructuredProcessAlive, SessionStore, type SessionRecord } from "./session-store";

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

  it("墓碑复活（#62 × #60 合并语义）：同 id 重新 insert 后墓碑清除——PTY 草稿 spawn 失败回删占位行、重试复用同 id 创建成功后事件不得被误杀", () => {
    const store = makeStore();
    store.insert(makeRecord({ id: "tty-1", kind: "pty", cli: "pty" }));
    store.delete("tty-1"); // #60：spawn 失败回删占位行（进墓碑）
    expect(store.shouldDropEvents("tty-1")).toBe(true);
    store.insert(makeRecord({ id: "tty-1", kind: "pty", cli: "pty" })); // 重试复用同 id 重建
    expect(store.shouldDropEvents("tty-1")).toBe(false); // 重建后为活会话，迟到守卫不再命中
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

describe("SessionStore applyEvent 落库收口（#70 C2）", () => {
  /** 三类代表事件工厂（applyEvent 只吃 sessionId/type/status 面；落库时间 at 由调用方传） */
  const statusEvent = (sessionId: string): ChatEvent => ({ sessionId, seq: 1, at: "2026-11-10T09:00:00.000Z", type: "session_status", status: "running" });
  const turnStarted = (sessionId: string): ChatEvent => ({ sessionId, seq: 1, at: "2026-11-10T09:00:00.000Z", type: "turn_started", turnId: "t-1" });
  const errorEvent = (sessionId: string): ChatEvent => ({ sessionId, seq: 1, at: "2026-11-10T09:00:00.000Z", type: "session_error", code: "INTERNAL", message: "登录态失效" });

  it("session_status → 状态写；turn_started → 活跃时间写（at 由调用方给）；均返回 applied", () => {
    const store = makeStore();
    store.insert(makeRecord());
    expect(store.applyEvent(statusEvent("s-1"), "2026-11-11T10:00:00.000Z")).toBe("applied");
    expect(store.applyEvent(turnStarted("s-1"), "2026-11-11T10:00:01.000Z")).toBe("applied");
    expect(store.list()[0]).toMatchObject({ status: "running", lastActiveAt: "2026-11-11T10:00:01.000Z" });
  });

  it("守卫内建：已归档行 dropped（迟到 session_status/turn_started 均不写库）；已删除（墓碑）同样 dropped", () => {
    const store = makeStore();
    store.insert(makeRecord({ id: "s-arch" }));
    store.archive("s-arch", "2026-11-10T08:00:00.000Z");
    expect(store.applyEvent(statusEvent("s-arch"), "2026-11-11T10:00:00.000Z")).toBe("dropped");
    expect(store.applyEvent(turnStarted("s-arch"), "2026-11-11T10:00:00.000Z")).toBe("dropped");
    expect(store.listArchived()[0]).toMatchObject({ status: "idle", lastActiveAt: null }); // 迟到事件零写入

    store.insert(makeRecord({ id: "s-gone" }));
    store.delete("s-gone");
    expect(store.applyEvent(statusEvent("s-gone"), "2026-11-11T10:00:00.000Z")).toBe("dropped");
  });

  it("未知 id 放行（新会话创建窗口期事件照常，FakeAdapter createSession 返回前同步事件）", () => {
    const store = makeStore();
    expect(store.applyEvent(statusEvent("ghost"), "2026-11-11T10:00:00.000Z")).toBe("applied");
  });

  it("session_error 等其余 ChatEvent：守卫放行（applied）但零写入（#41 状态/活跃时间不动）", () => {
    const store = makeStore();
    store.insert(makeRecord());
    expect(store.applyEvent(errorEvent("s-1"), "2026-11-11T10:00:00.000Z")).toBe("applied");
    expect(store.list()[0]).toMatchObject({ status: "idle", lastActiveAt: null });
  });

  it("墓碑复活（#62 × #60）经收口 API 钉住：删除后 dropped → 同 id 重插后 applied 且写入生效", () => {
    const store = makeStore();
    store.insert(makeRecord({ id: "tty-1", kind: "pty", cli: "pty" }));
    store.delete("tty-1"); // PTY 草稿 spawn 失败回删占位行（进墓碑）
    expect(store.applyEvent(statusEvent("tty-1"), "2026-11-11T10:00:00.000Z")).toBe("dropped");
    store.insert(makeRecord({ id: "tty-1", kind: "pty", cli: "pty" })); // 同 id 重试重建
    expect(store.applyEvent(statusEvent("tty-1"), "2026-11-11T10:00:01.000Z")).toBe("applied");
    expect(store.list()[0]).toMatchObject({ id: "tty-1", status: "running" }); // 重建即活会话，事件照常写库
  });

  it("insert 缺省 idle（#70）：status 省略落 idle——「新建恒 idle」决策收进 store", () => {
    const store = makeStore();
    store.insert(makeRecord({ id: "s-no-status", status: undefined }));
    expect(store.list()[0]).toMatchObject({ id: "s-no-status", status: "idle" });
  });
});

describe("SessionStore 标题来源门控（#94 / ADR 0003 四态状态机）", () => {
  it("insert 列清单含 title_source：缺省 default、显式 derived 往返读回", () => {
    const store = makeStore();
    store.insert(makeRecord({ id: "s-1" }));
    store.insert(makeRecord({ id: "s-2", titleSource: "derived" }));
    const byId = new Map(store.list().map((s) => [s.id, s]));
    expect(byId.get("s-1")?.titleSource).toBe("default");
    expect(byId.get("s-2")?.titleSource).toBe("derived");
  });

  it("applyDerivedTitle 单向升级：仅 default 生效（返回 true）；derived 不再被派生覆盖", () => {
    const store = makeStore();
    store.insert(makeRecord({ title: "新会话 · Claude" }));
    expect(store.applyDerivedTitle("s-1", "首条消息标题")).toBe(true);
    expect(store.get("s-1")).toMatchObject({ title: "首条消息标题", titleSource: "derived" });
    // derived 态再派生（如老会话恢复后发第二条消息）：门控拒绝，标题保持首次派生值
    expect(store.applyDerivedTitle("s-1", "第二条消息标题")).toBe(false);
    expect(store.get("s-1")).toMatchObject({ title: "首条消息标题", titleSource: "derived" });
  });

  it("manual 吸收一切前态：renameTitle 后自动派生永不再覆盖（终态权威）", () => {
    const store = makeStore();
    store.insert(makeRecord({ title: "新会话 · Claude" }));
    store.renameTitle("s-1", "我起的名字");
    expect(store.get("s-1")).toMatchObject({ title: "我起的名字", titleSource: "manual" });
    expect(store.applyDerivedTitle("s-1", "随便什么消息")).toBe(false);
    expect(store.get("s-1")).toMatchObject({ title: "我起的名字", titleSource: "manual" });
    // derived → manual 同样吸收（重命名派生后的会话）
    store.insert(makeRecord({ id: "s-2", titleSource: "derived", title: "派生标题" }));
    store.renameTitle("s-2", "手动覆盖");
    expect(store.get("s-2")).toMatchObject({ title: "手动覆盖", titleSource: "manual" });
  });

  it("PTY 豁免：updateTitle 无条件写且不动 title_source（终端 shell 回写路径，行为零变化）", () => {
    const store = makeStore();
    store.insert(makeRecord({ id: "tty-1", kind: "pty", cli: "pty", title: "终端" }));
    store.updateTitle("tty-1", "终端 · pwsh");
    expect(store.get("tty-1")).toMatchObject({ title: "终端 · pwsh", titleSource: "default" });
  });

  it("未知会话：applyDerivedTitle 返回 false、renameTitle 安全 no-op", () => {
    const store = makeStore();
    expect(store.applyDerivedTitle("ghost", "x")).toBe(false);
    expect(() => store.renameTitle("ghost", "x")).not.toThrow();
  });

  it("applySummarizedTitle（#95）单向升级：仅 derived 生效；default/manual/summarized 不被摘要触碰", () => {
    const store = makeStore();
    // derived → summarized：生效
    store.insert(makeRecord({ id: "s-d", titleSource: "derived", title: "派生标题" }));
    expect(store.applySummarizedTitle("s-d", "模型摘要标题")).toBe(true);
    expect(store.get("s-d")).toMatchObject({ title: "模型摘要标题", titleSource: "summarized" });
    // summarized 终态：摘要重试（如重启后重触发）不再覆盖
    expect(store.applySummarizedTitle("s-d", "第二次摘要")).toBe(false);
    expect(store.get("s-d")).toMatchObject({ title: "模型摘要标题", titleSource: "summarized" });
    // default（未派生过）：无首轮对话语义，摘要不生效
    store.insert(makeRecord({ id: "s-def" }));
    expect(store.applySummarizedTitle("s-def", "x")).toBe(false);
    expect(store.get("s-def")).toMatchObject({ titleSource: "default" });
    // manual：终态权威，摘要竞态不覆盖
    store.insert(makeRecord({ id: "s-m", titleSource: "manual", title: "我起的名字" }));
    expect(store.applySummarizedTitle("s-m", "迟到摘要")).toBe(false);
    expect(store.get("s-m")).toMatchObject({ title: "我起的名字", titleSource: "manual" });
    // 已删行（摘要进行中用户删会话）：条件 UPDATE 零行命中，返回 false
    expect(store.applySummarizedTitle("ghost", "x")).toBe(false);
  });

  it("重启读回：title_source 随库文件往返（manual 权威跨重启保持）", () => {
    const store = makeStore();
    store.insert(makeRecord({ title: "新会话 · Claude" }));
    store.renameTitle("s-1", "跨重启的手动标题");
    const reopenedDb = openDatabase(dbPath);
    const reopened = new SessionStore(reopenedDb);
    expect(reopened.get("s-1")).toMatchObject({ title: "跨重启的手动标题", titleSource: "manual" });
    reopenedDb.close();
  });
});

// ============ 忙态/进程存活谓词单点（arch C11）============

describe("isSessionBusy / isStructuredProcessAlive 谓词（arch C11 单点）", () => {
  it("isSessionBusy：仅 running/waiting 为忙（须有序取消/拒绝切换），idle/interrupted/disconnected/null 均 false", () => {
    expect(isSessionBusy("running")).toBe(true);
    expect(isSessionBusy("waiting")).toBe(true);
    for (const idle of ["idle", "interrupted", "disconnected"] as const) expect(isSessionBusy(idle)).toBe(false);
    expect(isSessionBusy(null)).toBe(false);
    expect(isSessionBusy(undefined)).toBe(false);
  });

  it("isStructuredProcessAlive：状态存在且非 disconnected 即本运行内句柄仍在；disconnected/null/undefined 保守视为不在", () => {
    for (const alive of ["idle", "running", "waiting", "interrupted"] as const) expect(isStructuredProcessAlive(alive)).toBe(true);
    expect(isStructuredProcessAlive("disconnected")).toBe(false);
    expect(isStructuredProcessAlive(null)).toBe(false);
    expect(isStructuredProcessAlive(undefined)).toBe(false);
  });
});
