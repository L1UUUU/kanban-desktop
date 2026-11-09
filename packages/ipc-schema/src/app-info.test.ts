// 用途：appInfoSchema zod 往返冒烟 —— 合法对象 parse 后保持等值、缺字段/错类型被拒（spec Testing seam 3 的首条用例）；app:event 推送契约（#49 残留检测一次性通知）
import { describe, expect, it } from "vitest";
import { appEventSchema, appInfoSchema } from "./app-info";

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

describe("appEventSchema（app:event 推送，#49 spec #40 D 节）", () => {
  it("residue-detected 携带残留清单往返等值", () => {
    const event = {
      type: "residue-detected",
      processes: [
        { pid: 18432, exePath: "C:\\npm\\codex.exe", startedAt: "2026-11-09T01:12:00.000Z", sessionTitle: "实现 Diff 解析" },
        { pid: 19004, exePath: "C:\\npm\\opencode.exe", startedAt: null, sessionTitle: null },
      ],
    };
    expect(appEventSchema.parse(event)).toEqual(event);
  });

  it("未知 type 与缺 processes 被拒绝", () => {
    expect(() => appEventSchema.parse({ type: "residue-gone" })).toThrow();
    expect(() => appEventSchema.parse({ type: "residue-detected" })).toThrow();
  });
});
