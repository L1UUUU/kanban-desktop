// 用途：Renderer 日志入站处理密封单测（#55 spec #52 B/C 节）—— safeParse 失败丢弃记 warn 不抛错、source 强制 renderer 不信自报、ts 由 Logger 生成（wire ts 不透传）
import { describe, expect, it } from "vitest";
import { LOG_LEVELS as SCHEMA_LEVELS } from "@kanban/ipc-schema";
import { logLevelSchema } from "@kanban/ipc-schema";
import { LOG_LEVELS as LOGGER_LEVELS } from "./logger";
import type { LogCtx, LogLevel, LogSource } from "./logger";
import { handleLogWrite } from "./log-write";

/** 记录调用形状（含第 5 参 source） */
interface Call {
  level: LogLevel;
  scope: string;
  message: string;
  ctx: LogCtx | undefined;
  source: LogSource | undefined;
}

/** fake logger：按 Logger.log 完整签名收集调用 */
function makeLogger(): { calls: Call[]; log: (level: LogLevel, scope: string, message: string, ctx?: LogCtx, source?: LogSource) => void } {
  const calls: Call[] = [];
  return {
    calls,
    log: (level, scope, message, ctx, source) => calls.push({ level, scope, message, ctx, source }),
  };
}

// renderer 经 log:write 发来的典型合法条目（preload 侧构造）
const validEntry = {
  level: "error",
  source: "renderer",
  scope: "chat",
  message: "会话创建后自动关联被拒绝",
  ts: 1762748400000,
  ctx: { reason: "跨项目" },
};

describe("handleLogWrite（log:write 入站）", () => {
  it("合法条目 → logger.log 收到 level/scope/message/ctx 且 source 强制 renderer", () => {
    const logger = makeLogger();
    handleLogWrite(logger, validEntry);
    expect(logger.calls).toEqual([
      { level: "error", scope: "chat", message: "会话创建后自动关联被拒绝", ctx: { reason: "跨项目" }, source: "renderer" },
    ]);
  });

  it("wire ts 不透传（落盘 ts 由 Logger 生成，不信自报）", () => {
    const logger = makeLogger();
    handleLogWrite(logger, validEntry);
    const call = logger.calls[0] as unknown as Record<string, unknown>;
    expect(call.ts).toBeUndefined();
    expect(JSON.stringify(call)).not.toContain("1762748400000");
  });

  it("自报 source=main 仍被强制 renderer（不信上游自报）", () => {
    const logger = makeLogger();
    handleLogWrite(logger, { ...validEntry, source: "main" });
    expect(logger.calls[0]?.source).toBe("renderer");
  });

  it("safeParse 失败丢弃并记一条 warn、不抛错、不回 Renderer（send 语义）", () => {
    const logger = makeLogger();
    // 非法 level / 缺字段 / 非对象 三类非法输入（ctx 嵌套已改为逐键剥离，不再整条丢弃，见下用例）
    const badInputs: unknown[] = [
      { ...validEntry, level: "fatal" },
      { level: "warn", source: "renderer", scope: "chat", message: "缺 ts" },
      "not-an-object",
    ];
    for (const raw of badInputs) {
      expect(() => handleLogWrite(logger, raw)).not.toThrow();
    }
    expect(logger.calls.length).toBe(3);
    for (const call of logger.calls) {
      expect(call.level).toBe("warn");
      expect(call.scope).toBe("log");
      expect(call.message).toContain("不符合 schema");
    }
  });

  it("ctx 逐键剥离：嵌套键被剥、标量键保留、message 不丢（条目仍入 Logger，不整条丢弃）", () => {
    const logger = makeLogger();
    handleLogWrite(logger, { ...validEntry, ctx: { error: { code: "E_X" }, reason: "跨项目" } });
    expect(logger.calls).toEqual([
      { level: "error", scope: "chat", message: "会话创建后自动关联被拒绝", ctx: { reason: "跨项目" }, source: "renderer" },
    ]);
  });
});

describe("枚举同源防脱钩（schema 与 Logger 的 level 枚举一致）", () => {
  it("Logger LOG_LEVELS 逐项通过 logLevelSchema 且集合等长", () => {
    expect(LOGGER_LEVELS.length).toBe(SCHEMA_LEVELS.length);
    for (const lv of LOGGER_LEVELS) expect(logLevelSchema.parse(lv)).toBe(lv);
  });
});
