// 用途：classify 三源样本矩阵密封测试（#46 验收 1）—— ① session_error 六枚举 ② renderer 合成 E_SESSION_EXIT ③ IPC 错误码，× 五类 + unknown 兜底全覆盖
import { describe, expect, it } from "vitest";
import { authLoginCommand, classifyError } from "./error-classify";

describe("classifyError 三源样本矩阵", () => {
  // 源 ①：ChatEvent session_error 六成员闭枚举（#41 收敛）
  it("源① session_error：AUTH_EXPIRED / SPAWN_NOT_FOUND / PROTOCOL_DISCONNECT / CLI_EXIT 直映射", () => {
    expect(classifyError("AUTH_EXPIRED")).toBe("auth_expired");
    expect(classifyError("SPAWN_NOT_FOUND")).toBe("spawn_not_found");
    expect(classifyError("PROTOCOL_DISCONNECT")).toBe("protocol_disconnect");
    expect(classifyError("CLI_EXIT")).toBe("cli_exit");
  });

  it("源① session_error：INTERNAL 与 UNKNOWN 落 unknown 兜底（保原文不编造）", () => {
    expect(classifyError("INTERNAL")).toBe("unknown");
    expect(classifyError("UNKNOWN")).toBe("unknown");
  });

  // 源 ②：renderer 合成码（chat-store session_exit 处理合成，不进 ChatEvent schema——F1/F4）
  it("源② renderer 合成：E_SESSION_EXIT 归 cli_exit（US 9）", () => {
    expect(classifyError("E_SESSION_EXIT")).toBe("cli_exit");
  });

  // 源 ③：IPC 错误结果 code（session:create / sendTurn / resume 可能回传的全部枚举成员）
  it("源③ IPC：E_SPAWN_NOT_FOUND 归 spawn_not_found（协议级映射，US 11）", () => {
    expect(classifyError("E_SPAWN_NOT_FOUND")).toBe("spawn_not_found");
  });

  it("源③ IPC：其余成员（E_SCHEMA/E_SESSION_NOT_FOUND/E_APPROVAL_EXPIRED/E_PROJECT_NOT_FOUND/E_REQUIREMENT_NOT_FOUND/E_INTERNAL）落 unknown", () => {
    for (const code of [
      "E_SCHEMA",
      "E_SESSION_NOT_FOUND",
      "E_APPROVAL_EXPIRED",
      "E_PROJECT_NOT_FOUND",
      "E_REQUIREMENT_NOT_FOUND",
      "E_INTERNAL",
    ]) {
      expect(classifyError(code)).toBe("unknown");
    }
  });

  it("unknown 兜底：未识别任意字符串不吞错（归 unknown，不抛出）", () => {
    expect(classifyError("E_WHATEVER")).toBe("unknown");
    expect(classifyError("")).toBe("unknown");
  });
});

describe("认证指引命令（按 CLI）", () => {
  it("三真实 CLI 给出具体 login 命令（auth-samples.md / CLI 实际命令）", () => {
    expect(authLoginCommand("codex")).toEqual(["codex login"]);
    expect(authLoginCommand("claude")).toEqual(["claude", "/login（进入 claude 后输入）"]);
    expect(authLoginCommand("opencode")).toEqual(["opencode auth login"]);
  });

  it("fake/未知 CLI 无指引命令（空数组，卡面不渲染命令块）", () => {
    expect(authLoginCommand("fake")).toEqual([]);
    expect(authLoginCommand("nonsense")).toEqual([]);
  });
});
