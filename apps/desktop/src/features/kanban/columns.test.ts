// 用途：看板列映射与阶段依据行格式化单测（#18）—— stage=null→未开始列（易踩坑 5：wire "none" → tracker null → 列 0）与「skill · CLI · 日期」原型一致项 3
import { describe, expect, it } from "vitest";
import { KANBAN_COLUMNS, formatStageBasis, stageToColumn } from "./columns";

describe("stageToColumn 列映射（五列，#18）", () => {
  it("五列定义顺序：未开始/Design/Implement/PR/Retro", () => {
    expect(KANBAN_COLUMNS.map((c) => c.title)).toEqual(["未开始", "Design", "Implement", "PR", "Retro"]);
    expect(KANBAN_COLUMNS).toHaveLength(5);
  });

  it("stage=null → 未开始列（0）；四阶段各归其列", () => {
    expect(stageToColumn(null)).toBe(0);
    expect(stageToColumn("Design")).toBe(1);
    expect(stageToColumn("Implement")).toBe(2);
    expect(stageToColumn("PR")).toBe(3);
    expect(stageToColumn("Retro")).toBe(4);
  });
});

describe("formatStageBasis 阶段依据行（原型一致项 3：skill · CLI · 日期）", () => {
  it("skill 依据：skill 名 · CLI 显示名 · MM-DD", () => {
    expect(
      formatStageBasis({
        kind: "skill",
        skill: "design-feature",
        cli: "claude-code",
        evidenceLevel: "verified",
        eventId: null,
        at: "2026-11-06T02:30:00.000Z",
      }),
    ).toMatch(/^design-feature · Claude · \d{2}-\d{2}$/);
  });

  it("三真实 CLI 显示名映射 + pty", () => {
    const at = "2026-11-05T00:00:00.000Z";
    const basis = (cli: "codex" | "opencode" | "pty") =>
      formatStageBasis({ kind: "skill", skill: "pr", cli, evidenceLevel: "self_reported", eventId: null, at });
    expect(basis("codex")).toContain("Codex");
    expect(basis("opencode")).toContain("OpenCode");
    expect(basis("pty")).toContain("PTY");
  });

  it("manual 依据：手动修正 + 日期；无依据返回 null", () => {
    expect(formatStageBasis({ kind: "manual", eventId: "e1", at: "2026-11-06T12:00:00.000Z", source: "gui-manual" })).toMatch(
      /^手动修正 · \d{2}-\d{2}$/,
    );
    expect(formatStageBasis(null)).toBeNull();
  });
});
