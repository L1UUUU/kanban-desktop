// 用途：kanban store 单测（#18）—— kanban:list 再水化整表替换 + TrackerChange 五补丁成员归并 + 快照引用稳定（useSyncExternalStore 兼容）
import { describe, expect, it } from "vitest";
import type { RequirementCardRow, StageBasisWire } from "@kanban/ipc-schema";
import { KanbanStore } from "./kanban-store";

const SKILL_BASIS: StageBasisWire = {
  kind: "skill",
  skill: "design-feature",
  cli: "claude-code",
  evidenceLevel: "verified",
  eventId: "sk-1",
  at: "2026-11-06T10:00:00.000Z",
};

function row(partial: Partial<RequirementCardRow> = {}): RequirementCardRow {
  return {
    id: "REQ-001",
    title: "待命名需求",
    stage: null,
    stageBasis: null,
    uncertain: false,
    projectId: "p1",
    sessions: [],
    ...partial,
  };
}

describe("KanbanStore（#18 事件驱动 store）", () => {
  it("hydrate：整表替换行与会话映射；快照引用在两次变更间稳定、变更后更新", () => {
    const s = new KanbanStore();
    const snap0 = s.getSnapshot();
    s.hydrate([row()], { "s-1": "REQ-001" });
    const snap1 = s.getSnapshot();
    expect(snap1).not.toBe(snap0);
    expect(snap1.requirements).toHaveLength(1);
    expect(snap1.requirements[0]?.id).toBe("REQ-001");
    expect(snap1.sessionToReq["s-1"]).toBe("REQ-001");
    expect(s.getSnapshot()).toBe(snap1); // 无变更时引用稳定（useSyncExternalStore 不死循环）
  });

  it("hydrate 清掉已消失的 activeRequirementId（选中卡片被删/再水化后不悬空）", () => {
    const s = new KanbanStore();
    s.hydrate([row()], {});
    s.setActive("REQ-001");
    s.hydrate([], {});
    expect(s.getSnapshot().activeRequirementId).toBeNull();
  });

  it("stage_changed：更新 stage/stageBasis/uncertain（移列与徽标的数据源）", () => {
    const s = new KanbanStore();
    s.hydrate([row()], {});
    s.applyTrackerChange({
      type: "stage_changed",
      requirementId: "REQ-001",
      stage: "Implement",
      basis: { ...SKILL_BASIS, skill: "implement-spec", evidenceLevel: "self_reported" },
      uncertain: true,
    });
    const r = s.getSnapshot().requirements[0]!;
    expect(r.stage).toBe("Implement");
    expect(r.uncertain).toBe(true);
    expect(r.stageBasis?.kind === "skill" && r.stageBasis.skill).toBe("implement-spec");
  });

  it("session_linked/unlinked：会话数组与反查映射双向更新", () => {
    const s = new KanbanStore();
    s.hydrate([row()], {});
    s.applyTrackerChange({ type: "session_linked", requirementId: "REQ-001", sessionId: "s-1" });
    s.applyTrackerChange({ type: "session_linked", requirementId: "REQ-001", sessionId: "s-2" });
    expect(s.getSnapshot().requirements[0]?.sessions).toEqual(["s-1", "s-2"]);
    expect(s.getSnapshot().sessionToReq).toEqual({ "s-1": "REQ-001", "s-2": "REQ-001" });
    // 快照不被就地修改污染（旧快照的映射保持旧值）
    s.applyTrackerChange({ type: "session_unlinked", requirementId: "REQ-001", sessionId: "s-1", stageKept: "Implement" });
    const after = s.getSnapshot();
    expect(after.requirements[0]?.sessions).toEqual(["s-2"]);
    expect(after.sessionToReq["s-1"]).toBeUndefined();
    expect(after.sessionToReq["s-2"]).toBe("REQ-001");
  });

  it("requirement_renamed / requirement_deleted：标题更新；删除移除卡片并清反查映射与选中", () => {
    const s = new KanbanStore();
    s.hydrate([row({ id: "REQ-001" }), row({ id: "REQ-002" })], { "s-1": "REQ-001", "s-2": "REQ-002" });
    s.setActive("REQ-001");
    s.applyTrackerChange({ type: "requirement_renamed", requirementId: "REQ-001", title: "阶段 2 看板" });
    expect(s.getSnapshot().requirements.find((r) => r.id === "REQ-001")?.title).toBe("阶段 2 看板");
    s.applyTrackerChange({ type: "requirement_deleted", requirementId: "REQ-001" });
    const snap = s.getSnapshot();
    expect(snap.requirements.map((r) => r.id)).toEqual(["REQ-002"]);
    expect(snap.sessionToReq).toEqual({ "s-2": "REQ-002" });
    expect(snap.activeRequirementId).toBeNull();
  });

  it("requirement_created：store 不猜缺失字段（no-op，由 controller 经 kanban:list 再水化补全）；未知 id 的补丁成员安全忽略", () => {
    const s = new KanbanStore();
    s.hydrate([row()], {});
    const before = s.getSnapshot();
    s.applyTrackerChange({ type: "requirement_created", requirementId: "REQ-009", stage: "Design", sessionId: "s-x" });
    expect(s.getSnapshot().requirements.map((r) => r.id)).toEqual(["REQ-001"]);
    s.applyTrackerChange({
      type: "stage_changed",
      requirementId: "REQ-404",
      stage: "PR",
      basis: SKILL_BASIS,
      uncertain: false,
    });
    const after = s.getSnapshot();
    expect(after.requirements[0]?.stage).toBeNull();
    expect(after.version).toBeGreaterThan(before.version); // created 分支不落卡片但仍视为一次刷新
  });

  it("订阅通知：变更触发监听器、注销后不再触发", () => {
    const s = new KanbanStore();
    let n = 0;
    const off = s.subscribe(() => {
      n += 1;
    });
    s.hydrate([row()], {});
    off();
    s.hydrate([], {});
    expect(n).toBe(1);
  });
});
