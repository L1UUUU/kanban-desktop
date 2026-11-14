// 用途：#16（spec #15 B 节）状态机演进单测 —— 手动 create/rename/delete、需求归属 projectId（sessionProject 记忆/无项目不建卡/跨项目 link 拒绝）、manual none 归一、uncertain 确认与转正；arch D1 起 link 规则单源判定 linkVerdict 在此覆盖
import { describe, expect, it } from "vitest";
import { validateEvent } from "./schema";
import { RequirementTracker } from "./tracker";
import { mkCreate, mkDelete, mkLink, mkManual, mkRename, mkSkill, T } from "./event-fixtures";

// ========== 手动建卡（create） ==========
describe("S2-手动建卡 create", () => {
  it("create 采用事件确定性 requirementId 建卡，projectId 入态，change 的 sessionId 为空", () => {
    const tr = new RequirementTracker();
    const ch = tr.process(mkCreate("REQ-001", "p-1", T.t1, "登录重构"));
    expect(ch).toEqual([{ type: "requirement_created", requirementId: "REQ-001", stage: null, sessionId: null }]);
    const snap = tr.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ id: "REQ-001", title: "登录重构", stage: null, projectId: "p-1", sessions: [] });
  });

  it("create 推进 nextId：编号跳过已用的确定性 id，后续自动建卡不冲突", () => {
    const tr = new RequirementTracker();
    tr.process(mkCreate("REQ-005", "p-1", T.t1, "手动卡"));
    const ch = tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t2, projectId: "p-1" }));
    expect(ch[0]).toMatchObject({ type: "requirement_created", requirementId: "REQ-006" });
  });

  it("create 已存在 requirementId（不同 eventId）幂等忽略（duplicate_id_ignored）", () => {
    const tr = new RequirementTracker();
    tr.process(mkCreate("REQ-001", "p-1", T.t1, "第一张"));
    const ch = tr.process(mkCreate("REQ-001", "p-1", T.t2, "同名不同事件"));
    expect(ch).toEqual([]);
    expect(tr.requirements.size).toBe(1);
    expect(tr.req("REQ-001")!.title, "标题不被第二次 create 覆盖").toBe("第一张");
    expect(tr.log.some((l) => l.decision === "duplicate_id_ignored")).toBe(true);
  });
});

// ========== 标题编辑与墓碑删除 ==========
describe("S2-标题编辑 rename / 墓碑 delete", () => {
  it("rename 更新需求标题并发出 requirement_renamed；未知需求忽略", () => {
    const tr = new RequirementTracker();
    tr.process(mkCreate("REQ-001", "p-1", T.t1));
    const ch = tr.process(mkRename("REQ-001", "新标题", T.t2));
    expect(ch).toEqual([{ type: "requirement_renamed", requirementId: "REQ-001", title: "新标题" }]);
    expect(tr.snapshot()[0]!.title).toBe("新标题");
    expect(tr.process(mkRename("REQ-404", "幽灵", T.t3))).toEqual([]);
    expect(tr.log.some((l) => l.decision === "rename_no_requirement")).toBe(true);
  });

  it("delete 墓碑：移除内存态、解除全部会话关联并发出 requirement_deleted", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, projectId: "p-1" })); // REQ-001 + cs-1
    tr.process(mkLink("cx-1", "REQ-001", T.t2, "codex", "p-1"));
    const ch = tr.process(mkDelete("REQ-001", T.t3));
    expect(ch).toEqual([{ type: "requirement_deleted", requirementId: "REQ-001" }]);
    expect(tr.requirements.size).toBe(0);
    expect(tr.sessionToReq.get("cs-1"), "全部关联解除").toBeUndefined();
    expect(tr.sessionToReq.get("cx-1")).toBeUndefined();
  });

  it("delete 后同会话再次 verified design-feature 建新卡（可重新组织）", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, projectId: "p-1" })); // REQ-001
    tr.process(mkDelete("REQ-001", T.t2));
    const ch = tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t3, projectId: "p-1" }));
    expect(ch[0]).toMatchObject({ type: "requirement_created", requirementId: "REQ-002" });
    expect(tr.sessionToReq.get("cs-1")).toBe("REQ-002");
  });

  it("delete 未知需求幂等无变化", () => {
    const tr = new RequirementTracker();
    expect(tr.process(mkDelete("REQ-404", T.t1))).toEqual([]);
  });
});

// ========== 需求归属项目（S2-08 / S2-18） ==========
describe("S2-需求归属项目", () => {
  it("无项目 skill 事件不建卡（unprojected_no_card，S2-18）", () => {
    const tr = new RequirementTracker();
    const ch = tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, projectId: null }));
    expect(ch).toEqual([]);
    expect(tr.requirements.size).toBe(0);
    expect(tr.log.some((l) => l.decision === "unprojected_no_card")).toBe(true);
  });

  it("带项目 skill 事件自动建卡写入 projectId（快照可见）", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, projectId: "p-kanban" }));
    expect(tr.snapshot()[0]).toMatchObject({ id: "REQ-001", projectId: "p-kanban" });
  });

  it("sessionProject 记忆：首个带 projectId 的事件习得，后续无 projectId 事件沿用记忆", () => {
    const tr = new RequirementTracker();
    // 先出现一个不带建卡语义的带项目事件（self_reported design-feature 不建卡但习得项目）
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, evidence: "self_reported", projectId: "p-1" }));
    expect(tr.sessionProject.get("cs-1")).toBe("p-1");
    // 后续 verified 建卡事件未携带 projectId（旧链路），沿用记忆归属
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t2, evidence: "verified", projectId: null }));
    expect(tr.snapshot()[0]).toMatchObject({ id: "REQ-001", projectId: "p-1" });
  });

  it("跨项目 link 拒绝（link_project_mismatch）且不建立关联", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, projectId: "p-1" })); // REQ-001 @ p-1
    const ch = tr.process(mkLink("cx-1", "REQ-001", T.t2, "codex", "p-2")); // cx-1 属 p-2
    expect(ch).toEqual([]);
    expect(tr.sessionToReq.has("cx-1")).toBe(false);
    const entry = tr.log.find((l) => l.decision === "link_project_mismatch");
    expect(entry, "拒绝原因进决策日志供 IPC 透出").toBeTruthy();
    expect(entry).toMatchObject({ sessionId: "cx-1", requirementId: "REQ-001" });
  });

  it("无项目会话 link 拒绝（link_unprojected_rejected）", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, projectId: "p-1" })); // REQ-001
    const ch = tr.process(mkLink("cx-1", "REQ-001", T.t2, "codex", null)); // cx-1 无项目
    expect(ch).toEqual([]);
    expect(tr.sessionToReq.has("cx-1")).toBe(false);
    expect(tr.log.some((l) => l.decision === "link_unprojected_rejected")).toBe(true);
  });

  it("同项目 link 成功；pty 会话亦可关联（纯组织用途）", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, projectId: "p-1" })); // REQ-001
    const ch = tr.process(mkLink("cx-1", "REQ-001", T.t2, "codex", "p-1"));
    expect(ch.some((c) => c.type === "session_linked")).toBe(true);
    const chPty = tr.process(mkLink("s-pty", "REQ-001", T.t3, "pty", "p-1"));
    expect(chPty.some((c) => c.type === "session_linked"), "pty 终端会话可关联（S2-12）").toBe(true);
    expect(tr.sessionCli.get("s-pty")).toBe("pty");
  });
});

// ========== link 规则单源判定（arch D1：IPC 前置查询） ==========
describe("linkVerdict（arch D1 单源判定）", () => {
  it("同项目 → proceed 并回传会话项目；判定只读——不落 decision log、不建立关联", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, projectId: "p-1" })); // REQ-001
    const logLen = tr.log.length;
    expect(tr.linkVerdict("cx-1", "REQ-001", "p-1")).toEqual({ outcome: "proceed", projectId: "p-1" });
    expect(tr.log.length).toBe(logLen);
    expect(tr.sessionToReq.has("cx-1")).toBe(false);
  });

  it("已关联同一需求 → idempotent；已关联他卡 → session_conflict（携带当前归属）", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, projectId: "p-1" })); // REQ-001
    tr.process(mkLink("cx-1", "REQ-001", T.t2, "codex", "p-1"));
    tr.process(mkCreate("REQ-002", "p-1", T.t3, "他卡"));
    expect(tr.linkVerdict("cx-1", "REQ-001", "p-1")).toEqual({ outcome: "idempotent" });
    expect(tr.linkVerdict("cx-1", "REQ-002", "p-1")).toEqual({
      outcome: "rejected",
      reason: { kind: "session_conflict", sessionId: "cx-1", requirementId: "REQ-002", currentRequirementId: "REQ-001" },
    });
  });

  it("需求不存在 / 会话无项目 / 跨项目 → 对应结构化拒绝原因", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, projectId: "p-1" })); // REQ-001
    expect(tr.linkVerdict("cx-1", "REQ-404", "p-1")).toEqual({
      outcome: "rejected",
      reason: { kind: "requirement_absent", requirementId: "REQ-404" },
    });
    expect(tr.linkVerdict("cx-1", "REQ-001", null)).toEqual({
      outcome: "rejected",
      reason: { kind: "session_unprojected", sessionId: "cx-1", requirementId: "REQ-001" },
    });
    expect(tr.linkVerdict("cx-1", "REQ-001", "p-2")).toEqual({
      outcome: "rejected",
      reason: { kind: "project_mismatch", sessionId: "cx-1", requirementId: "REQ-001", sessionProjectId: "p-2", requirementProjectId: "p-1" },
    });
  });

  it("判定与 onLink 兜底同规则：proceed 的 link 事件必关联，跨项目事件直进状态机仍被拒且决策日志保留", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, projectId: "p-1" })); // REQ-001
    const verdict = tr.linkVerdict("cx-1", "REQ-001", "p-1");
    if (verdict.outcome !== "proceed") throw new Error("同项目应放行");
    const ch = tr.process(mkLink("cx-1", "REQ-001", T.t2, "codex", verdict.projectId));
    expect(ch.some((c) => c.type === "session_linked")).toBe(true);
    tr.process(mkCreate("REQ-002", "p-1", T.t3, "同项目他卡"));
    const chReject = tr.process(mkLink("cx-9", "REQ-002", T.t4, "codex", "p-2")); // cx-9 属 p-2，直进状态机仍拦
    expect(chReject).toEqual([]);
    const entry = tr.log.find((l) => l.decision === "link_project_mismatch");
    expect(entry).toMatchObject({ sessionId: "cx-9", requirementId: "REQ-002", sessionProject: "p-2", requirementProject: "p-1" });
  });
});

// ========== manual none 归一（S2-05 回到未开始） ==========
describe("S2-manual none 归一", () => {
  it("manual stage=none 经 validateEvent 归一 null，需求回到未开始", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, projectId: "p-1" }));
    const ev = validateEvent(mkManual("REQ-001", "none", T.t2, "gui-stage-bar"));
    expect(ev.stage).toBeNull();
    const ch = tr.process(ev);
    expect(ch[0]).toMatchObject({ type: "stage_changed", stage: null, uncertain: false });
    expect(tr.snapshot()[0]!.stage).toBeNull();
  });

  it("manual none 之后新的有效事件仍可覆盖（不永久锁定）", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, projectId: "p-1" }));
    tr.process(validateEvent(mkManual("REQ-001", "none", T.t2, "gui-stage-bar"))); // 回到未开始（basisAt=t2）
    tr.process(mkSkill({ sessionId: "cs-1", skill: "pr", at: T.t3, projectId: "p-1" })); // 更新发生
    expect(tr.snapshot()[0]!.stage, "none 后可被后续事件覆盖").toBe("PR");
  });
});

// ========== uncertain 确认与转正（S2-04） ==========
describe("S2-uncertain 确认与转正", () => {
  it("manual 确认后迟到的 verified（occurredAt 更早）不覆盖已确认阶段", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, projectId: "p-1" }));
    tr.process(mkLink("cx-1", "REQ-001", T.t2, "codex", "p-1"));
    tr.process(mkSkill({ sessionId: "cx-1", cli: "codex", skill: "implement-spec", at: T.t4, evidence: "self_reported", projectId: "p-1" }));
    expect(tr.req("REQ-001")!.uncertain).toBe(true);
    // 用户确认（t5）：uncertain 清除、依据推进到 t5
    tr.process(mkManual("REQ-001", "Implement", T.t5, "gui-confirm"));
    expect(tr.req("REQ-001")!.uncertain).toBe(false);
    // 迟到的 verified（t3 < 确认依据 t5）不得覆盖
    tr.process(mkSkill({ sessionId: "cs-1", skill: "pr", at: T.t3, projectId: "p-1" }));
    const r = tr.req("REQ-001")!;
    expect(r.stage).toBe("Implement");
    expect(r.uncertain, "迟到事件不得让已确认阶段回到 uncertain").toBe(false);
  });

  it("更新发生的 verified 事件转正（uncertain 自动清除）", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, projectId: "p-1" }));
    tr.process(mkLink("cx-1", "REQ-001", T.t2, "codex", "p-1"));
    tr.process(mkSkill({ sessionId: "cx-1", cli: "codex", skill: "implement-spec", at: T.t3, evidence: "self_reported", projectId: "p-1" }));
    expect(tr.req("REQ-001")!.uncertain).toBe(true);
    // 更新发生（t4 > 依据 t3）的 verified → 转正
    tr.process(mkSkill({ sessionId: "cs-1", skill: "pr", at: T.t4, projectId: "p-1" }));
    const r = tr.req("REQ-001")!;
    expect(r.stage).toBe("PR");
    expect(r.uncertain).toBe(false);
  });
});
