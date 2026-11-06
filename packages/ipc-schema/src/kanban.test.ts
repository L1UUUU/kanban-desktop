// 用途：看板 kanban:* wire 契约往返测试（#17 spec #15 C 节）—— 七通道请求 zod parse、kanban:list/link/create 载荷形状、TrackerChange 推送 schema 化、E_REQUIREMENT_NOT_FOUND 错误码
import { describe, expect, it } from "vitest";
import { errorCodeSchema, ipcRequestSchema, ipcResultSchema } from "./ipc";
import { requirementCardRowSchema, trackerChangeSchema } from "./kanban";

// 需求卡片行样例（skill 依据；stage=null + manual 依据另测）
const demoCard = {
  id: "REQ-001",
  title: "待命名需求",
  stage: "Design" as const,
  stageBasis: {
    kind: "skill" as const,
    skill: "design-feature",
    cli: "claude-code",
    evidenceLevel: "verified" as const,
    eventId: "sk-1",
    at: "2026-11-06T10:00:00.000Z",
  },
  uncertain: false,
  projectId: "p-1",
  sessions: ["s-1"],
};

describe("requirementCardRow（kanban:list 行形状）", () => {
  it("合法往返（skill 依据）；stage=null 与 manual 依据（source 可空）同样合法", () => {
    expect(requirementCardRowSchema.parse(demoCard)).toEqual(demoCard);
    const unstarted = {
      ...demoCard,
      stage: null,
      stageBasis: { kind: "manual", eventId: "m-1", at: "2026-11-06T11:00:00.000Z", source: "gui-kanban" },
    };
    expect(requirementCardRowSchema.parse(unstarted)).toEqual(unstarted);
    const manualNullSource = {
      ...demoCard,
      stageBasis: { kind: "manual", eventId: "m-2", at: "2026-11-06T11:00:00.000Z", source: null },
    };
    expect(requirementCardRowSchema.parse(manualNullSource)).toEqual(manualNullSource);
  });

  it("枚举外 stage / 依据 kind / 空 title 被拒", () => {
    expect(() => requirementCardRowSchema.parse({ ...demoCard, stage: "Done" })).toThrow();
    expect(() => requirementCardRowSchema.parse({ ...demoCard, stageBasis: { ...demoCard.stageBasis, kind: "hook" } })).toThrow();
    expect(() => requirementCardRowSchema.parse({ ...demoCard, title: "" })).toThrow();
    expect(() => requirementCardRowSchema.parse({ ...demoCard, sessions: [""] })).toThrow();
  });
});

describe("trackerChangeSchema（tracker 变更推送载荷，六成员）", () => {
  it("requirement_created：sessionId 可空（手动建卡无会话）", () => {
    expect(
      trackerChangeSchema.parse({ type: "requirement_created", requirementId: "REQ-001", stage: null, sessionId: null }),
    ).toEqual({ type: "requirement_created", requirementId: "REQ-001", stage: null, sessionId: null });
    expect(
      trackerChangeSchema.parse({ type: "requirement_created", requirementId: "REQ-001", stage: "Design", sessionId: "s-1" }),
    ).toEqual({ type: "requirement_created", requirementId: "REQ-001", stage: "Design", sessionId: "s-1" });
  });

  it("stage_changed：basis 为 skill/manual 依据；session_linked/unlinked；requirement_renamed/deleted", () => {
    expect(
      trackerChangeSchema.parse({
        type: "stage_changed",
        requirementId: "REQ-001",
        stage: "Implement",
        basis: demoCard.stageBasis,
        uncertain: true,
      }),
    ).toMatchObject({ type: "stage_changed", stage: "Implement", uncertain: true });
    expect(
      trackerChangeSchema.parse({ type: "session_linked", requirementId: "REQ-001", sessionId: "s-2" }),
    ).toEqual({ type: "session_linked", requirementId: "REQ-001", sessionId: "s-2" });
    expect(
      trackerChangeSchema.parse({ type: "session_unlinked", requirementId: "REQ-001", sessionId: "s-2", stageKept: null }),
    ).toEqual({ type: "session_unlinked", requirementId: "REQ-001", sessionId: "s-2", stageKept: null });
    expect(
      trackerChangeSchema.parse({ type: "requirement_renamed", requirementId: "REQ-001", title: "新标题" }),
    ).toEqual({ type: "requirement_renamed", requirementId: "REQ-001", title: "新标题" });
    expect(
      trackerChangeSchema.parse({ type: "requirement_deleted", requirementId: "REQ-001" }),
    ).toEqual({ type: "requirement_deleted", requirementId: "REQ-001" });
  });

  it("未知成员 / 缺字段被拒", () => {
    expect(() => trackerChangeSchema.parse({ type: "requirement_archived", requirementId: "REQ-001" })).toThrow();
    expect(() => trackerChangeSchema.parse({ type: "requirement_deleted" })).toThrow();
    expect(() => trackerChangeSchema.parse("requirement_deleted")).toThrow();
  });
});

describe("kanban:* 七通道请求（判别联合成员）", () => {
  it("kanban:list：projectId 可选（省略=全部需求）", () => {
    expect(ipcRequestSchema.parse({ channel: "kanban:list" })).toEqual({ channel: "kanban:list" });
    expect(ipcRequestSchema.parse({ channel: "kanban:list", projectId: "p-1" })).toEqual({
      channel: "kanban:list",
      projectId: "p-1",
    });
  });

  it("kanban:create：projectId 必填、title 可选（缺省待命名需求）、空 title 被拒", () => {
    expect(ipcRequestSchema.parse({ channel: "kanban:create", projectId: "p-1" })).toEqual({
      channel: "kanban:create",
      projectId: "p-1",
    });
    expect(ipcRequestSchema.parse({ channel: "kanban:create", projectId: "p-1", title: "手动建卡" })).toEqual({
      channel: "kanban:create",
      projectId: "p-1",
      title: "手动建卡",
    });
    expect(() => ipcRequestSchema.parse({ channel: "kanban:create", projectId: "" })).toThrow();
    expect(() => ipcRequestSchema.parse({ channel: "kanban:create", projectId: "p-1", title: "" })).toThrow();
  });

  it("kanban:rename：requirementId+title 非空", () => {
    const req = { channel: "kanban:rename", requirementId: "REQ-001", title: "新标题" };
    expect(ipcRequestSchema.parse(req)).toEqual(req);
    expect(() => ipcRequestSchema.parse({ ...req, requirementId: "" })).toThrow();
    expect(() => ipcRequestSchema.parse({ ...req, title: "" })).toThrow();
  });

  it("kanban:setStage：stage 为四阶段 + none（未开始）；枚举外被拒", () => {
    for (const stage of ["Design", "Implement", "PR", "Retro", "none"]) {
      expect(ipcRequestSchema.parse({ channel: "kanban:setStage", requirementId: "REQ-001", stage })).toEqual({
        channel: "kanban:setStage",
        requirementId: "REQ-001",
        stage,
      });
    }
    expect(() => ipcRequestSchema.parse({ channel: "kanban:setStage", requirementId: "REQ-001", stage: "done" })).toThrow();
    expect(() => ipcRequestSchema.parse({ channel: "kanban:setStage", requirementId: "", stage: "PR" })).toThrow();
  });

  it("kanban:link / kanban:unlink：sessionId 非空；link 另需 requirementId", () => {
    const link = { channel: "kanban:link", sessionId: "s-1", requirementId: "REQ-001" };
    expect(ipcRequestSchema.parse(link)).toEqual(link);
    expect(() => ipcRequestSchema.parse({ ...link, requirementId: "" })).toThrow();
    const unlink = { channel: "kanban:unlink", sessionId: "s-1" };
    expect(ipcRequestSchema.parse(unlink)).toEqual(unlink);
    expect(() => ipcRequestSchema.parse({ ...unlink, sessionId: "" })).toThrow();
  });

  it("kanban:delete：requirementId 非空", () => {
    const req = { channel: "kanban:delete", requirementId: "REQ-001" };
    expect(ipcRequestSchema.parse(req)).toEqual(req);
    expect(() => ipcRequestSchema.parse({ ...req, requirementId: "" })).toThrow();
  });

  it("session:create 加可选 requirementId（原子关联入参，spec #15 C 节）", () => {
    const req = { channel: "session:create", cli: "claude", cwd: "C:\\p", projectId: "p-1", requirementId: "REQ-001" };
    expect(ipcRequestSchema.parse(req)).toEqual(req);
    expect(ipcRequestSchema.parse({ channel: "session:create", cli: "fake", cwd: "C:\\p" })).toEqual({
      channel: "session:create",
      cli: "fake",
      cwd: "C:\\p",
    });
    expect(() => ipcRequestSchema.parse({ ...req, requirementId: "" })).toThrow();
  });
});

describe("kanban 结果载荷与错误码", () => {
  it("E_REQUIREMENT_NOT_FOUND 入错误码枚举（未知需求 id）", () => {
    expect(errorCodeSchema.parse("E_REQUIREMENT_NOT_FOUND")).toBe("E_REQUIREMENT_NOT_FOUND");
    expect(
      ipcResultSchema.parse({ ok: false, error: { code: "E_REQUIREMENT_NOT_FOUND", message: "需求不存在：REQ-404" } }),
    ).toEqual({ ok: false, error: { code: "E_REQUIREMENT_NOT_FOUND", message: "需求不存在：REQ-404" } });
  });

  it("kanban:list 载荷：requirements 行数组 + sessionToReq 反查映射", () => {
    const res = { ok: true as const, requirements: [demoCard], sessionToReq: { "s-1": "REQ-001" } };
    expect(ipcResultSchema.parse(res)).toEqual(res);
    expect(ipcResultSchema.parse({ ok: true, requirements: [], sessionToReq: {} })).toEqual({
      ok: true,
      requirements: [],
      sessionToReq: {},
    });
    expect(() => ipcResultSchema.parse({ ok: true, requirements: [{ ...demoCard, projectId: 1 }] })).toThrow();
    expect(() => ipcResultSchema.parse({ ok: true, sessionToReq: { "s-1": 9 } })).toThrow();
  });

  it("kanban:link 载荷：linked/reason（业务拒绝是合法结果而非错误）；kanban:create 附 requirementId", () => {
    expect(ipcResultSchema.parse({ ok: true, linked: true })).toEqual({ ok: true, linked: true });
    expect(ipcResultSchema.parse({ ok: true, linked: false, reason: "跨项目关联被拒绝" })).toEqual({
      ok: true,
      linked: false,
      reason: "跨项目关联被拒绝",
    });
    expect(() => ipcResultSchema.parse({ ok: true, linked: "yes" })).toThrow();
    expect(ipcResultSchema.parse({ ok: true, requirementId: "REQ-001" })).toEqual({ ok: true, requirementId: "REQ-001" });
  });

  it("session:create（claude）载荷：skillConflicts 字符串数组（#17 固定空数组，真实检测 #21）", () => {
    expect(
      ipcResultSchema.parse({ ok: true, sessionId: "s-1", skillConflicts: [] }),
    ).toEqual({ ok: true, sessionId: "s-1", skillConflicts: [] });
    expect(
      ipcResultSchema.parse({ ok: true, sessionId: "s-1", skillConflicts: ["code-review"] }),
    ).toEqual({ ok: true, sessionId: "s-1", skillConflicts: ["code-review"] });
    expect(() => ipcResultSchema.parse({ ok: true, skillConflicts: [1] })).toThrow();
  });
});
