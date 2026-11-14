// 用途：ipc/helpers 密封测试 —— link 拒绝文案单源 linkRejectionMessage（arch D1）逐字钉住四类结构化原因的 wire 文案
import { describe, expect, it } from "vitest";
import type { LinkRejectionReason } from "@kanban/tracker";
import { linkRejectionMessage } from "./helpers";

describe("linkRejectionMessage（arch D1 文案单源）", () => {
  it("四类结构化拒绝原因 → 用户可读中文（与收编前两处手抄文案逐字一致）", () => {
    const cases: Array<[LinkRejectionReason, string]> = [
      [{ kind: "requirement_absent", requirementId: "REQ-404" }, "需求不存在：REQ-404"],
      [
        { kind: "session_conflict", sessionId: "s-1", requirementId: "REQ-002", currentRequirementId: "REQ-001" },
        "会话已关联需求 REQ-001，请先解除关联",
      ],
      [{ kind: "session_unprojected", sessionId: "s-1", requirementId: "REQ-001" }, "会话未归属项目，无法关联需求（请先在项目中创建会话）"],
      [
        { kind: "project_mismatch", sessionId: "s-1", requirementId: "REQ-001", sessionProjectId: "pA", requirementProjectId: "pB" },
        "跨项目关联被拒绝：会话属项目 pA，需求属项目 pB",
      ],
    ];
    for (const [reason, message] of cases) expect(linkRejectionMessage(reason)).toBe(message);
  });
});
