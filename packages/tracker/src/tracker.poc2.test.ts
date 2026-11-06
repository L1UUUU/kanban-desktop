// 用途：tracker 状态机单测 —— poc-2 tracker.test.mjs 的 15 用例演进（TS/vitest/C2 冻结口径；演进点见各用例注释：self_reported 由「不驱动」演进为「驱动+uncertain」、事件形状补齐 validateEvent 必填字段）
import { describe, expect, it } from "vitest";
import { SKILL_STAGE, validateEvent, type NormalizedEvent } from "./schema";
import { RequirementTracker, transformHookEvents } from "./tracker";
import { mkLink, mkManual, mkUnlink } from "./event-fixtures";

// poc-2 时间轴（分钟粒度）与 skill 工厂（演进：补 receivedAt/source 等归一化必填字段；#16 起补 Main 注入的 projectId 缺省值）
const T = (n: number): string => `2026-11-05T10:${String(n).padStart(2, "0")}:00.000Z`;
let seq = 0;
const skill = (over: Partial<NormalizedEvent> = {}): NormalizedEvent =>
  validateEvent({
    eventId: `p2-${++seq}`,
    kind: "skill",
    sessionId: "s1",
    cli: "claude-code",
    skill: "design-feature",
    stage: null,
    requirementId: null,
    projectId: "p-test",
    occurredAt: T(1),
    receivedAt: T(1),
    seq: null,
    evidenceLevel: "verified",
    source: "test",
    ...over,
  });

describe("poc-2 演进：自动建卡与幂等", () => {
  it("未关联 session 首个有效 design-feature 自动建卡并置 Design", () => {
    const tr = new RequirementTracker();
    const ch = tr.process(skill());
    expect(ch).toHaveLength(1);
    expect(ch[0]!.type).toBe("requirement_created");
    const snap = tr.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.stage).toBe("Design");
    expect(snap[0]!.title).toBe("待命名需求");
    expect(snap[0]!.sessions).toEqual(["s1"]);
  });

  it("同一 session 重复 design-feature 不重复建卡", () => {
    const tr = new RequirementTracker();
    tr.process(skill());
    const ch = tr.process(skill({ occurredAt: T(5), eventId: "e2" }));
    expect(ch.filter((c) => c.type === "requirement_created")).toHaveLength(0);
    expect(tr.snapshot()).toHaveLength(1);
  });

  it("同 eventId 重放幂等：不产生任何变更", () => {
    const tr = new RequirementTracker();
    tr.process(skill({ eventId: "dup-1" }));
    const ch = tr.process(skill({ eventId: "dup-1" }));
    expect(ch).toEqual([]);
    expect(tr.snapshot()).toHaveLength(1);
  });

  it("未关联 session 调用 implement-spec / pr / retro 不建卡", () => {
    const tr = new RequirementTracker();
    for (const s of ["implement-spec", "pr", "retro"]) {
      const ch = tr.process(skill({ skill: s, eventId: "x-" + s }));
      expect(ch, s + " 不应建卡").toHaveLength(0);
    }
    expect(tr.snapshot()).toHaveLength(0);
  });

  it("self_reported 的 design-feature 不建卡（建卡只信 verified —— C2 autoCreate）", () => {
    const tr = new RequirementTracker();
    const ch = tr.process(skill({ evidenceLevel: "self_reported", eventId: "sr1" }));
    expect(ch).toHaveLength(0);
    expect(tr.snapshot()).toHaveLength(0);
  });
});

describe("poc-2 演进：乱序/延迟/并发/手动修正", () => {
  it("乱序到达：更早的 design-feature 不覆盖更晚的 implement（stale_event_ignored）", () => {
    const tr = new RequirementTracker();
    tr.process(skill({ sessionId: "sA", occurredAt: T(10), eventId: "a1" })); // 建卡 Design t10
    const reqId = tr.snapshot()[0]!.id;
    // 先收到 t30 的 implement（例如另一个 session 先上报）
    tr.process(mkLink("sB", reqId, T(11), "claude-code"));
    tr.process(skill({ sessionId: "sB", skill: "implement-spec", occurredAt: T(30), eventId: "b1" }));
    expect(tr.req(reqId)!.stage).toBe("Implement");
    // 延迟旧事件：sA 又来一个 t20 的 pr，晚于到达但早于依据 t30 → 不覆盖
    tr.process(skill({ sessionId: "sA", skill: "pr", occurredAt: T(20), eventId: "a2" }));
    expect(tr.req(reqId)!.stage).toBe("Implement");
    expect(tr.log.some((l) => l.decision === "stale_event_ignored")).toBe(true);
  });

  it("重复事件重放（重发同内容不同 eventId）不改变阶段", () => {
    const tr = new RequirementTracker();
    tr.process(skill({ sessionId: "sA", occurredAt: T(10), eventId: "a1" }));
    const reqId = tr.snapshot()[0]!.id;
    tr.process(mkLink("sB", reqId, T(11), "claude-code"));
    tr.process(skill({ sessionId: "sB", skill: "implement-spec", occurredAt: T(30), eventId: "b1" }));
    // 同 session 同 skill 同时间重放（eventId 不同）→ 依据时间相等，非更新（at == cur 不小于，允许重设同值，阶段不变）
    tr.process(skill({ sessionId: "sB", skill: "implement-spec", occurredAt: T(30), eventId: "b1-replay" }));
    expect(tr.req(reqId)!.stage).toBe("Implement");
    expect(tr.req(reqId)!.stageBasisAt).toBe(Date.parse(T(30)));
  });

  it("多 session 并发竞争：最新有效事件决定阶段（含 PR→Implement 回退）", () => {
    const tr = new RequirementTracker();
    tr.process(skill({ sessionId: "sA", occurredAt: T(10), eventId: "a1" }));
    const reqId = tr.snapshot()[0]!.id;
    tr.process(mkLink("sB", reqId, T(11), "claude-code"));
    tr.process(mkLink("sC", reqId, T(12), "claude-code"));
    tr.process(skill({ sessionId: "sB", skill: "implement-spec", occurredAt: T(30), eventId: "b1" }));
    tr.process(skill({ sessionId: "sC", skill: "pr", occurredAt: T(40), eventId: "c1" }));
    expect(tr.req(reqId)!.stage).toBe("PR");
    // sB 后来的 implement（t50）比 PR 依据 t40 新 → Implement 生效（允许 PR→Implement 回退）
    tr.process(skill({ sessionId: "sB", skill: "implement-spec", occurredAt: T(50), eventId: "b2" }));
    expect(tr.req(reqId)!.stage).toBe("Implement");
  });

  it("手动修正立即生效，之后新的有效事件可覆盖，旧事件不可", () => {
    const tr = new RequirementTracker();
    tr.process(skill({ sessionId: "sA", occurredAt: T(10), eventId: "a1" }));
    const reqId = tr.snapshot()[0]!.id;
    // 手动修正在 11:00 改 Retro
    const M = "2026-11-05T11:00:00.000Z";
    tr.process(mkManual(reqId, "Retro", M));
    expect(tr.req(reqId)!.stage).toBe("Retro");
    // 旧的 skill 事件（10:30）不能覆盖手动修正
    tr.process(mkLink("sB", reqId, M, "claude-code"));
    tr.process(skill({ sessionId: "sB", skill: "implement-spec", occurredAt: T(30), eventId: "b1" }));
    expect(tr.req(reqId)!.stage).toBe("Retro");
    // 新的有效事件（11:10）覆盖手动修正
    tr.process(skill({ sessionId: "sB", skill: "pr", occurredAt: "2026-11-05T11:10:00.000Z", eventId: "b2" }));
    expect(tr.req(reqId)!.stage).toBe("PR");
  });
});

describe("poc-2 演进：关联/解除/证据分级/hook 变换", () => {
  it("解除关联不回退阶段", () => {
    const tr = new RequirementTracker();
    tr.process(skill({ sessionId: "sA", occurredAt: T(10), eventId: "a1" }));
    const reqId = tr.snapshot()[0]!.id;
    const ch = tr.process(mkUnlink("sA", T(20)));
    expect(tr.req(reqId)!.stage).toBe("Design");
    expect(ch[0]).toMatchObject({ type: "session_unlinked", stageKept: "Design" });
    expect(tr.req(reqId)!.sessions.size).toBe(0);
  });

  it("关联已有 session：其历史 skill 事件按实际时间与当前依据比较", () => {
    const tr = new RequirementTracker();
    tr.process(skill({ sessionId: "sA", occurredAt: T(10), eventId: "a1" })); // Design t10
    const reqId = tr.snapshot()[0]!.id;
    tr.process(mkLink("sB", reqId, T(50), "claude-code"));
    // sB 在关联前(t5)已发生过 design-feature（旧事件）→ 不覆盖（早于 t10）
    tr.process(skill({ sessionId: "sB", occurredAt: T(5), eventId: "b0" }));
    expect(tr.req(reqId)!.stage).toBe("Design");
    expect(tr.req(reqId)!.stageBasisAt).toBe(Date.parse(T(10)));
    // sB 关联前 t25 的 implement-spec（晚于 t10）→ 生效
    tr.process(skill({ sessionId: "sB", skill: "implement-spec", occurredAt: T(25), eventId: "b1" }));
    expect(tr.req(reqId)!.stage).toBe("Implement");
  });

  it("occurredAt 不可解析：保留当前阶段并标注不确定（演进：null → 非法时间字符串，C2 要求 occurredAt 为字符串）", () => {
    const tr = new RequirementTracker();
    tr.process(skill({ sessionId: "sA", occurredAt: T(10), eventId: "a1" }));
    const reqId = tr.snapshot()[0]!.id;
    tr.process(mkLink("sB", reqId, T(11), "claude-code"));
    const ch = tr.process(skill({ sessionId: "sB", skill: "retro", occurredAt: "not-a-time", eventId: "b1" }));
    expect(ch).toHaveLength(0);
    expect(tr.req(reqId)!.stage).toBe("Design");
    expect(tr.req(reqId)!.uncertain).toBe(true);
  });

  it("self_reported 的阶段 skill 在已关联需求上驱动阶段并标 uncertain（演进：poc-2 原为「只记活动不改阶段」，C2 冻结后 self_reported drive=true + uncertain；活动仍记录在 sessionEvents）", () => {
    const tr = new RequirementTracker();
    tr.process(skill({ sessionId: "sA", occurredAt: T(10), eventId: "a1" }));
    const reqId = tr.snapshot()[0]!.id;
    const ch = tr.process(skill({ sessionId: "sA", skill: "implement-spec", occurredAt: T(40), evidenceLevel: "self_reported", eventId: "sr1" }));
    expect(ch.map((c) => c.type)).toEqual(["stage_changed"]);
    expect(tr.req(reqId)!.stage).toBe("Implement");
    expect(tr.req(reqId)!.uncertain).toBe(true);
    expect(tr.sessionEvents.get("sA"), "活动事件已记录（含证据等级）").toHaveLength(2);
  });

  it("transformHookEvents：只取 PreToolUse(Skill) 生成 verified 事件（演进：产出完整归一化事件且过 validateEvent；#10 Claude hook 接入点）", () => {
    const lines = [
      JSON.stringify({ hookEventName: "UserPromptSubmit", sessionId: "s1", capturedAt: T(1), prompt: "/design-feature" }),
      JSON.stringify({ hookEventName: "PreToolUse", sessionId: "s1", capturedAt: T(2), toolName: "Skill", toolInput: { skill: "design-feature" } }),
      JSON.stringify({ hookEventName: "PostToolUse", sessionId: "s1", capturedAt: T(3), toolName: "Skill", toolInput: { skill: "design-feature" }, toolResponse: { success: true } }),
      JSON.stringify({ hookEventName: "PreToolUse", sessionId: "s1", capturedAt: T(4), toolName: "Bash", toolInput: { command: "ls" } }),
    ];
    const evs = transformHookEvents(lines);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.skill).toBe("design-feature");
    expect(evs[0]!.evidenceLevel).toBe("verified");
    expect(evs[0]!.occurredAt).toBe(T(2));
    expect(evs[0]!.cli).toBe("claude-code");
    expect(() => validateEvent(evs[0])).not.toThrow();
    // 同一 hook 行重发 → eventId 确定性（重放幂等基础）
    expect(transformHookEvents([lines[1]!])[0]!.eventId).toBe(evs[0]!.eventId);
  });

  it("SKILL_STAGE 映射覆盖四个有效 skill", () => {
    expect(SKILL_STAGE).toEqual({ "design-feature": "Design", "implement-spec": "Implement", pr: "PR", retro: "Retro" });
  });
});
