// 用途：C2 演进（spec #15 A 节）validateEvent 边界单测 —— 新 kind（create/rename/delete）接受/拒绝规则、pty 仅 link 合法、projectId/title 归一、manual "none" 归一 null
import { describe, expect, it } from "vitest";
import { validateEvent } from "./schema";

// 各 kind 最小合法底座（缺省字段按 kind 补充，逐用例覆盖拒绝分支）
const base = {
  eventId: "e-1",
  occurredAt: "2026-11-05T10:00:00.000Z",
  receivedAt: "2026-11-05T10:00:00.000Z",
  evidenceLevel: "verified",
} as const;

describe("validateEvent：新 kind create/rename/delete", () => {
  it("create 完整事件合法（无 sessionId/cli），归一保留 requirementId/title/projectId", () => {
    const ev = validateEvent({ ...base, kind: "create", requirementId: "REQ-001", title: "看板重构", projectId: "p-1" });
    expect(ev).toMatchObject({ kind: "create", requirementId: "REQ-001", title: "看板重构", projectId: "p-1", sessionId: null, cli: null });
  });

  it("create 缺 requirementId / title / projectId 分别拒绝", () => {
    expect(() => validateEvent({ ...base, kind: "create", title: "t", projectId: "p-1" })).toThrow(/invalid event: requirementId/);
    expect(() => validateEvent({ ...base, kind: "create", requirementId: "REQ-001", projectId: "p-1" })).toThrow(/invalid event: title/);
    expect(() => validateEvent({ ...base, kind: "create", requirementId: "REQ-001", title: "t" })).toThrow(/invalid event: projectId/);
  });

  it("rename 完整事件合法（requirementId+title，无 sessionId/cli）；缺任一拒绝", () => {
    const ev = validateEvent({ ...base, kind: "rename", requirementId: "REQ-001", title: "新标题" });
    expect(ev).toMatchObject({ kind: "rename", requirementId: "REQ-001", title: "新标题", sessionId: null, cli: null });
    expect(() => validateEvent({ ...base, kind: "rename", title: "新标题" })).toThrow(/invalid event: requirementId/);
    expect(() => validateEvent({ ...base, kind: "rename", requirementId: "REQ-001" })).toThrow(/invalid event: title/);
  });

  it("delete 完整事件合法（仅 requirementId）；缺 requirementId 拒绝", () => {
    const ev = validateEvent({ ...base, kind: "delete", requirementId: "REQ-001" });
    expect(ev).toMatchObject({ kind: "delete", requirementId: "REQ-001", sessionId: null, cli: null, title: null });
    expect(() => validateEvent({ ...base, kind: "delete" })).toThrow(/invalid event: requirementId/);
  });

  it("未知 kind 仍拒绝", () => {
    expect(() => validateEvent({ ...base, kind: "archive", requirementId: "REQ-001" })).toThrow(/invalid event: kind/);
  });
});

describe("validateEvent：pty 仅 link 合法", () => {
  it("skill + cli=pty 拒绝（skill 事件仍限三真实 CLI）", () => {
    expect(() =>
      validateEvent({ ...base, kind: "skill", sessionId: "s-1", cli: "pty", skill: "design-feature" }),
    ).toThrow(/invalid event: cli/);
  });

  it("link + cli=pty 合法（PTY 终端会话可关联，spec #15 A 节）", () => {
    const ev = validateEvent({ ...base, kind: "link", sessionId: "s-pty", cli: "pty", requirementId: "REQ-001" });
    expect(ev.cli).toBe("pty");
  });
});

describe("validateEvent：manual none 与 projectId/title 归一", () => {
  it("manual stage 为 none 字面量合法且归一为 null（未开始）", () => {
    const ev = validateEvent({
      ...base,
      kind: "manual",
      sessionId: null,
      requirementId: "REQ-001",
      stage: "none",
      source: "gui-stage-bar",
    });
    expect(ev.stage).toBeNull();
    // 已归一事件（stage=null）再次过校验合法——restore 重放已落库事件的必经路径
    expect(validateEvent(ev).stage).toBeNull();
  });

  it("manual stage 非法字面量仍拒绝", () => {
    expect(() =>
      validateEvent({ ...base, kind: "manual", requirementId: "REQ-001", stage: "Doing" }),
    ).toThrow(/invalid event: stage/);
  });

  it("skill 事件缺省 projectId/title 归一为 null（Main 注入前的事件不带 projectId 合法）", () => {
    const ev = validateEvent({ ...base, kind: "skill", sessionId: "s-1", cli: "codex", skill: "pr" });
    expect(ev.projectId).toBeNull();
    expect(ev.title).toBeNull();
  });

  it("skill 事件携带 projectId 归一保留（Main 注入路径）", () => {
    const ev = validateEvent({ ...base, kind: "skill", sessionId: "s-1", cli: "codex", skill: "pr", projectId: "p-1" });
    expect(ev.projectId).toBe("p-1");
  });
});
