// 用途：cli-host 入口导出面冒烟 —— C1 契约与 FakeAdapter 自 index 可导入（依赖方向 cli-host → ipc-schema 成立）
import { describe, expect, it } from "vitest";
import { AdapterError, FakeAdapter, SystemClock, VirtualClock } from "./index";

describe("cli-host 入口导出", () => {
  it("C1 契约与 Fake/时钟均可导入", () => {
    expect(typeof FakeAdapter).toBe("function");
    expect(typeof VirtualClock).toBe("function");
    expect(typeof SystemClock).toBe("function");
    expect(new AdapterError("E_INTERNAL", "x").code).toBe("E_INTERNAL");
  });
});
