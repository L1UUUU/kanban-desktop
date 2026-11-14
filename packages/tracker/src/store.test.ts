// 用途：Store 密封测试（arch D6）—— 投影落库单事务直测（批量 upsert + 墓碑对账 + 任一行失败整体回滚）与 listEvents 过滤下推 SQL 的行为等价
import { afterEach, describe, expect, it } from "vitest";
import { mkLink, mkManual, mkSkill, openTestDb } from "./event-fixtures";
import { Store, type RequirementRow } from "./store";
import type { RequirementState } from "./tracker";

// 测试内即时开关的 Store（内存库 + 递增时钟，保证 processed_at 排序确定）
let store: Store | null = null;
function mkStore(): Store {
  let tick = 0;
  store = new Store(openTestDb(":memory:"), { now: () => new Date(Date.UTC(2026, 0, 1) + tick++ * 1000).toISOString() });
  return store;
}
afterEach(() => {
  store?.close();
  store = null;
});

/** 投影行工厂（session 关联不落 requirements 表，缺省空集） */
function mkReqState(id: string, overrides: Partial<RequirementState> = {}): RequirementState {
  return { id, title: `标题-${id}`, stage: null, stageBasisAt: null, stageBasis: null, uncertain: false, sessions: new Set(), projectId: "p-1", ...overrides };
}

describe("saveProjection 投影落库单事务", () => {
  it("批量 upsert 落库；重复投影幂等且 created_at 保持首次插入值", () => {
    const s = mkStore();
    s.saveProjection([mkReqState("REQ-001"), mkReqState("REQ-005")]);
    expect(s.listRequirements().map((r) => r.id)).toEqual(["REQ-001", "REQ-005"]);
    const createdAt = new Map(s.listRequirements().map((r) => [r.id, r.created_at]));
    // 再次落库：title 更新生效、不产生重复行、created_at 不被覆盖
    s.saveProjection([mkReqState("REQ-001", { title: "改名后" }), mkReqState("REQ-005")]);
    const rows = s.listRequirements();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === "REQ-001")).toMatchObject({ title: "改名后" });
    for (const r of rows) expect(r.created_at).toBe(createdAt.get(r.id));
  });

  it("墓碑对账：快照外的残留行删除；stage_events 事件日志不动", () => {
    const s = mkStore();
    s.saveProjection([mkReqState("REQ-001"), mkReqState("REQ-002")]);
    s.appendEvent(mkSkill({ sessionId: "cs-1" }));
    s.saveProjection([mkReqState("REQ-002")]); // REQ-001 已不在内存态（被删）→ 投影删行
    expect(s.listRequirements().map((r) => r.id)).toEqual(["REQ-002"]);
    expect(s.snapshotTables().stageEventCount, "事件日志永不删除").toBe(1);
  });

  it("单事务原子性：任一行写入失败整体回滚，投影无半态", () => {
    const s = mkStore();
    s.saveProjection([mkReqState("REQ-001", { stage: "Design" })]);
    // 第二行 title 非空约束失败 → 第一行已执行的 upsert 也必须回滚
    const bad = { ...mkReqState("REQ-BAD"), title: null as unknown as string };
    expect(() => s.saveProjection([mkReqState("REQ-001", { stage: "Implement" }), bad])).toThrow();
    const rows: RequirementRow[] = s.listRequirements();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "REQ-001", stage: "Design" });
    // 回滚后连接仍可用（无未决事务残留）
    s.saveProjection([mkReqState("REQ-001", { stage: "Implement" })]);
    expect(s.listRequirements()[0]).toMatchObject({ id: "REQ-001", stage: "Implement" });
  });
});

describe("listEvents 过滤下推 SQL", () => {
  it("sessionId/requirementId 过滤与排序契约保持（返回形状为归一化事件）", () => {
    const s = mkStore();
    const ev1 = mkSkill({ sessionId: "s-a", skill: "design-feature" });
    const ev2 = mkSkill({ sessionId: "s-b", skill: "implement-spec", at: ev1.occurredAt });
    const ev3 = mkLink("s-b", "REQ-001", ev1.occurredAt);
    const ev4 = mkManual("REQ-002", "none", ev1.occurredAt);
    for (const ev of [ev1, ev2, ev3, ev4]) s.appendEvent(ev);

    expect(s.listEvents(), "无过滤全量、按落库顺序").toEqual([ev1, ev2, ev3, ev4]);
    expect(s.listEvents({ sessionId: "s-b" })).toEqual([ev2, ev3]);
    expect(s.listEvents({ requirementId: "REQ-001" })).toEqual([ev3]);
    expect(s.listEvents({ sessionId: "s-b", requirementId: "REQ-001" }), "组合过滤取交集").toEqual([ev3]);
    expect(s.listEvents({ requirementId: "REQ-404" }), "无匹配返回空数组").toEqual([]);
  });
});
