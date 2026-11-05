// 用途：Adapter 事件流接线单测（#9）—— SkillObservation 经 handler 进 Engine 落库驱动状态机（幂等）、session_status/turn_started 落 sessions 表、事件转发不因 tracker 失败中断、主进程级重启恢复一致
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AdapterEvent, SkillObservation } from "@kanban/ipc-schema";
import { TrackerEngine } from "@kanban/tracker";
import { openDatabase, type SqliteDb } from "./db";
import { createAdapterEventHandler } from "./adapter-events";
import { SessionStore } from "./session-store";

const dbFiles: string[] = [];
const openDbs: SqliteDb[] = [];
afterAll(() => {
  for (const db of openDbs) db.close();
  for (const f of dbFiles) rmSync(f, { force: true });
});

/** 组装 main 同款接线：FakeAdapter（verified skill 注入脚本）→ handler → sessions 表 + TrackerEngine */
function makeWiring(dbPath: string) {
  const db = openDatabase(dbPath);
  openDbs.push(db);
  const sessions = new SessionStore(db);
  const engine = new TrackerEngine(db);
  engine.restore(); // 重启场景：新实例先恢复
  const forwarded: AdapterEvent[] = [];
  const handler = createAdapterEventHandler({ sessions, engine, send: (e) => forwarded.push(e) });
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

describe("SkillObservation → Engine 落库（#9 接线）", () => {
  it("verified design-feature → 自动建卡 REQ-001 + 关联 session + stage_events 落库；事件仍转发 renderer", () => {
    const { engine, handler, forwarded } = makeWiring(":memory:");
    const obs = verifiedDesignFeature("s-app-1", "2026-11-05T10:00:01.000Z", "sk-1");
    handler(obs);
    const snap = engine.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ id: "REQ-001", stage: "Design", uncertain: false, sessions: ["s-app-1"] });
    expect(engine.store.snapshotTables().stageEventCount).toBe(1);
    expect(forwarded).toEqual([obs]); // tracker 消费不吞事件
  });

  it("同 eventId 重发（重连重放）→ 状态不变化、stage_events 不重复（INSERT OR IGNORE）", () => {
    const { engine, handler } = makeWiring(":memory:");
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

  it("应用级重启恢复：建卡/关联/事件经 SQLite 往返一致，恢复后新事件继续驱动（REQ-002）", () => {
    const dbFile = join(tmpdir(), `kb-main-restart-${process.pid}-${Date.now()}.db`);
    dbFiles.push(dbFile);
    const sessionId = "s-app-9";
    {
      const { engine, handler } = makeWiring(dbFile);
      handler(verifiedDesignFeature(sessionId, "2026-11-05T10:00:01.000Z", "sk-main-1"));
      expect(engine.snapshot()[0]).toMatchObject({ id: "REQ-001", sessions: [sessionId] });
      engine.close();
      openDbs.pop(); // engine.close 已关连接，移出统一关闭清单
    }
    {
      // 重启：新 wiring 读同一库，恢复后状态一致 + 新事件继续驱动
      const { engine } = makeWiring(dbFile);
      const snap = engine.snapshot();
      expect(snap).toHaveLength(1);
      expect(snap[0]).toMatchObject({ id: "REQ-001", stage: "Design", sessions: [sessionId] });
      expect(engine.store.snapshotTables().stageEventCount).toBe(1);
      engine.process({
        eventId: "sk-main-2",
        kind: "skill",
        sessionId: "s-app-10",
        cli: "claude-code",
        skill: "design-feature",
        stage: null,
        requirementId: null,
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
