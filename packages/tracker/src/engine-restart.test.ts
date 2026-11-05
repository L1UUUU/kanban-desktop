// 用途：重启恢复单测 —— poc-4 run-e2e --verify-restart 的 7 项 check 演进（vitest；SQLite 落库→新实例读同一库→状态一致）+ 新增契约断言（需求投影表与事件重放态一致、恢复后 link 同步缓存往返）
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TrackerEngine } from "./engine";
import { mkLink, mkSkill, mkUnlink, openTestDb, T } from "./event-fixtures";

// 混合证据流场景（对应 e2e main：Claude hook 建卡 → Codex self_reported → OpenCode simulated + link 同步 → 解除关联）
const scenario = [
  mkSkill({ sessionId: "cs-1", cli: "claude-code", skill: "design-feature", at: T.t1, evidence: "verified" }), // 自动建卡 REQ-001 @ Design
  mkLink("cx-1", "REQ-001", T.t2, "codex"),
  mkSkill({ sessionId: "cx-1", cli: "codex", skill: "implement-spec", at: T.t3, evidence: "self_reported" }), // Implement + uncertain
  mkSkill({ sessionId: "co-1", cli: "opencode", skill: "pr", at: T.t4, evidence: "simulated" }), // 未关联：只记活动
  mkLink("co-1", "REQ-001", T.t5, "opencode"), // 按实际时间 t4 同步 → PR + uncertain
  mkUnlink("co-1", T.t6), // 解除关联：阶段保持
] as const;

const dbFile = join(tmpdir(), `kb-tracker-restart-${process.pid}-${Date.now()}.db`);
/** main 结束时的终态（供重启后逐项对比） */
let expected: ReturnType<TrackerEngine["snapshot"]>;
let expectedTables: ReturnType<TrackerEngine["store"]["snapshotTables"]>;
/** 重启后的引擎（beforeAll 内 restore） */
let eng: TrackerEngine;

afterAll(() => {
  eng?.close();
  rmSync(dbFile, { force: true });
});

beforeAll(() => {
  // phase 1：正常运行并落库后「退出」（close 连接，状态全部在 SQLite）
  {
    const e = new TrackerEngine(openTestDb(dbFile));
    for (const ev of scenario) e.process(ev);
    expected = e.snapshot();
    expectedTables = e.store.snapshotTables();
    e.close();
  }
  // phase 2：新实例读同一库恢复（退出重开）
  eng = new TrackerEngine(openTestDb(dbFile));
  eng.restore();
});

describe("重启恢复（poc-4 verify-restart 7 项演进）", () => {
  it("1. 重启后卡片数量与编号一致", () => {
    const snap = eng.snapshot();
    expect(snap.map((r) => r.id)).toEqual(expected.map((r) => r.id));
  });

  it("2. 重启后阶段与 uncertain 一致", () => {
    const snap = eng.snapshot();
    expect(snap.map((r) => [r.stage, r.uncertain])).toEqual(expected.map((r) => [r.stage, r.uncertain]));
    expect(snap[0]).toMatchObject({ stage: "PR", uncertain: true }); // unlink 后阶段保持 + simulated 依据
  });

  it("3. 重启后 Session 关联一致（co-1 已解除、cs-1/cx-1 仍在）", () => {
    const snap = eng.snapshot();
    expect(snap.map((r) => r.sessions)).toEqual(expected.map((r) => r.sessions));
    expect(snap[0]!.sessions).toEqual(["cs-1", "cx-1"]);
  });

  it("4. 重启后重放真实事件（同 eventId）→ 幂等不变化且不重复落库", () => {
    const histEvents = eng.store.listEvents();
    const realHookEv = histEvents.find((e) => e.evidenceLevel === "verified" && e.kind === "skill" && e.cli === "claude-code")!;
    const before = JSON.stringify(eng.snapshot());
    const rowsBefore = eng.store.snapshotTables().stageEventCount;
    const replay = eng.process(realHookEv);
    expect(replay.changes).toEqual([]);
    expect(JSON.stringify(eng.snapshot())).toBe(before);
    expect(eng.store.snapshotTables().stageEventCount).toBe(rowsBefore); // INSERT OR IGNORE 幂等
  });

  it("5. 重启后历史事件完整（stage_events 行数不丢失）", () => {
    const tables = eng.store.snapshotTables();
    expect(tables.stageEventCount).toBe(expectedTables.stageEventCount);
    expect(tables.stageEventCount).toBe(scenario.length);
  });

  it("6. 证据等级分布可查（verified/self_reported/simulated 均在库）", () => {
    const byEvidence = new Map(eng.store.snapshotTables().eventsByEvidence.map((r) => [r.evidence_level, r.n]));
    expect(byEvidence.get("verified")).toBeGreaterThan(0);
    expect(byEvidence.get("self_reported")).toBeGreaterThan(0);
    expect(byEvidence.get("simulated")).toBeGreaterThan(0);
  });

  it("7. 重启后新事件仍正常驱动（建卡编号从恢复点继续）", () => {
    const { changes } = eng.process(mkSkill({ sessionId: "cs-2", cli: "claude-code", skill: "design-feature", at: T.t7 }));
    expect(changes[0]).toMatchObject({ type: "requirement_created", requirementId: "REQ-002" });
  });
});

describe("重启恢复（新增契约断言）", () => {
  it("需求投影表（requirements 表）与事件重放态一致 —— 持久化无分叉", () => {
    // requirements 表按事件流 upsert 落库；restore 按事件重放。两者必须一致，否则持久化分叉
    const rows = eng.store.listRequirements(); // 含上一用例新建并已 persistAll 落库的 REQ-002
    const snap = eng.snapshot();
    expect(rows.map((r) => r.id).sort()).toEqual(snap.map((r) => r.id).sort());
    for (const r of snap) {
      const row = rows.find((x) => x.id === r.id)!;
      expect(row.stage).toBe(r.stage);
      expect(!!row.uncertain).toBe(r.uncertain);
    }
  });

  it("恢复后 link 同步仍可用（sessionEvents 缓存随事件日志往返）", () => {
    // co-1 的 pr 活动（t4）随 stage_events 重放恢复；重新关联后按实际时间同步
    const { changes } = eng.process(mkLink("co-1", "REQ-001", T.t8, "opencode"));
    expect(changes.some((c) => c.type === "session_linked")).toBe(true);
    const r = eng.snapshot().find((x) => x.id === "REQ-001")!;
    expect(r.stage).toBe("PR"); // t4 依据与当前一致（重放已到 PR），不回退
  });
});
