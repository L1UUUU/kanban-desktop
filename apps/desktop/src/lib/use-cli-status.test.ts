// 用途：isCliUnavailable 密封测试 —— 显式收窄（去 cast）后行为基线：结果未回不拦、fake 恒可选、仅三真实 CLI 显式 false 灰置（#80）
import { describe, expect, it } from "vitest";
import type { CliInstalledMap } from "@kanban/ipc-schema";
import { isCliUnavailable } from "./use-cli-status";

const INSTALLED: CliInstalledMap = { codex: true, claude: false, opencode: true };

describe("isCliUnavailable 禁用判定", () => {
  it("结果未回（null）不拦任何 CLI", () => {
    expect(isCliUnavailable(null, "codex")).toBe(false);
    expect(isCliUnavailable(null, "claude")).toBe(false);
    expect(isCliUnavailable(null, "opencode")).toBe(false);
    expect(isCliUnavailable(null, "fake")).toBe(false);
  });

  it("fake 无探测恒可选（键集不含 fake 也不误判）", () => {
    expect(isCliUnavailable(INSTALLED, "fake")).toBe(false);
  });

  it("三真实 CLI 仅显式 false 灰置（true 不拦）", () => {
    expect(isCliUnavailable(INSTALLED, "codex")).toBe(false);
    expect(isCliUnavailable(INSTALLED, "claude")).toBe(true);
    expect(isCliUnavailable(INSTALLED, "opencode")).toBe(false);
  });
});
