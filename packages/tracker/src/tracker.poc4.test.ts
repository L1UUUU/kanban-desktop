// 用途：tracker 状态机单测 —— poc-4 tracker.test.mjs 的 21 用例演进（TS/vitest；场景 1-5：建卡/证据分级/关联同步/覆盖乱序延迟并发/解除关联与持久化往返）
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TrackerEngine } from "./engine";
import { RequirementTracker } from "./tracker";
import { mkLink, mkManual, mkSkill, mkUnlink, openTestDb, T } from "./event-fixtures";

// engine 持久化用例的临时库文件（Windows 关连接后清理）
const dbFiles: string[] = [];
afterAll(() => {
  for (const f of dbFiles) rmSync(f, { force: true });
});
function tmpDb(tag: string): string {
  const f = join(tmpdir(), `kb-tracker-${tag}-${process.pid}-${Date.now()}.db`);
  dbFiles.push(f);
  return f;
}

// ========== 场景 1：自动建卡 ==========
describe("S1: 自动建卡", () => {
  it("未关联 session 首次 verified design-feature → 建卡 REQ-001 + Design + 关联", () => {
    const tr = new RequirementTracker();
    const ch = tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ type: "requirement_created", requirementId: "REQ-001" });
    const r = tr.req("REQ-001")!;
    expect(r.stage).toBe("Design");
    expect(r.uncertain).toBe(false);
    expect([...r.sessions]).toEqual(["cs-1"]);
    expect(tr.sessionToReq.get("cs-1")).toBe("REQ-001");
  });

  it("同 eventId 重放幂等（不建新卡不改阶段）", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, eventId: "E1" }));
    const ch = tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1, eventId: "E1" }));
    expect(ch).toEqual([]);
    expect(tr.requirements.size).toBe(1);
  });

  it("已关联 session 重复调用 design-feature 不建新卡", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
    const ch = tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t2 })); // 已关联 → 不走建卡分支
    expect(ch.filter((c) => c.type === "requirement_created")).toEqual([]);
    expect(tr.requirements.size).toBe(1);
    expect(tr.req("REQ-001")!.stage).toBe("Design");
  });

  it("未关联 session 的 implement-spec/pr/retro 不建卡", () => {
    const tr = new RequirementTracker();
    for (const skill of ["implement-spec", "pr", "retro"]) {
      const ch = tr.process(mkSkill({ sessionId: "cs-x", skill, at: T.t1 }));
      expect(ch, `${skill} 不应建卡`).toEqual([]);
    }
    expect(tr.requirements.size).toBe(0);
  });

  it("self_reported / simulated 的 design-feature 不建卡（建卡只信 verified）", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cx-1", cli: "codex", skill: "design-feature", at: T.t1, evidence: "self_reported" }));
    tr.process(mkSkill({ sessionId: "co-1", cli: "opencode", skill: "design-feature", at: T.t2, evidence: "simulated" }));
    expect(tr.requirements.size).toBe(0);
  });
});

// ========== 场景 2：Codex 侧 self_reported 的分级处理 ==========
describe("S2: self_reported 分级", () => {
  it("已关联 codex session 的 self_reported implement-spec → 驱动阶段到 Implement 且标 uncertain", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
    const ch = tr.process(mkSkill({ sessionId: "cx-1", cli: "codex", skill: "implement-spec", at: T.t2, evidence: "self_reported" }));
    // cx-1 尚未关联 → 未关联分支只记活动
    expect(ch).toEqual([]);
    expect(tr.requirements.size).toBe(1);
    // 正式路径：先关联再 self_reported（关联时间与事件时间解耦）
    tr.process(mkLink("cx-1", "REQ-001", T.t2));
    const ch2 = tr.process(mkSkill({ sessionId: "cx-1", cli: "codex", skill: "implement-spec", at: T.t3, evidence: "self_reported" }));
    expect(ch2[0]!.type).toBe("stage_changed");
    const r = tr.req("REQ-001")!;
    expect(r.stage).toBe("Implement");
    expect(r.uncertain, "self_reported 驱动阶段但必须标 uncertain").toBe(true);
  });

  it("manual 确认（同阶段）→ uncertain 转正 false", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
    tr.process(mkLink("cx-1", "REQ-001", T.t1));
    tr.process(mkSkill({ sessionId: "cx-1", cli: "codex", skill: "implement-spec", at: T.t2, evidence: "self_reported" }));
    expect(tr.req("REQ-001")!.uncertain).toBe(true);
    tr.process(mkManual("REQ-001", "Implement", T.t3, "gui-confirm"));
    expect(tr.req("REQ-001")!.stage).toBe("Implement");
    expect(tr.req("REQ-001")!.uncertain).toBe(false);
  });

  it("更新的 verified 事件覆盖 self_reported → uncertain 清除", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
    tr.process(mkLink("cx-1", "REQ-001", T.t1));
    tr.process(mkSkill({ sessionId: "cx-1", cli: "codex", skill: "implement-spec", at: T.t2, evidence: "self_reported" }));
    tr.process(mkSkill({ sessionId: "cs-1", skill: "implement-spec", at: T.t3, evidence: "verified" }));
    const r = tr.req("REQ-001")!;
    expect(r.stage).toBe("Implement");
    expect(r.uncertain).toBe(false);
  });

  it("早于当前依据的 self_reported 不覆盖（stale）", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
    tr.process(mkLink("cx-1", "REQ-001", T.t1));
    tr.process(mkSkill({ sessionId: "cs-1", skill: "implement-spec", at: T.t5, evidence: "verified" })); // 依据 t5
    tr.process(mkSkill({ sessionId: "cx-1", cli: "codex", skill: "retro", at: T.t3, evidence: "self_reported" })); // 旧事件
    expect(tr.req("REQ-001")!.stage, "延迟旧事件不得覆盖").toBe("Implement");
  });
});

// ========== 场景 3：先执行 Skill 后手动关联（按实际发生时间同步） ==========
describe("S3: link 时间同步", () => {
  it("link 时该 session 已见事件晚于当前依据 → 按实际发生时间推进（不以关联时间冒充）", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
    tr.process(mkLink("cx-1", "REQ-001", T.t1));
    tr.process(mkSkill({ sessionId: "cs-1", skill: "implement-spec", at: T.t3, evidence: "verified" })); // 依据 t3
    // opencode session 在 t5 已执行 pr（当时未关联，只记活动），t6 才关联
    tr.process(mkSkill({ sessionId: "co-1", cli: "opencode", skill: "pr", at: T.t5, evidence: "simulated" }));
    expect(tr.req("REQ-001")!.stage).toBe("Implement");
    const ch = tr.process(mkLink("co-1", "REQ-001", T.t6, "opencode"));
    const r = tr.req("REQ-001")!;
    expect(r.stage, "关联后按 skill 实际发生时间(t5) > 当前依据(t3) 同步到 PR").toBe("PR");
    expect(r.uncertain, "simulated 依据 → uncertain").toBe(true);
    expect(ch.some((c) => c.type === "session_linked")).toBe(true);
    expect(ch.some((c) => c.type === "stage_changed" && c.stage === "PR")).toBe(true);
    expect((r.stageBasis as { at: string }).at, "阶段依据必须是 skill 实际发生时间而非关联时间 t6").toBe(T.t5);
  });

  it("link 时该 session 已见事件早于当前依据 → 不覆盖", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
    tr.process(mkLink("cx-1", "REQ-001", T.t1));
    tr.process(mkSkill({ sessionId: "cs-1", skill: "retro", at: T.t5, evidence: "verified" })); // 依据 t5
    tr.process(mkSkill({ sessionId: "co-1", cli: "opencode", skill: "implement-spec", at: T.t3, evidence: "simulated" })); // 旧事件
    tr.process(mkLink("co-1", "REQ-001", T.t6, "opencode"));
    expect(tr.req("REQ-001")!.stage, "旧于依据的事件在关联同步时也不得覆盖").toBe("Retro");
  });

  it("需求尚无阶段依据时，link 同步可初始化阶段", () => {
    const tr = new RequirementTracker();
    const reqId = tr.createRequirement({ sessionId: "cs-1" }); // 手动建卡无阶段
    tr.process(mkSkill({ sessionId: "co-1", cli: "opencode", skill: "implement-spec", at: T.t2, evidence: "simulated" }));
    tr.process(mkLink("co-1", reqId, T.t3, "opencode"));
    expect(tr.req(reqId)!.stage).toBe("Implement");
  });

  it("已关联其他需求的 session 再 link → 拒绝（一个 session 同时最多一个需求）", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 })); // REQ-001
    tr.process(mkSkill({ sessionId: "cs-2", skill: "design-feature", at: T.t2 })); // REQ-002
    const ch = tr.process(mkLink("cs-1", "REQ-002", T.t3));
    expect(ch).toEqual([]);
    expect(tr.sessionToReq.get("cs-1")).toBe("REQ-001");
    expect([...tr.req("REQ-002")!.sessions]).toEqual(["cs-2"]);
  });

  it("真实源路径 —— opencode self_reported（command API 可观察）先执行后关联，同步推进且标 uncertain", () => {
    // 对应 e2e S3 真实 OpenCode 分支的规则镜像：command 提交 + turn 完成构造 self_reported，无独立 skill 语义 hook
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 })); // REQ-001 @ Design(t1)
    tr.process(mkLink("cx-1", "REQ-001", T.t1));
    tr.process(mkSkill({ sessionId: "cx-1", cli: "codex", skill: "implement-spec", at: T.t2, evidence: "self_reported" })); // Implement(t2)
    // opencode session 先真实执行 pr（t3，未关联 → 只记活动）
    const oc = mkSkill({ sessionId: "ses_oc_real", cli: "opencode", skill: "pr", at: T.t3, evidence: "self_reported" });
    expect(tr.process(oc)).toEqual([]);
    expect(tr.req("REQ-001")!.stage).toBe("Implement");
    // 手动关联后按 command 实际发生时间(t3) > 依据(t2) 同步推进到 PR
    const ch = tr.process(mkLink("ses_oc_real", "REQ-001", T.t4, "opencode"));
    const r = tr.req("REQ-001")!;
    expect(r.stage).toBe("PR");
    expect(r.uncertain, "self_reported 依据 → uncertain").toBe(true);
    expect((r.stageBasis as { at: string }).at, "依据为 skill 实际发生时间而非关联时间").toBe(T.t3);
    expect(ch.some((c) => c.type === "stage_changed" && c.stage === "PR")).toBe(true);
  });
});

// ========== 场景 4：修正覆盖 / 重复 / 延迟 / 并发竞争 / 回退 ==========
describe("S4: 修正/并发/乱序", () => {
  it("手动修正立即生效；之后更新的有效事件可覆盖；早于修正依据的事件不覆盖", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
    tr.process(mkManual("REQ-001", "Retro", T.t4));
    expect(tr.req("REQ-001")!.stage).toBe("Retro");
    tr.process(mkSkill({ sessionId: "cs-1", skill: "implement-spec", at: T.t3, evidence: "verified" })); // 旧于 t4
    expect(tr.req("REQ-001")!.stage).toBe("Retro");
    tr.process(mkSkill({ sessionId: "cs-1", skill: "implement-spec", at: T.t5, evidence: "verified" })); // 新于 t4
    expect(tr.req("REQ-001")!.stage, "手动修正不永久锁定").toBe("Implement");
  });

  it("多 session 并发时最新有效事件胜出（跨 CLI 混合证据流）", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
    tr.process(mkLink("cx-1", "REQ-001", T.t1));
    tr.process(mkLink("co-1", "REQ-001", T.t1, "opencode"));
    tr.process(mkSkill({ sessionId: "cx-1", cli: "codex", skill: "implement-spec", at: T.t2, evidence: "self_reported" }));
    expect(tr.req("REQ-001")!.stage).toBe("Implement");
    tr.process(mkSkill({ sessionId: "co-1", cli: "opencode", skill: "pr", at: T.t3, evidence: "simulated" }));
    expect(tr.req("REQ-001")!.stage, "最新有效事件决定阶段（不区分 session 发起方）").toBe("PR");
    tr.process(mkSkill({ sessionId: "cs-1", skill: "implement-spec", at: T.t4, evidence: "verified" }));
    expect(tr.req("REQ-001")!.stage, "允许 PR→Implement 回退").toBe("Implement");
  });

  it("occurredAt 不可解析 → 保留当前阶段并标 uncertain", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
    tr.process(mkSkill({ sessionId: "cs-1", skill: "pr", at: "not-a-time", evidence: "verified" }));
    const r = tr.req("REQ-001")!;
    expect(r.stage).toBe("Design");
    expect(r.uncertain).toBe(true);
  });

  it("非法事件（schema 校验失败）在 engine 入口抛错，不进事件流不落库", () => {
    const eng = new TrackerEngine(openTestDb(":memory:"));
    expect(() =>
      eng.process({
        eventId: "bad",
        kind: "skill",
        sessionId: "s",
        cli: "codex",
        skill: "pr",
        stage: null,
        requirementId: null,
        occurredAt: T.t1,
        receivedAt: T.t1,
        seq: null,
        evidenceLevel: "guessed",
        source: "t",
      }),
    ).toThrow(/invalid event/);
    expect(eng.store.snapshotTables().stageEventCount, "非法事件不得落库").toBe(0);
    eng.close();
  });
});

// ========== 场景 5：解除关联 + 持久化恢复 ==========
describe("S5: 解除关联与持久化往返", () => {
  it("解除关联不回退阶段、session 移除、再关联同一需求可行", () => {
    const tr = new RequirementTracker();
    tr.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
    tr.process(mkSkill({ sessionId: "cs-1", skill: "implement-spec", at: T.t2 }));
    const ch = tr.process(mkUnlink("cs-1", T.t3));
    expect(ch[0]).toMatchObject({ type: "session_unlinked", stageKept: "Implement" });
    expect(tr.req("REQ-001")!.stage).toBe("Implement");
    expect(tr.sessionToReq.has("cs-1")).toBe(false);
    const ch2 = tr.process(mkLink("cs-1", "REQ-001", T.t4));
    expect(ch2.some((c) => c.type === "session_linked"), "解除后可重新关联").toBe(true);
  });

  it("engine 持久化往返 —— 重启恢复后卡片/关联/阶段/uncertain 全部一致，重放同 eventId 幂等，历史事件可查", () => {
    const db = tmpDb("roundtrip");
    const ev1 = mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 });
    {
      const eng = new TrackerEngine(openTestDb(db));
      eng.process(ev1);
      eng.process(mkLink("cx-1", "REQ-001", T.t2));
      eng.process(mkSkill({ sessionId: "cx-1", cli: "codex", skill: "implement-spec", at: T.t3, evidence: "self_reported" }));
      eng.process(mkSkill({ sessionId: "co-1", cli: "opencode", skill: "pr", at: T.t4, evidence: "simulated" }));
      eng.process(mkLink("co-1", "REQ-001", T.t5, "opencode"));
      eng.process(mkUnlink("co-1", T.t6)); // 解除关联但历史保留
      eng.close();
    }
    {
      const eng = new TrackerEngine(openTestDb(db)); // 模拟退出重开：新进程读同一 DB
      eng.restore();
      const snap = eng.snapshot();
      expect(snap).toHaveLength(1);
      const r = snap[0]!;
      expect(r.id).toBe("REQ-001");
      expect(r.stage, "解除关联不回退阶段（恢复后仍为 PR）").toBe("PR");
      expect(r.uncertain, "simulated 依据的 uncertain 恢复").toBe(true);
      expect(r.sessions, "co-1 已解除关联").toEqual(["cs-1", "cx-1"]);
      // 历史仍在：co-1 的事件（含 unlink 后）可查
      const hist = eng.store.listEvents({ sessionId: "co-1" });
      expect(hist.length, "解除关联不删历史").toBeGreaterThanOrEqual(2);
      // 重放攻击：同 eventId 再入 → 幂等
      const before = eng.snapshot();
      const { changes } = eng.process(ev1);
      expect(changes).toEqual([]);
      expect(eng.snapshot()).toEqual(before);
      // 恢复后新事件正常驱动（nextId 正确）
      const { changes: ch2 } = eng.process(mkSkill({ sessionId: "cs-2", skill: "design-feature", at: T.t7 }));
      expect(ch2[0]!, "重启后建卡编号从恢复点继续").toMatchObject({ type: "requirement_created", requirementId: "REQ-002" });
      eng.close();
    }
  });

  it("恢复后 link 同步仍可用（sessionEvents 缓存随持久化往返）", () => {
    const db = tmpDb("linksync");
    {
      const eng = new TrackerEngine(openTestDb(db));
      eng.process(mkSkill({ sessionId: "cs-1", skill: "design-feature", at: T.t1 }));
      eng.process(mkSkill({ sessionId: "co-1", cli: "opencode", skill: "retro", at: T.t2, evidence: "simulated" })); // 先执行（未关联）
      eng.close();
    }
    {
      const eng = new TrackerEngine(openTestDb(db));
      eng.restore();
      eng.process(mkLink("co-1", "REQ-001", T.t3, "opencode")); // 重启后才关联 → 同步逻辑仍可用
      expect(eng.snapshot()[0]!.stage).toBe("Retro");
      eng.close();
    }
  });
});
