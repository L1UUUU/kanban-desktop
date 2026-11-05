// 用途：tracker 占位入口冒烟 —— 包可导入、依赖方向（仅 ipc-schema）自阶段 2 前替换为真实状态机
import { describe, expect, it } from "vitest";
import { TRACKER_PLACEHOLDER } from "./index";

describe("tracker 占位入口", () => {
  it("可导入且为字符串占位", () => {
    expect(typeof TRACKER_PLACEHOLDER).toBe("string");
  });
});
