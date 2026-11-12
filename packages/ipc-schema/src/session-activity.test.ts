// 用途：activityBasisMs 单源的密封测试 —— COALESCE 优先序与不可解析保守 null（独立已知值断言，非重演实现）
import { describe, expect, it } from "vitest";
import { activityBasisMs } from "./session-activity";

describe("activityBasisMs（活跃基准单源：COALESCE(lastActiveAt, createdAt)）", () => {
  it("lastActiveAt 优先：两值都给时取 lastActiveAt 的毫秒数", () => {
    expect(activityBasisMs("2026-11-12T08:00:00.000Z", "2026-11-01T00:00:00.000Z")).toBe(Date.parse("2026-11-12T08:00:00.000Z"));
  });

  it("lastActiveAt 为 null 回落 createdAt（全无活跃时间时的基准 = 创建时间）", () => {
    expect(activityBasisMs(null, "2026-11-01T00:00:00.000Z")).toBe(Date.parse("2026-11-01T00:00:00.000Z"));
  });

  it("两者皆 null 返回 null（无任何时间基准）", () => {
    expect(activityBasisMs(null, null)).toBeNull();
  });

  it("基准不可解析（脏数据）保守返回 null：lastActiveAt 乱码不回落 createdAt，与自动归档同口径", () => {
    expect(activityBasisMs("not-a-date", "2026-11-01T00:00:00.000Z")).toBeNull();
    expect(activityBasisMs(null, "not-a-date")).toBeNull();
  });
});
