// 用途：Adapter 事件流接线单测（#9）—— SkillObservation 经 handler 进 Engine 落库驱动状态机（幂等）、session_status/turn_started 落 sessions 表、事件转发不因 tracker 失败中断、主进程级重启恢复一致；#17 起 tracker 变更经 sendChange 推送（schema 化）
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AdapterEvent, SkillObservation } from "@kanban/ipc-schema";
import { trackerChangeSchema } from "@kanban/ipc-schema";
import { TrackerEngine, type TrackerChange } from "@kanban/tracker";
import { openDatabase, type SqliteDb } from "./db";
import { createAdapterEventHandler } from "./adapter-events";
import { SessionStore } from "./session-store";

const dbFiles: string[] = [];
const openDbs: SqliteDb[] = [];
afterAll(() => {
  for (const db of openDbs) db.close();
  for (const f of dbFiles) rmSync(f, { force: true });
});

/** 组装 main 同款接线：FakeAdapter（verified skill 注入脚本）→ handler → sessions 表 + TrackerEngine（#17 起可挂变更推送 spy） */
function makeWiring(dbPath: string, onChanges?: TrackerChange[], onLog?: (level: string, scope: string, message: string) => void) {
  const db = openDatabase(dbPath);
  openDbs.push(db);
  const sessions = new SessionStore(db);
  const engine = new TrackerEngine(db);
  engine.restore(); // 重启场景：新实例先恢复
  const forwarded: AdapterEvent[] = [];
  const handler = createAdapterEventHandler({
    sessions,
    engine,
    send: (e) => forwarded.push(e),
    sendChange: onChanges ? (c) => onChanges.push(c) : undefined,
    log: onLog,
  });
  return { db, sessions, engine, handler, forwarded };
}

/** verified design-feature 观察信号（模拟 Claude hook 口径；occurredAt/receivedAt/e 由发送方给全） */
function verifiedDesignFeature(sessionId: string, at: string, eventId: string): SkillObservation {
  return {
    eventId,
    kind: "skill",
    sessionId,
    cli: "claude-code",
    skill: "design-feature",
    stage: null,
    requirementId: null,
    occurredAt: at,
    receivedAt: at,
    seq: null,
    evidenceLevel: "verified",
    source: "hook-test",
  };
}

/** 插入挂项目的 sessions 行（#16 起事件泵按 sessions 表注入会话项目；project_id 有外键，先落 projects 行） */
function insertSession(db: SqliteDb, id: string, projectId: string | null): void {
  if (projectId) {
    db.prepare("INSERT OR IGNORE INTO projects (id, name, canonical_path, status, created_at) VALUES (?, 'p', 'C:\\p', 'ok', '2026-11-05T00:00:00Z')").run(projectId);
  }
  db.prepare(
    "INSERT INTO sessions (id, kind, cli, native_session_id, project_id, title, cwd, perm_mode, status, last_active_at) VALUES (?,'structured','claude-code',NULL,?,NULL,'C:\\p','auto','idle',NULL)",
  ).run(id, projectId);
}

// ========== #58 已归档会话的迟到事件守卫（spec #57 D 节：不写库、不转发渲染端——杜绝幽灵行） ==========
describe("已归档会话迟到事件守卫（#58）", () => {
  it("ChatEvent（session_status/turn_started）：不写库、不转发 renderer（不复活归档行）", () => {
    const { db, sessions, handler, forwarded } = makeWiring(":memory:");
    insertSession(db, "s-arch", "p-1");
    sessions.archive("s-arch", "2026-11-10T08:00:00.000Z");
    handler({ sessionId: "s-arch", seq: 1, at: "2026-11-10T09:00:00.000Z", type: "session_status", status: "running" });
    handler({ sessionId: "s-arch", seq: 2, at: "2026-11-10T09:00:01.000Z", type: "turn_started", turnId: "t-late" });
    const row = db.prepare("SELECT status, last_active_at FROM sessions WHERE id = 's-arch'").get() as { status: string | null; last_active_at: string | null };
    expect(row).toEqual({ status: "idle", last_active_at: null }); // 迟到事件零写入
    expect(forwarded).toEqual([]); // 不转发（renderer ensureView 不因迟到事件建幽灵行）
  });

  it("SkillObservation：不进 tracker（不自动建卡/不落 stage_events）、不转发", () => {
    const { db, sessions, engine, handler, forwarded } = makeWiring(":memory:");
    insertSession(db, "s-arch-2", "p-1");
    sessions.archive("s-arch-2", "2026-11-10T08:00:00.000Z");
    handler(verifiedDesignFeature("s-arch-2", "2026-11-10T09:00:00.000Z", "sk-late") as unknown as AdapterEvent);
    expect(engine.snapshot()).toEqual([]); // 不驱动状态机
    expect(db.prepare("SELECT count(*) AS n FROM stage_events").get()).toEqual({ n: 0 }); // 不落事件流
    expect(forwarded).toEqual([]);
  });

  it("未归档会话事件不受影响（守卫只拦已归档行）", () => {
    const { db, handler, forwarded } = makeWiring(":memory:");
    insertSession(db, "s-live", "p-1");
    handler({ sessionId: "s-live", seq: 1, at: "2026-11-10T09:00:00.000Z", type: "session_status", status: "running" });
    const row = db.prepare("SELECT status FROM sessions WHERE id = 's-live'").get() as { status: string | null };
    expect(row.status).toBe("running");
    expect(forwarded).toHaveLength(1);
  });
});

describe("SkillObservation → Engine 落库（#9 接线）", () => {
  it("verified design-feature（会话已挂项目）→ 自动建卡 REQ-001 归属项目 + 关联 session + stage_events 落库；事件仍转发 renderer", () => {
    const { db, engine, handler, forwarded } = makeWiring(":memory:");
    insertSession(db, "s-app-1", "p-1");
    const obs = verifiedDesignFeature("s-app-1", "2026-11-05T10:00:01.000Z", "sk-1");
    handler(obs);
    const snap = engine.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ id: "REQ-001", stage: "Design", uncertain: false, sessions: ["s-app-1"], projectId: "p-1" });
    expect(engine.store.snapshotTables().stageEventCount).toBe(1);
    expect(forwarded).toEqual([obs]); // tracker 消费不吞事件；转发 renderer 的原始事件不带 projectId
  });

  it("#16：无项目会话的 verified design-feature 不建卡（S2-18，事件泵注入 projectId=null）", () => {
    const { db, engine, handler } = makeWiring(":memory:");
    insertSession(db, "s-demo", null); // 演示链路：会话未挂项目
    handler(verifiedDesignFeature("s-demo", "2026-11-05T10:00:01.000Z", "sk-np"));
    expect(engine.snapshot()).toEqual([]);
    expect(engine.store.snapshotTables().stageEventCount, "事件仍落日志（审计）").toBe(1);
  });

  it("#17：SkillObservation 引发的 tracker 变更经 sendChange 推送（schema 化）；无项目不建卡则无推送", () => {
    const changes: TrackerChange[] = [];
    const { db, handler } = makeWiring(":memory:", changes);
    insertSession(db, "s-app-1", "p-1");
    handler(verifiedDesignFeature("s-app-1", "2026-11-05T10:00:01.000Z", "sk-push"));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ type: "requirement_created", requirementId: "REQ-001", stage: "Design", sessionId: "s-app-1" });
    expect(() => trackerChangeSchema.parse(changes[0]), "推送载荷过 zod 契约").not.toThrow();

    insertSession(db, "s-demo", null);
    handler(verifiedDesignFeature("s-demo", "2026-11-05T10:00:02.000Z", "sk-push-np"));
    expect(changes, "无项目会话不建卡 → 无变更推送").toHaveLength(1);
  });

  it("同 eventId 重发（重连重放）→ 状态不变化、stage_events 不重复（INSERT OR IGNORE）", () => {
    const { db, engine, handler } = makeWiring(":memory:");
    insertSession(db, "s-app-1", "p-1");
    handler(verifiedDesignFeature("s-app-1", "2026-11-05T10:00:01.000Z", "sk-dup"));
    const before = engine.snapshot();
    handler(verifiedDesignFeature("s-app-1", "2026-11-05T10:00:01.000Z", "sk-dup"));
    expect(engine.snapshot()).toEqual(before);
    expect(engine.store.snapshotTables().stageEventCount).toBe(1);
  });

  it("session_status/turn_started 落 sessions 表；非法观察事件（C2 校验失败）不落库但转发不断", () => {
    const { db, handler, forwarded } = makeWiring(":memory:");
    db.prepare(
      "INSERT INTO sessions (id, kind, cli, native_session_id, project_id, title, cwd, perm_mode, status, last_active_at) VALUES ('s-app-1','structured','claude',NULL,NULL,'t','C:\\p','auto','idle',NULL)",
    ).run();
    handler({ sessionId: "s-app-1", seq: 1, at: "2026-11-05T10:00:01.000Z", type: "turn_started", turnId: "t-1" });
    handler({ sessionId: "s-app-1", seq: 2, at: "2026-11-05T10:00:02.000Z", type: "session_status", status: "running" });
    const row = db.prepare("SELECT status, last_active_at FROM sessions WHERE id = 's-app-1'").get() as { status: string; last_active_at: string | null };
    expect(row.status).toBe("running");
    expect(row.last_active_at).toBeTruthy();

    // 非法 SkillObservation：证据等级不在枚举 → 出站契约校验丢弃（不抛出、不转发、不落库）
    const bad = { ...verifiedDesignFeature("s-app-1", "2026-11-05T10:00:03.000Z", "sk-bad"), evidenceLevel: "guessed" };
    expect(() => handler(bad as unknown as AdapterEvent)).not.toThrow();
    expect(forwarded).toHaveLength(2); // 只有两条合法 ChatEvent 被转发
  });

  it("session_error 不落库（#41 钉住）：sessions 表状态/活跃时间零写入，事件仍转发 renderer", () => {
    const { db, handler, forwarded } = makeWiring(":memory:");
    db.prepare(
      "INSERT INTO sessions (id, kind, cli, native_session_id, project_id, title, cwd, perm_mode, status, last_active_at) VALUES ('s-err-1','structured','codex',NULL,NULL,'t','C:\\p','auto','idle',NULL)",
    ).run();
    handler({ sessionId: "s-err-1", seq: 1, at: "2026-11-05T10:00:01.000Z", type: "session_error", code: "AUTH_EXPIRED", message: "登录态失效" });
    const row = db.prepare("SELECT status, last_active_at FROM sessions WHERE id = 's-err-1'").get() as { status: string; last_active_at: string | null };
    expect(row.status).toBe("idle"); // 错误不改写落库状态
    expect(row.last_active_at).toBeNull(); // 不触发活跃时间 touch
    expect(forwarded).toHaveLength(1); // renderer 呈现不受落库边界影响
  });

  it("#53 诊断日志：出站契约校验丢弃记一条 error（事件不转发不落库）；tracker 处理失败记一条 error（转发不断）；不传 log 时路径不抛错", () => {
    const entries: Array<{ level: string; scope: string; message: string }> = [];
    const log = (level: string, scope: string, message: string): void => { entries.push({ level, scope, message }); };
    const { db, handler, forwarded } = makeWiring(":memory:", undefined, log);
    db.prepare(
      "INSERT INTO sessions (id, kind, cli, native_session_id, project_id, title, cwd, perm_mode, status, last_active_at) VALUES ('s-1','structured','claude',NULL,NULL,'t','C:\\p','auto','idle',NULL)",
    ).run();
    // 非法 SkillObservation（证据等级不在枚举）→ 出站契约校验丢弃，记一条 error
    const bad = { ...verifiedDesignFeature("s-1", "2026-11-05T10:00:03.000Z", "sk-bad-log"), evidenceLevel: "guessed" };
    expect(() => handler(bad as unknown as AdapterEvent)).not.toThrow();
    expect(forwarded).toHaveLength(0);
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("error");
    expect(entries[0].message).toContain("事件不符合契约");
    // 合法事件但 tracker 处理失败（注入抛错的 engine 驱动 catch 路径）→ 记 error 后仍转发
    const forwarded2: AdapterEvent[] = [];
    const handler2 = createAdapterEventHandler({
      sessions: { get: () => null } as unknown as ReturnType<typeof makeWiring>["sessions"],
      engine: { process: (): never => { throw new Error("tracker 爆炸"); } } as unknown as ReturnType<typeof makeWiring>["engine"],
      send: (e) => forwarded2.push(e),
      log,
    });
    handler2(verifiedDesignFeature("s-1", "2026-11-05T10:00:04.000Z", "sk-trk-bad"));
    expect(forwarded2).toHaveLength(1); // tracker 失败不断消息流
    expect(entries).toHaveLength(2);
    expect(entries[1].message).toContain("tracker 事件处理失败");
    // 不传 log（缺省 no-op）：两条失败路径均不抛错
    const silent = makeWiring(":memory:");
    expect(() => silent.handler(bad as unknown as AdapterEvent)).not.toThrow();
  });

  it("应用级重启恢复：建卡/关联/事件经 SQLite 往返一致，恢复后新事件继续驱动（REQ-002）", () => {
    const dbFile = join(tmpdir(), `kb-main-restart-${process.pid}-${Date.now()}.db`);
    dbFiles.push(dbFile);
    const sessionId = "s-app-9";
    {
      const { db, engine, handler } = makeWiring(dbFile);
      insertSession(db, sessionId, "p-1");
      handler(verifiedDesignFeature(sessionId, "2026-11-05T10:00:01.000Z", "sk-main-1"));
      expect(engine.snapshot()[0]).toMatchObject({ id: "REQ-001", sessions: [sessionId], projectId: "p-1" });
      engine.close();
      openDbs.pop(); // engine.close 已关连接，移出统一关闭清单
    }
    {
      // 重启：新 wiring 读同一库，恢复后状态一致 + 新事件继续驱动
      const { db, engine } = makeWiring(dbFile);
      insertSession(db, "s-app-10", "p-1");
      const snap = engine.snapshot();
      expect(snap).toHaveLength(1);
      expect(snap[0]).toMatchObject({ id: "REQ-001", stage: "Design", sessions: [sessionId], projectId: "p-1" });
      expect(engine.store.snapshotTables().stageEventCount).toBe(1);
      engine.process({
        eventId: "sk-main-2",
        kind: "skill",
        sessionId: "s-app-10",
        cli: "claude-code",
        skill: "design-feature",
        stage: null,
        requirementId: null,
        projectId: "p-1",
        title: null,
        occurredAt: "2026-11-05T11:00:00.000Z",
        receivedAt: "2026-11-05T11:00:00.000Z",
        seq: null,
        evidenceLevel: "verified",
        source: "hook-test",
      });
      expect(engine.snapshot()[1]).toMatchObject({ id: "REQ-002" });
      engine.close();
      openDbs.pop();
    }
  });
});
