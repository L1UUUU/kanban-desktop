// 用途：#16（spec #15 B/F 节）engine/store 演进单测 —— requirements 投影 project_id 落库、rename 投影、delete 墓碑删投影行不删事件日志、含 create/rename/delete 的事件日志重启重放态=退出态（防 P2 人工标题回退）
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TrackerEngine } from "./engine";
import { validateEvent } from "./schema";
import { mkCreate, mkDelete, mkLink, mkManual, mkRename, mkSkill, openTestDb, T } from "./event-fixtures";

// engine 持久化用例的临时库文件（Windows 关连接后清理）
const dbFiles: string[] = [];
afterAll(() => {
  for (const f of dbFiles) rmSync(f, { force: true });
});
function tmpDb(tag: string): string {
  const f = join(tmpdir(), `kb-tracker-s2-${tag}-${process.pid}-${Date.now()}.db`);
  dbFiles.push(f);
  return f;
}

// ========== 投影落库：project_id / rename / 墓碑删行 ==========
describe("S2-投影落库（requirements 表）", () => {
  it("自动建卡与手动建卡的 project_id 均落投影行", () => {
    const eng = new TrackerEngine(openTestDb(":memory:"));
    eng.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, projectId: "p-auto" }));
    eng.process(mkCreate("REQ-005", "p-manual", T.t2, "手动卡"));
    const rows = eng.store.listRequirements();
    expect(rows.map((r) => ({ id: r.id, project_id: r.project_id }))).toEqual([
      { id: "REQ-001", project_id: "p-auto" },
      { id: "REQ-005", project_id: "p-manual" },
    ]);
    eng.close();
  });

  it("rename 后投影行 title 同步（不被「待命名需求」回退）", () => {
    const eng = new TrackerEngine(openTestDb(":memory:"));
    eng.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, projectId: "p-1" }));
    eng.process(mkRename("REQ-001", "看板重构", T.t2));
    expect(eng.store.listRequirements()[0]).toMatchObject({ id: "REQ-001", title: "看板重构" });
    eng.close();
  });

  it("delete 墓碑后投影行删除（不残留），事件日志全保留", () => {
    const eng = new TrackerEngine(openTestDb(":memory:"));
    eng.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, projectId: "p-1" }));
    eng.process(mkSkill({ sessionId: "cs-1", skill: "implement-spec", at: T.t2, projectId: "p-1" }));
    eng.process(mkDelete("REQ-001", T.t3));
    expect(eng.store.listRequirements(), "投影删行").toEqual([]);
    // 事件日志永不删除：三条事件（含两条无 requirementId 的 skill 事件与 delete 墓碑本身）全部保留
    expect(eng.store.listEvents().map((e) => e.kind)).toEqual(["skill", "skill", "delete"]);
    expect(eng.store.snapshotTables().stageEventCount).toBe(3);
    eng.close();
  });
});

// ========== 墓碑重放矩阵（三态） ==========
describe("S2-墓碑重放矩阵", () => {
  it("auto-create→delete→同 eventId 重放（在线与重启后）均不复活", () => {
    const db = tmpDb("tombstone-replay");
    const del = mkDelete("REQ-001", T.t2);
    {
      const eng = new TrackerEngine(openTestDb(db));
      eng.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, projectId: "p-1" }));
      eng.process(del);
      // 在线重放同 eventId delete → duplicate_ignored，不复活
      const { changes } = eng.process(del);
      expect(changes).toEqual([]);
      expect(eng.snapshot()).toEqual([]);
      eng.close();
    }
    {
      // 重启后重放同 eventId delete → processed 幂等集随事件日志恢复，仍不复活
      const eng = new TrackerEngine(openTestDb(db));
      eng.restore();
      const { changes } = eng.process(del);
      expect(changes).toEqual([]);
      expect(eng.snapshot()).toEqual([]);
      eng.close();
    }
  });

  it("delete 后同会话再次 verified design-feature 建新卡（关联已解除）", () => {
    const db = tmpDb("tombstone-recreate");
    {
      const eng = new TrackerEngine(openTestDb(db));
      eng.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, projectId: "p-1" }));
      eng.process(mkDelete("REQ-001", T.t2));
      eng.close();
    }
    {
      const eng = new TrackerEngine(openTestDb(db));
      eng.restore();
      const { changes } = eng.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t3, projectId: "p-1", eventId: "ev-recreate" }));
      expect(changes[0]).toMatchObject({ type: "requirement_created", requirementId: "REQ-002", sessionId: "cs-1" });
      expect(eng.snapshot()[0]).toMatchObject({ id: "REQ-002", projectId: "p-1", sessions: ["cs-1"] });
      eng.close();
    }
  });
});

// ========== 重启重放态 = 退出态（含 create/rename/delete） ==========
describe("S2-重启重放态=退出态（含 create/rename/delete）", () => {
  it("混合事件流退出态与重启重放态逐项一致；人工标题保持；投影与重放态无分叉", () => {
    const db = tmpDb("mixed-replay");
    const events = [
      mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, projectId: "p-1" }), // 自动建卡 REQ-001 @ Design
      validateEvent(mkManual("REQ-001", "none", T.t2, "gui-stage-bar")), // 回到未开始
      mkSkill({ sessionId: "cs-1", skill: "implement-spec", at: T.t3, projectId: "p-1" }), // Implement
      mkRename("REQ-001", "看板重构", T.t4), // 人工标题
      mkLink("cx-1", "REQ-001", T.t5, "codex", "p-1"), // 关联第二会话
      mkCreate("REQ-005", "p-1", T.t6, "手动卡"), // 手动建卡（确定性 id）
      mkDelete("REQ-001", T.t7), // 墓碑删除 REQ-001
    ];
    let expected: ReturnType<TrackerEngine["snapshot"]>;
    {
      const eng = new TrackerEngine(openTestDb(db));
      for (const ev of events) eng.process(ev);
      expected = eng.snapshot();
      expect(expected).toEqual([
        { id: "REQ-005", title: "手动卡", stage: null, stageBasis: null, uncertain: false, sessions: [], projectId: "p-1" },
      ]);
      eng.close();
    }
    {
      const eng = new TrackerEngine(openTestDb(db));
      eng.restore();
      const snap = eng.snapshot();
      expect(snap, "重放态=退出态（含人工标题与确定性 id）").toEqual(expected);
      // 投影表与重放态一致（delete 后无残留行、create 后有 REQ-005）
      const rows = eng.store.listRequirements();
      expect(rows.map((r) => ({ id: r.id, title: r.title, project_id: r.project_id }))).toEqual([
        { id: "REQ-005", title: "手动卡", project_id: "p-1" },
      ]);
      // 事件日志完整保留（全部 7 条，含被删需求的历史与 delete 墓碑本身）
      expect(eng.store.snapshotTables().stageEventCount).toBe(events.length);
      expect(eng.store.listEvents().map((e) => e.kind)).toEqual(["skill", "manual", "skill", "rename", "link", "create", "delete"]);
      // 重放后 nextId 从恢复点继续（REQ-005 已占 5）
      const { changes } = eng.process(mkSkill({ sessionId: "cs-2", skill: "design-feature", at: T.t8, projectId: "p-1" }));
      expect(changes[0]).toMatchObject({ type: "requirement_created", requirementId: "REQ-006" });
      eng.close();
    }
  });
});
