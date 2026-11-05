// 用途：cli-host 占位入口冒烟 —— 包可导入、依赖方向（仅 ipc-schema）自 #6 起被真实契约替换
import { describe, expect, it } from "vitest";
import { CLI_HOST_PLACEHOLDER } from "./index";

describe("cli-host 占位入口", () => {
  it("可导入且为字符串占位", () => {
    expect(typeof CLI_HOST_PLACEHOLDER).toBe("string");
  });
});
