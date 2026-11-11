// 用途：CLI 展示目录密封测试 —— 显示名/色点/「＋」菜单收录均由单一目录表派生（文案与顺序收敛前基线，#67）
import { describe, expect, it } from "vitest";
import { CLI_DOT_CLS, CLI_LABELS, NEW_MENU_CLIS, sessionCliLabel } from "./cli-catalog";

describe("CLI 显示名（卡面标题用）", () => {
  it("四种 CLI 均有显示名", () => {
    expect(CLI_LABELS.codex).toBe("Codex");
    expect(CLI_LABELS.claude).toBe("Claude");
    expect(CLI_LABELS.opencode).toBe("OpenCode");
    expect(CLI_LABELS.fake).toBe("Fake");
  });
});

describe("会话 cli 显示名（sessionCliLabel）", () => {
  it("pty 终端与 tracker 词表 claude-code 有显示名（MemoryArea 原词表并入）", () => {
    expect(sessionCliLabel("pty")).toBe("PTY");
    expect(sessionCliLabel("claude-code")).toBe("Claude");
  });

  it("未知 cli 原样返回（不吞不编造）", () => {
    expect(sessionCliLabel("nonsense")).toBe("nonsense");
  });
});

describe("「＋」新建菜单收录（顺序即目录顺序）", () => {
  it("三真实 CLI 依 codex/claude/opencode 顺序列出，fake 不进菜单", () => {
    expect(NEW_MENU_CLIS.map((e) => e.cli)).toEqual(["codex", "claude", "opencode"]);
  });

  it("色点表覆盖全部 CliKind 并含 pty", () => {
    expect(CLI_DOT_CLS).toMatchObject({
      codex: "bg-codex",
      claude: "bg-claude",
      opencode: "bg-opencode",
      fake: "bg-accent2",
      pty: "bg-pty",
    });
  });
});
