// 用途：tracker/engine 确定性测试（node:test）—— 覆盖计划 §9 PoC 4 五个场景的全部规则分支：建卡、证据分级驱动、关联同步、覆盖/乱序/延迟/回退、解除关联与持久化恢复
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RequirementTracker } from "../lib/tracker.mjs";
import { PoCEngine } from "../lib/engine.mjs";

// ---- 测试辅助：固定时间轴 t1<t2<...<t9，避免真实时钟抖动 ----
const T = {
  t1: "2026-11-05T10:00:01.000Z",
  t2: "2026-11-05T10:00:02.000Z",
  t3: "2026-11-05T10:00:03.000Z",
  t4: "2026-11-05T10:00:04.000Z",
  t5: "2026-11-05T10:00:05.000Z",
  t6: "2026-11-05T10:00:06.000Z",
  t7: "2026-11-05T10:00:07.000Z",
  t8: "2026-11-05T10:00:08.000Z",
  t9: "2026-11-05T10:00:09.000Z",
};

let n = 0;
function mkSkill({ sessionId = "s-a", cli = "claude-code", skill = "design-feature", at = T.t1, evidence = "verified", eventId, seq = null }) {
  return {
    eventId: eventId ?? `ev-${++n}`,
    kind: "skill", sessionId, cli, skill, stage: null, requirementId: null,
    occurredAt: at, receivedAt: at, seq, evidenceLevel: evidence, source: "test",
  };
}
function mkManual(reqId, stage, at, source = "gui-manual") {
  return {
    eventId: `m-${++n}`, kind: "manual", sessionId: null, cli: null, skill: null,
    stage, requirementId: reqId, occurredAt: at, receivedAt: at, seq: null,
    evidenceLevel: "verified", source,
  };
}
function mkLink(sessionId, reqId, at, cli = "codex") {
  return {
    eventId: `l-${++n}`, kind: "link", sessionId, cli, skill: null, stage: null,
    requirementId: reqId, occurredAt: at, receivedAt: at, seq: null,
    evidenceLevel: "verified", source: "gui-card",
  };
}
function mkUnlink(sessionId, at) {
  return {
    eventId: `u-${++n}`, kind: "unlink", sessionId, cli: null, skill: null, stage: null,
    requirementId: null, occurredAt: at, receivedAt: at, seq: null,
    evidenceLevel: "verified", source: "gui",
  };
}

// ========== 场景 1：自动建卡 ==========
test("S1: 未关联 session 首次 verified design-feature → 建卡 REQ-001 + Design + 关联", () => {
  const tr = new RequirementTracker();
  const ch = tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
  assert.equal(ch.length, 1);
  assert.equal(ch[0].type, "requirement_created");
  assert.equal(ch[0].requirementId, "REQ-001");
  const r = tr.req("REQ-001");
  assert.equal(r.stage, "Design");
  assert.equal(r.uncertain, false);
  assert.deepEqual([...r.sessions], ["cs-1"]);
  assert.equal(tr.sessionToReq.get("cs-1"), "REQ-001");
});

test("S1: 同 eventId 重放幂等（不建新卡不改阶段）", () => {
  const tr = new RequirementTracker();
  tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, eventId: "E1" }));
  const ch = tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, eventId: "E1" }));
  assert.deepEqual(ch, []);
  assert.equal(tr.requirements.size, 1);
});

test("S1: 已关联 session 重复调用 design-feature 不建新卡", () => {
  const tr = new RequirementTracker();
  tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
  const ch = tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t2 })); // 已关联 → 不走建卡分支
  assert.deepEqual(ch.filter((c) => c.type === "requirement_created"), []);
  assert.equal(tr.requirements.size, 1);
  assert.equal(tr.req("REQ-001").stage, "Design");
});

test("S1: 未关联 session 的 implement-spec/pr/retro 不建卡", () => {
  const tr = new RequirementTracker();
  for (const skill of ["implement-spec", "pr", "retro"]) {
    const ch = tr.process(mkSkill({ sessionId: "cs-x", skill, at: T.t1 }));
    assert.deepEqual(ch, [], `${skill} 不应建卡`);
  }
  assert.equal(tr.requirements.size, 0);
});

test("S1: self_reported / simulated 的 design-feature 不建卡（建卡只信 verified）", () => {
  const tr = new RequirementTracker();
  tr.process(mkSkill({ sessionId: "cx-1", cli: "codex", skill: "design-feature", at: T.t1, evidence: "self_reported" }));
  tr.process(mkSkill({ sessionId: "co-1", cli: "opencode", skill: "design-feature", at: T.t2, evidence: "simulated" }));
  assert.equal(tr.requirements.size, 0);
});

// ========== 场景 2：Codex 侧 self_reported 的分级处理 ==========
test("S2: 已关联 codex session 的 self_reported implement-spec → 驱动阶段到 Implement 且标 uncertain", () => {
  const tr = new RequirementTracker();
  tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
  const ch = tr.process(mkSkill({ sessionId: "cx-1", cli: "codex", skill: "implement-spec", at: T.t2, evidence: "self_reported" }));
  // cx-1 尚未关联 → 未关联分支只记活动
  assert.deepEqual(ch, []);
  assert.equal(tr.requirements.size, 1);
  // 正式路径：先关联再 self_reported
  tr.process(mkLink("cx-1", "REQ-001", T.t1p5 ?? T.t2)); // 关联时间与事件时间解耦
  const ch2 = tr.process(mkSkill({ sessionId: "cx-1", cli: "codex", skill: "implement-spec", at: T.t3, evidence: "self_reported" }));
  assert.equal(ch2[0].type, "stage_changed");
  const r = tr.req("REQ-001");
  assert.equal(r.stage, "Implement");
  assert.equal(r.uncertain, true, "self_reported 驱动阶段但必须标 uncertain");
});

test("S2: manual 确认（同阶段）→ uncertain 转正 false", () => {
  const tr = new RequirementTracker();
  tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
  tr.process(mkLink("cx-1", "REQ-001", T.t1));
  tr.process(mkSkill({ sessionId: "cx-1", cli: "codex", skill: "implement-spec", at: T.t2, evidence: "self_reported" }));
  assert.equal(tr.req("REQ-001").uncertain, true);
  tr.process(mkManual("REQ-001", "Implement", T.t3, "gui-confirm"));
  assert.equal(tr.req("REQ-001").stage, "Implement");
  assert.equal(tr.req("REQ-001").uncertain, false);
});

test("S2: 更新的 verified 事件覆盖 self_reported → uncertain 清除", () => {
  const tr = new RequirementTracker();
  tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
  tr.process(mkLink("cx-1", "REQ-001", T.t1));
  tr.process(mkSkill({ sessionId: "cx-1", cli: "codex", skill: "implement-spec", at: T.t2, evidence: "self_reported" }));
  tr.process(mkSkill({ sessionId: "cs-1", skill: "implement-spec", at: T.t3, evidence: "verified" }));
  const r = tr.req("REQ-001");
  assert.equal(r.stage, "Implement");
  assert.equal(r.uncertain, false);
});

test("S2: 早于当前依据的 self_reported 不覆盖（stale）", () => {
  const tr = new RequirementTracker();
  tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
  tr.process(mkLink("cx-1", "REQ-001", T.t1));
  tr.process(mkSkill({ sessionId: "cs-1", skill: "implement-spec", at: T.t5, evidence: "verified" })); // 依据 t5
  tr.process(mkSkill({ sessionId: "cx-1", cli: "codex", skill: "retro", at: T.t3, evidence: "self_reported" })); // 旧事件
  assert.equal(tr.req("REQ-001").stage, "Implement", "延迟旧事件不得覆盖");
});

// ========== 场景 3：先执行 Skill 后手动关联（按实际发生时间同步） ==========
test("S3: link 时该 session 已见事件晚于当前依据 → 按实际发生时间推进（不以关联时间冒充）", () => {
  const tr = new RequirementTracker();
  tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
  tr.process(mkLink("cx-1", "REQ-001", T.t1));
  tr.process(mkSkill({ sessionId: "cs-1", skill: "implement-spec", at: T.t3, evidence: "verified" })); // 依据 t3
  // opencode session 在 t5 已执行 pr（当时未关联，只记活动），t6 才关联
  tr.process(mkSkill({ sessionId: "co-1", cli: "opencode", skill: "pr", at: T.t5, evidence: "simulated" }));
  assert.equal(tr.req("REQ-001").stage, "Implement");
  const ch = tr.process(mkLink("co-1", "REQ-001", T.t6, "opencode"));
  const r = tr.req("REQ-001");
  assert.equal(r.stage, "PR", "关联后按 skill 实际发生时间(t5) > 当前依据(t3) 同步到 PR");
  assert.equal(r.uncertain, true, "simulated 依据 → uncertain");
  assert.ok(ch.some((c) => c.type === "session_linked"));
  assert.ok(ch.some((c) => c.type === "stage_changed" && c.stage === "PR"));
  assert.equal(r.stageBasis.at, T.t5, "阶段依据必须是 skill 实际发生时间而非关联时间 t6");
});

test("S3: link 时该 session 已见事件早于当前依据 → 不覆盖", () => {
  const tr = new RequirementTracker();
  tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
  tr.process(mkLink("cx-1", "REQ-001", T.t1));
  tr.process(mkSkill({ sessionId: "cs-1", skill: "retro", at: T.t5, evidence: "verified" })); // 依据 t5
  tr.process(mkSkill({ sessionId: "co-1", cli: "opencode", skill: "implement-spec", at: T.t3, evidence: "simulated" })); // 旧事件
  tr.process(mkLink("co-1", "REQ-001", T.t6, "opencode"));
  assert.equal(tr.req("REQ-001").stage, "Retro", "旧于依据的事件在关联同步时也不得覆盖");
});

test("S3: 需求尚无阶段依据时，link 同步可初始化阶段", () => {
  const tr = new RequirementTracker();
  const reqId = tr.createRequirement({ sessionId: "cs-1" }); // 手动建卡无阶段
  tr.process(mkSkill({ sessionId: "co-1", cli: "opencode", skill: "implement-spec", at: T.t2, evidence: "simulated" }));
  tr.process(mkLink("co-1", reqId, T.t3, "opencode"));
  assert.equal(tr.req(reqId).stage, "Implement");
});

test("S3: 已关联其他需求的 session 再 link → 拒绝（一个 session 同时最多一个需求）", () => {
  const tr = new RequirementTracker();
  tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 })); // REQ-001
  tr.process(mkSkill({ sessionId: "cs-2", skill: "design-feature", at: T.t2 })); // REQ-002
  const ch = tr.process(mkLink("cs-1", "REQ-002", T.t3));
  assert.deepEqual(ch, []);
  assert.equal(tr.sessionToReq.get("cs-1"), "REQ-001");
  assert.deepEqual([...tr.req("REQ-002").sessions], ["cs-2"]);
});

// ========== 场景 4：修正覆盖 / 重复 / 延迟 / 并发竞争 / 回退 ==========
test("S4: 手动修正立即生效；之后更新的有效事件可覆盖；早于修正依据的事件不覆盖", () => {
  const tr = new RequirementTracker();
  tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
  tr.process(mkManual("REQ-001", "Retro", T.t4));
  assert.equal(tr.req("REQ-001").stage, "Retro");
  tr.process(mkSkill({ sessionId: "cs-1", skill: "implement-spec", at: T.t3, evidence: "verified" })); // 旧于 t4
  assert.equal(tr.req("REQ-001").stage, "Retro");
  tr.process(mkSkill({ sessionId: "cs-1", skill: "implement-spec", at: T.t5, evidence: "verified" })); // 新于 t4
  assert.equal(tr.req("REQ-001").stage, "Implement", "手动修正不永久锁定");
});

test("S4: 多 session 并发时最新有效事件胜出（跨 CLI 混合证据流）", () => {
  const tr = new RequirementTracker();
  tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
  tr.process(mkLink("cx-1", "REQ-001", T.t1));
  tr.process(mkLink("co-1", "REQ-001", T.t1, "opencode"));
  tr.process(mkSkill({ sessionId: "cx-1", cli: "codex", skill: "implement-spec", at: T.t2, evidence: "self_reported" }));
  assert.equal(tr.req("REQ-001").stage, "Implement");
  tr.process(mkSkill({ sessionId: "co-1", cli: "opencode", skill: "pr", at: T.t3, evidence: "simulated" }));
  assert.equal(tr.req("REQ-001").stage, "PR", "最新有效事件决定阶段（不区分 session 发起方）");
  tr.process(mkSkill({ sessionId: "cs-1", skill: "implement-spec", at: T.t4, evidence: "verified" }));
  assert.equal(tr.req("REQ-001").stage, "Implement", "允许 PR→Implement 回退");
});

test("S4: occurredAt 不可解析 → 保留当前阶段并标 uncertain", () => {
  const tr = new RequirementTracker();
  tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
  tr.process(mkSkill({ sessionId: "cs-1", skill: "pr", at: "not-a-time", evidence: "verified" }));
  const r = tr.req("REQ-001");
  assert.equal(r.stage, "Design");
  assert.equal(r.uncertain, true);
});

test("S4: 非法事件（schema 校验失败）在 engine 入口抛错，不进事件流不落库", () => {
  const eng = new PoCEngine(":memory:");
  assert.throws(() => eng.process({ eventId: "bad", kind: "skill", sessionId: "s", cli: "codex", skill: "pr", occurredAt: T.t1, receivedAt: T.t1, evidenceLevel: "guessed", source: "t" }));
  assert.equal(eng.store.snapshotTables().stageEventCount, 0, "非法事件不得落库");
  eng.close();
});

// ========== 场景 5：解除关联 + 持久化恢复 ==========
test("S5: 解除关联不回退阶段、session 移除、再关联同一需求可行", () => {
  const tr = new RequirementTracker();
  tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
  tr.process(mkSkill({ sessionId: "cs-1", skill: "implement-spec", at: T.t2 }));
  const ch = tr.process(mkUnlink("cs-1", T.t3));
  assert.equal(ch[0].type, "session_unlinked");
  assert.equal(ch[0].stageKept, "Implement");
  assert.equal(tr.req("REQ-001").stage, "Implement");
  assert.equal(tr.sessionToReq.has("cs-1"), false);
  const ch2 = tr.process(mkLink("cs-1", "REQ-001", T.t4));
  assert.ok(ch2.some((c) => c.type === "session_linked"), "解除后可重新关联");
});

test("S5: engine 持久化往返 —— 重启恢复后卡片/关联/阶段/uncertain 全部一致，重放同 eventId 幂等，历史事件可查", () => {
  const db = join(tmpdir(), `poc4-test-${process.pid}-${Date.now()}.db`);
  const ev1 = mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 });
  {
    const eng = new PoCEngine(db);
    eng.process(ev1);
    eng.process(mkLink("cx-1", "REQ-001", T.t2));
    eng.process(mkSkill({ sessionId: "cx-1", cli: "codex", skill: "implement-spec", at: T.t3, evidence: "self_reported" }));
    eng.process(mkSkill({ sessionId: "co-1", cli: "opencode", skill: "pr", at: T.t4, evidence: "simulated" }));
    eng.process(mkLink("co-1", "REQ-001", T.t5, "opencode"));
    eng.process(mkUnlink("co-1", T.t6)); // 解除关联但历史保留
    eng.close();
  }
  {
    const eng = new PoCEngine(db); // 模拟退出重开：新进程读同一 DB
    eng.restore();
    const snap = eng.snapshot();
    assert.equal(snap.length, 1);
    const r = snap[0];
    assert.equal(r.id, "REQ-001");
    assert.equal(r.stage, "PR", "解除关联不回退阶段（恢复后仍为 PR）");
    assert.equal(r.uncertain, true, "simulated 依据的 uncertain 恢复");
    assert.deepEqual(r.sessions, ["cs-1", "cx-1"], "co-1 已解除关联");
    // 历史仍在：co-1 的事件（含 unlink 后）可查
    const hist = eng.store.listEvents({ sessionId: "co-1" });
    assert.ok(hist.length >= 2, "解除关联不删历史");
    // 重放攻击：同 eventId 再入 → 幂等
    const before = eng.snapshot();
    const { changes } = eng.process(ev1);
    assert.deepEqual(changes, []);
    assert.deepEqual(eng.snapshot(), before);
    // 恢复后新事件正常驱动（nextId 正确）
    const { changes: ch2 } = eng.process(mkSkill({ sessionId: "cs-2", skill: "design-feature", at: T.t7 }));
    assert.equal(ch2[0].requirementId, "REQ-002", "重启后建卡编号从恢复点继续");
    eng.close();
  }
  rmSync(db, { force: true });
});

test("S5: 恢复后 link 同步仍可用（sessionEvents 缓存随持久化往返）", () => {
  const db = join(tmpdir(), `poc4-test2-${process.pid}-${Date.now()}.db`);
  {
    const eng = new PoCEngine(db);
    eng.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
    eng.process(mkSkill({ sessionId: "co-1", cli: "opencode", skill: "retro", at: T.t2, evidence: "simulated" })); // 先执行（未关联）
    eng.close();
  }
  {
    const eng = new PoCEngine(db);
    eng.restore();
    eng.process(mkLink("co-1", "REQ-001", T.t3, "opencode")); // 重启后才关联 → 同步逻辑仍可用
    assert.equal(eng.snapshot()[0].stage, "Retro");
    eng.close();
  }
  rmSync(db, { force: true });
});

test("S3: 真实源路径 —— opencode self_reported（command API 可观察）先执行后关联，同步推进且标 uncertain", () => {
  // 对应 e2e S3 真实 OpenCode 分支的规则镜像：command 提交 + turn 完成构造 self_reported，无独立 skill 语义 hook
  const tr = new RequirementTracker();
  tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 })); // REQ-001 @ Design(t1)
  tr.process(mkLink("cx-1", "REQ-001", T.t1));
  tr.process(mkSkill({ sessionId: "cx-1", cli: "codex", skill: "implement-spec", at: T.t2, evidence: "self_reported" })); // Implement(t2)
  // opencode session 先真实执行 pr（t3，未关联 → 只记活动）
  const oc = mkSkill({ sessionId: "ses_oc_real", cli: "opencode", skill: "pr", at: T.t3, evidence: "self_reported" });
  assert.deepEqual(tr.process(oc), []);
  assert.equal(tr.req("REQ-001").stage, "Implement");
  // 手动关联后按 command 实际发生时间(t3) > 依据(t2) 同步推进到 PR
  const ch = tr.process(mkLink("ses_oc_real", "REQ-001", T.t4, "opencode"));
  const r = tr.req("REQ-001");
  assert.equal(r.stage, "PR");
  assert.equal(r.uncertain, true, "self_reported 依据 → uncertain");
  assert.equal(r.stageBasis.at, T.t3, "依据为 skill 实际发生时间而非关联时间");
  assert.ok(ch.some((c) => c.type === "stage_changed" && c.stage === "PR"));
});
