// 用途：appInfoSchema zod 往返冒烟 —— 合法对象 parse 后保持等值、缺字段/错类型被拒（spec Testing seam 3 的首条用例）
import { describe, expect, it } from "vitest";
import { appInfoSchema } from "./app-info";

// 主进程将上报的典型形状（独立于实现构造，作为期望来源）
const validInput = {
  app: "kanban-desktop",
  electron: "44.10.2",
  node: "24.19.0",
  chrome: "148.0.7000.0",
  platform: "win32",
  sqliteEntry: "DatabaseSync",
  fakeDemoCwd: "C:\\Users\\demo",
};

describe("appInfoSchema 往返", () => {
  it("合法对象 parse 后与输入等值", () => {
    expect(appInfoSchema.parse(validInput)).toEqual(validInput);
  });

  it("缺失字段被拒绝", () => {
    const { chrome: _omit, ...partial } = validInput;
    expect(() => appInfoSchema.parse(partial)).toThrow();
  });

  it("字段类型错误被拒绝", () => {
    expect(() => appInfoSchema.parse({ ...validInput, electron: 44 })).toThrow();
    expect(() => appInfoSchema.parse({ ...validInput, platform: null })).toThrow();
  });
});
