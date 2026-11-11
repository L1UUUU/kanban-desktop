// 用途：config wire 契约测试 —— config:ipc 二请求单通道联合 + autoArchive 边界（1–365 整数）+ 结果只携带 autoArchive 子集（issue #61，spec #57 配置链路节；对齐 diff:ipc 独立单通道先例）
import { describe, expect, it } from "vitest";
import { autoArchiveConfigSchema, configRequestSchema, configResultSchema } from "./config";

describe("autoArchiveConfigSchema（自动归档配置节）", () => {
  it("合法对象 parse 后与输入等值（enabled 布尔 + days 界内整数）", () => {
    expect(autoArchiveConfigSchema.parse({ enabled: false, days: 30 })).toEqual({ enabled: false, days: 30 });
    expect(autoArchiveConfigSchema.parse({ enabled: true, days: 1 })).toEqual({ enabled: true, days: 1 });
    expect(autoArchiveConfigSchema.parse({ enabled: true, days: 365 })).toEqual({ enabled: true, days: 365 });
  });

  it("days 越界（0/366/负数）与非整数（1.5）被拒绝；enabled 非布尔被拒绝；缺字段被拒绝", () => {
    expect(() => autoArchiveConfigSchema.parse({ enabled: true, days: 0 })).toThrow();
    expect(() => autoArchiveConfigSchema.parse({ enabled: true, days: 366 })).toThrow();
    expect(() => autoArchiveConfigSchema.parse({ enabled: true, days: -30 })).toThrow();
    expect(() => autoArchiveConfigSchema.parse({ enabled: true, days: 1.5 })).toThrow();
    expect(() => autoArchiveConfigSchema.parse({ enabled: true, days: "30" })).toThrow();
    expect(() => autoArchiveConfigSchema.parse({ enabled: "on", days: 30 })).toThrow();
    expect(() => autoArchiveConfigSchema.parse({ days: 30 })).toThrow();
    expect(() => autoArchiveConfigSchema.parse({ enabled: true })).toThrow();
  });
});

describe("configRequestSchema（config:ipc 二请求联合）", () => {
  it("config:get 无载荷合法；config:set 携带完整 autoArchive 节合法", () => {
    expect(configRequestSchema.parse({ channel: "config:get" })).toEqual({ channel: "config:get" });
    const set = configRequestSchema.parse({ channel: "config:set", autoArchive: { enabled: true, days: 14 } });
    expect(set).toEqual({ channel: "config:set", autoArchive: { enabled: true, days: 14 } });
  });

  it("未知通道被拒绝；config:set 载荷缺 autoArchive 节或节内非法被拒绝", () => {
    expect(() => configRequestSchema.parse({ channel: "config:nuke" })).toThrow();
    expect(() => configRequestSchema.parse({ channel: "config:set" })).toThrow();
    expect(() => configRequestSchema.parse({ channel: "config:set", autoArchive: { enabled: true, days: 9999 } })).toThrow();
  });
});

describe("configResultSchema（结果只携带 autoArchive 子集）", () => {
  it("成功形态：ok:true + autoArchive（get/set 共用；读写均只回该子集，不暴露项目/CLI 路径等其余配置字段）", () => {
    const ok = configResultSchema.parse({ ok: true, autoArchive: { enabled: true, days: 7 } });
    expect(ok).toEqual({ ok: true, autoArchive: { enabled: true, days: 7 } });
  });

  it("失败形态：ok:false + error（code/message，写盘失败与入站非法共用 IPC 错误信封）", () => {
    const err = configResultSchema.parse({ ok: false, error: { code: "E_INTERNAL", message: "配置写盘失败：EACCES" } });
    expect(err.ok).toBe(false);
    expect(() => configResultSchema.parse({ ok: true })).toThrow();
    expect(() => configResultSchema.parse({ ok: false })).toThrow();
  });
});
