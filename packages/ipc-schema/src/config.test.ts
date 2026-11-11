// 用途：config 契约测试 —— ① wire：config:ipc 二请求单通道联合 + autoArchive 边界（1–365 整数）+ 结果只携带 autoArchive 子集（issue #61，spec #57 配置链路节）；② 文件格式：appConfigFileSchema 全默认/字段级回退/节级回退/边界常量（issue #68，不重复 main 侧 loadConfig 行为场景，只测 schema 自身）
import { describe, expect, it } from "vitest";
import {
  AUTO_ARCHIVE_DAYS_BOUNDS,
  DIFF_LIMIT_BOUNDS,
  LOGGING_BOUNDS,
  appConfigFileSchema,
  autoArchiveConfigSchema,
  configRequestSchema,
  configResultSchema,
} from "./config";

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

describe("configResultSchema（结果只携带 autoArchive 子集 + 扫描摘要）", () => {
  it("成功形态：ok:true + autoArchive + lastScan（get/set 共用；读写均只回该子集，不暴露项目/CLI 路径等其余配置字段）", () => {
    const ok = configResultSchema.parse({ ok: true, autoArchive: { enabled: true, days: 7 }, lastScan: null });
    expect(ok).toEqual({ ok: true, autoArchive: { enabled: true, days: 7 }, lastScan: null });
    const scanned = configResultSchema.parse({
      ok: true,
      autoArchive: { enabled: true, days: 7 },
      lastScan: { archived: 2, failed: 1 },
    });
    expect(scanned).toEqual({ ok: true, autoArchive: { enabled: true, days: 7 }, lastScan: { archived: 2, failed: 1 } });
  });

  it("lastScan 缺失或形状非法（负数/非整数）被拒绝（#64 摘要为必携字段）", () => {
    expect(() => configResultSchema.parse({ ok: true, autoArchive: { enabled: true, days: 7 } })).toThrow();
    expect(() =>
      configResultSchema.parse({ ok: true, autoArchive: { enabled: true, days: 7 }, lastScan: { archived: -1, failed: 0 } }),
    ).toThrow();
    expect(() =>
      configResultSchema.parse({ ok: true, autoArchive: { enabled: true, days: 7 }, lastScan: { archived: 1.5, failed: 0 } }),
    ).toThrow();
  });

  it("失败形态：ok:false + error（code/message，写盘失败与入站非法共用 IPC 错误信封）", () => {
    const err = configResultSchema.parse({ ok: false, error: { code: "E_INTERNAL", message: "配置写盘失败：EACCES" } });
    expect(err.ok).toBe(false);
    expect(() => configResultSchema.parse({ ok: true })).toThrow();
    expect(() => configResultSchema.parse({ ok: false })).toThrow();
  });
});

describe("appConfigFileSchema（config.json 文件格式契约，issue #68）", () => {
  it("parse({}) = 全默认（各字段 .catch 默认值汇集，与 main defaultConfig 等值）", () => {
    expect(appConfigFileSchema.parse({})).toEqual({
      cliExe: { codex: null, claude: null, opencode: null },
      currentProjectId: null,
      gitExe: null,
      diff: { maxBytes: 2_000_000, maxFiles: 200, maxUntrackedLines: 2000 },
      terminal: { shell: null },
      shutdown: { graceMs: 3000 },
      logging: { level: "info", maxFileBytes: 5_000_000, retainRuns: 10, maxMessageChars: 2000 },
      autoArchive: { enabled: false, days: 30 },
    });
  });

  it("字段级回退：节内坏字段只回退该字段，不牵连整节（sectioned 内字段 .catch）", () => {
    const cfg = appConfigFileSchema.parse({ cliExe: { codex: 123 }, diff: { maxBytes: 1.5, maxFiles: 3 } });
    expect(cfg.cliExe.codex).toBeNull();
    expect(cfg.diff.maxBytes).toBe(2_000_000); // 非整数 → 回退默认
    expect(cfg.diff.maxFiles).toBe(3); // 同节合法字段不受牵连
  });

  it("节级回退：节缺失/非对象 → 整节默认（sectioned catch parse({})）", () => {
    const cfg = appConfigFileSchema.parse({ diff: "nope", logging: 42 });
    expect(cfg.diff).toEqual({ maxBytes: 2_000_000, maxFiles: 200, maxUntrackedLines: 2000 });
    expect(cfg.logging).toEqual({ level: "info", maxFileBytes: 5_000_000, retainRuns: 10, maxMessageChars: 2000 });
  });

  it("边界值采纳与拒绝（DIFF_LIMIT_BOUNDS / LOGGING_BOUNDS / graceMs 上限 / autoArchive 天数）", () => {
    expect(appConfigFileSchema.parse({ diff: { maxBytes: DIFF_LIMIT_BOUNDS.maxBytes } }).diff.maxBytes).toBe(DIFF_LIMIT_BOUNDS.maxBytes);
    expect(appConfigFileSchema.parse({ diff: { maxBytes: DIFF_LIMIT_BOUNDS.maxBytes + 1 } }).diff.maxBytes).toBe(2_000_000);
    expect(appConfigFileSchema.parse({ logging: { maxFileBytes: LOGGING_BOUNDS.maxFileBytes.min } }).logging.maxFileBytes).toBe(1024);
    expect(appConfigFileSchema.parse({ logging: { maxFileBytes: LOGGING_BOUNDS.maxFileBytes.min - 1 } }).logging.maxFileBytes).toBe(5_000_000);
    expect(appConfigFileSchema.parse({ shutdown: { graceMs: 60_000 } }).shutdown.graceMs).toBe(60_000);
    expect(appConfigFileSchema.parse({ shutdown: { graceMs: 60_001 } }).shutdown.graceMs).toBe(3000);
    expect(appConfigFileSchema.parse({ autoArchive: { days: AUTO_ARCHIVE_DAYS_BOUNDS.max } }).autoArchive.days).toBe(365);
    expect(appConfigFileSchema.parse({ autoArchive: { days: AUTO_ARCHIVE_DAYS_BOUNDS.max + 1 } }).autoArchive.days).toBe(30);
  });

  it("graceMs 非整数回退默认 3000（issue #68 语义收紧：原实现 Math.floor 采纳）", () => {
    expect(appConfigFileSchema.parse({ shutdown: { graceMs: 2500.7 } }).shutdown.graceMs).toBe(3000);
  });

  it("空串视同未设置（cliExe/gitExe/currentProjectId/terminal.shell → null）；未知顶层字段剥离", () => {
    const cfg = appConfigFileSchema.parse({ cliExe: { codex: "" }, gitExe: "", currentProjectId: "", terminal: { shell: "" }, unknownTop: 1 });
    expect(cfg.cliExe.codex).toBeNull();
    expect(cfg.gitExe).toBeNull();
    expect(cfg.currentProjectId).toBeNull();
    expect(cfg.terminal.shell).toBeNull();
    expect("unknownTop" in cfg).toBe(false);
  });
});
