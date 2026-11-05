// 用途：tracker.mjs 的 node:test 用例 —— 覆盖自动建卡、幂等、乱序/延迟、并发竞争、手动修正、关联/解除关联、证据分级
import { test } from "node:test";
import assert from "node:assert/strict";
import { RequirementTracker, transformHookEvents, SKILL_STAGE } from "./tracker.mjs";

const T = (n) => `2026-11-05T10:${String(n).padStart(2, "0")}:00.000Z`;
const skill = (over = {}) => ({ kind: "skill", sessionId: "s1", cli: "claude-code", skill: "design-feature", occurredAt: T(1), evidenceLevel: "verified", ...over });

test("未关联 session 首个有效 design-feature 自动建卡并置 Design", () => {
  const tr = new RequirementTracker();
  const ch = tr.process(skill());
  assert.equal(ch.length, 1);
  assert.equal(ch[0].type, "requirement_created");
  const snap = tr.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].stage, "Design");
  assert.equal(snap[0].title, "待命名需求");
  assert.deepEqual(snap[0].sessions, ["s1"]);
});

test("同一 session 重复 design-feature 不重复建卡", () => {
  const tr = new RequirementTracker();
  tr.process(skill());
  const ch = tr.process(skill({ occurredAt: T(5), eventId: "e2" }));
  assert.equal(ch.filter((c) => c.type === "requirement_created").length, 0);
  assert.equal(tr.snapshot().length, 1);
});

test("同 eventId 重放幂等：不产生任何变更", () => {
  const tr = new RequirementTracker();
  tr.process(skill({ eventId: "dup-1" }));
  const ch = tr.process(skill({ eventId: "dup-1" }));
  assert.deepEqual(ch, []);
  assert.equal(tr.snapshot().length, 1);
});

test("未关联 session 调用 implement-spec / pr / retro 不建卡", () => {
  const tr = new RequirementTracker();
  for (const s of ["implement-spec", "pr", "retro"]) {
    const ch = tr.process(skill({ skill: s, eventId: "x-" + s }));
    assert.equal(ch.length, 0, s + " 不应建卡");
  }
  assert.equal(tr.snapshot().length, 0);
});

test("self_reported 的 design-feature 不建卡（未达可信阈值）", () => {
  const tr = new RequirementTracker();
  const ch = tr.process(skill({ evidenceLevel: "self_reported", eventId: "sr1" }));
  assert.equal(ch.length, 0);
  assert.equal(tr.snapshot().length, 0);
});

test("乱序到达：更早的 design-feature 不覆盖更晚的 implement", () => {
  const tr = new RequirementTracker();
  tr.process(skill({ sessionId: "sA", occurredAt: T(10), eventId: "a1" })); // 建卡 Design t10
  const reqId = tr.snapshot()[0].id;
  // 先收到 t30 的 implement（例如另一个 session 先上报）
  tr.process({ kind: "link", sessionId: "sB", requirementId: reqId, occurredAt: T(11), eventId: "l1" });
  tr.process(skill({ sessionId: "sB", skill: "implement-spec", occurredAt: T(30), eventId: "b1" }));
  assert.equal(tr.req(reqId).stage, "Implement");
  // 延迟旧事件：sA 又来一个 t20 的 pr，晚于到达但早于依据 t30 → 不覆盖
  const ch = tr.process(skill({ sessionId: "sA", skill: "pr", occurredAt: T(20), eventId: "a2" }));
  assert.equal(tr.req(reqId).stage, "Implement");
  assert.ok(tr.log.some((l) => l.decision === "stale_event_ignored"));
});

test("重复事件重放（重发同内容不同 eventId）不改变阶段", () => {
  const tr = new RequirementTracker();
  tr.process(skill({ sessionId: "sA", occurredAt: T(10), eventId: "a1" }));
  const reqId = tr.snapshot()[0].id;
  tr.process({ kind: "link", sessionId: "sB", requirementId: reqId, occurredAt: T(11), eventId: "l1" });
  tr.process(skill({ sessionId: "sB", skill: "implement-spec", occurredAt: T(30), eventId: "b1" }));
  // 同 session 同 skill 同时间重放（eventId 不同）→ 依据时间相等，非更新（at == cur 不小于，允许重设同值，阶段不变）
  const ch = tr.process(skill({ sessionId: "sB", skill: "implement-spec", occurredAt: T(30), eventId: "b1-replay" }));
  assert.equal(tr.req(reqId).stage, "Implement");
  assert.equal(tr.req(reqId).stageBasisAt, Date.parse(T(30)));
});

test("多 session 并发竞争：最新有效事件决定阶段", () => {
  const tr = new RequirementTracker();
  tr.process(skill({ sessionId: "sA", occurredAt: T(10), eventId: "a1" }));
  const reqId = tr.snapshot()[0].id;
  tr.process({ kind: "link", sessionId: "sB", requirementId: reqId, occurredAt: T(11), eventId: "l1" });
  tr.process({ kind: "link", sessionId: "sC", requirementId: reqId, occurredAt: T(12), eventId: "l2" });
  tr.process(skill({ sessionId: "sB", skill: "implement-spec", occurredAt: T(30), eventId: "b1" }));
  tr.process(skill({ sessionId: "sC", skill: "pr", occurredAt: T(40), eventId: "c1" }));
  assert.equal(tr.req(reqId).stage, "PR");
  // sB 后来的 implement（t50）比 PR 依据 t40 新 → Implement 生效（允许 PR→Implement 回退）
  tr.process(skill({ sessionId: "sB", skill: "implement-spec", occurredAt: T(50), eventId: "b2" }));
  assert.equal(tr.req(reqId).stage, "Implement");
});

test("手动修正立即生效，之后新的有效事件可覆盖，旧事件不可", () => {
  const tr = new RequirementTracker();
  tr.process(skill({ sessionId: "sA", occurredAt: T(10), eventId: "a1" }));
  const reqId = tr.snapshot()[0].id;
  // 手动修正在 11:00 改 Retro
  const M = "2026-11-05T11:00:00.000Z";
  tr.process({ kind: "manual", requirementId: reqId, stage: "Retro", occurredAt: M, eventId: "m1" });
  assert.equal(tr.req(reqId).stage, "Retro");
  // 旧的 skill 事件（10:30）不能覆盖手动修正
  tr.process({ kind: "link", sessionId: "sB", requirementId: reqId, occurredAt: M, eventId: "l1" });
  tr.process(skill({ sessionId: "sB", skill: "implement-spec", occurredAt: T(30), eventId: "b1" }));
  assert.equal(tr.req(reqId).stage, "Retro");
  // 新的有效事件（11:10）覆盖手动修正
  tr.process(skill({ sessionId: "sB", skill: "pr", occurredAt: "2026-11-05T11:10:00.000Z", eventId: "b2" }));
  assert.equal(tr.req(reqId).stage, "PR");
});

test("解除关联不回退阶段", () => {
  const tr = new RequirementTracker();
  tr.process(skill({ sessionId: "sA", occurredAt: T(10), eventId: "a1" }));
  const reqId = tr.snapshot()[0].id;
  const ch = tr.process({ kind: "unlink", sessionId: "sA", occurredAt: T(20), eventId: "u1" });
  assert.equal(tr.req(reqId).stage, "Design");
  assert.equal(ch[0].stageKept, "Design");
  assert.equal(tr.req(reqId).sessions.size, 0);
});

test("关联已有 session：其历史 skill 事件按实际时间与当前依据比较", () => {
  const tr = new RequirementTracker();
  tr.process(skill({ sessionId: "sA", occurredAt: T(10), eventId: "a1" })); // Design t10
  const reqId = tr.snapshot()[0].id;
  tr.process({ kind: "link", sessionId: "sB", requirementId: reqId, occurredAt: T(50), eventId: "l1" });
  // sB 在关联前(t5)已发生过 design-feature（旧事件）→ 不覆盖（早于 t10）
  tr.process(skill({ sessionId: "sB", occurredAt: T(5), eventId: "b0" }));
  assert.equal(tr.req(reqId).stage, "Design");
  assert.equal(tr.req(reqId).stageBasisAt, Date.parse(T(10)));
  // sB 关联前 t25 的 implement-spec（晚于 t10）→ 生效
  tr.process(skill({ sessionId: "sB", skill: "implement-spec", occurredAt: T(25), eventId: "b1" }));
  assert.equal(tr.req(reqId).stage, "Implement");
});

test("occurredAt 缺失/不可解析：保留当前阶段并标注不确定", () => {
  const tr = new RequirementTracker();
  tr.process(skill({ sessionId: "sA", occurredAt: T(10), eventId: "a1" }));
  const reqId = tr.snapshot()[0].id;
  tr.process({ kind: "link", sessionId: "sB", requirementId: reqId, occurredAt: T(11), eventId: "l1" });
  const ch = tr.process(skill({ sessionId: "sB", skill: "retro", occurredAt: null, eventId: "b1" }));
  assert.equal(ch.length, 0);
  assert.equal(tr.req(reqId).stage, "Design");
  assert.equal(tr.req(reqId).uncertain, true);
});

test("self_reported 的阶段 skill 在已关联需求上只记活动不改阶段", () => {
  const tr = new RequirementTracker();
  tr.process(skill({ sessionId: "sA", occurredAt: T(10), eventId: "a1" }));
  const reqId = tr.snapshot()[0].id;
  const ch = tr.process(skill({ sessionId: "sA", skill: "implement-spec", occurredAt: T(40), evidenceLevel: "self_reported", eventId: "sr1" }));
  assert.equal(ch.length, 0);
  assert.equal(tr.req(reqId).stage, "Design");
  assert.equal(tr.req(reqId).activity.length, 1);
});

test("transformHookEvents：只取 PreToolUse(Skill) 生成 verified 事件", () => {
  const lines = [
    JSON.stringify({ hookEventName: "UserPromptSubmit", sessionId: "s1", capturedAt: T(1), prompt: "/design-feature" }),
    JSON.stringify({ hookEventName: "PreToolUse", sessionId: "s1", capturedAt: T(2), toolName: "Skill", toolInput: { skill: "design-feature" } }),
    JSON.stringify({ hookEventName: "PostToolUse", sessionId: "s1", capturedAt: T(3), toolName: "Skill", toolInput: { skill: "design-feature" }, toolResponse: { success: true } }),
    JSON.stringify({ hookEventName: "PreToolUse", sessionId: "s1", capturedAt: T(4), toolName: "Bash", toolInput: { command: "ls" } }),
  ];
  const evs = transformHookEvents(lines);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].skill, "design-feature");
  assert.equal(evs[0].evidenceLevel, "verified");
  assert.equal(evs[0].occurredAt, T(2));
});

test("SKILL_STAGE 映射覆盖四个有效 skill", () => {
  assert.deepEqual(SKILL_STAGE, { "design-feature": "Design", "implement-spec": "Implement", pr: "PR", retro: "Retro" });
});
