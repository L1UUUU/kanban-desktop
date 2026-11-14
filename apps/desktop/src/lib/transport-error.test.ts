// 用途：transport 兜底错误载体密封测试（arch D10）—— code 恒 E_INTERNAL（满足各 IpcResult 错误形态）、message 由各域逐字透传
import { describe, expect, it } from "vitest";
import { transportUnavailableError } from "./transport-error";

describe("transportUnavailableError", () => {
  it("code 恒 E_INTERNAL，message 逐字透传（各域服务名文案不在此收口）", () => {
    expect(transportUnavailableError("transport 不可用")).toEqual({ code: "E_INTERNAL", message: "transport 不可用" });
    expect(transportUnavailableError("记忆服务不可用")).toEqual({ code: "E_INTERNAL", message: "记忆服务不可用" });
  });
});
