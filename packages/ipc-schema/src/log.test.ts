// 用途：日志 wire 契约密封单测（#55 spec #52 C 节）—— logLevelSchema/logEntrySchema 往返、ctx 标量校验（嵌套丢弃）、scope 边界、message 无长度上限（N12：截断只在 Logger 按 config 生效）
import { describe, expect, it } from "vitest";
import { logCtxSchema, logEntrySchema, logLevelSchema, logSourceSchema, type LogEntryWire } from "./log";

// renderer 经 log:write 上报的典型形状（独立于实现构造，作为期望来源）
const validInput: LogEntryWire = {
  level: "error",
  source: "renderer",
  scope: "chat",
  message: "会话创建后自动关联被拒绝",
  ts: 1762748400000,
  ctx: { sessionId: "run-1", attempt: 2, ok: false, detail: null },
};

describe("logLevelSchema / logSourceSchema 枚举", () => {
  it("四级枚举与三来源枚举各自往返", () => {
    for (const lv of ["error", "warn", "info", "debug"] as const) expect(logLevelSchema.parse(lv)).toBe(lv);
    for (const s of ["main", "worker", "renderer"] as const) expect(logSourceSchema.parse(s)).toBe(s);
  });

  it("枚举外取值被拒绝", () => {
    expect(() => logLevelSchema.parse("fatal")).toThrow();
    expect(() => logLevelSchema.parse("trace")).toThrow();
    expect(() => logSourceSchema.parse("cli")).toThrow();
  });
});

describe("logEntrySchema 往返与边界", () => {
  it("合法条目 parse 后与输入等值（ctx 标量四类型齐备）", () => {
    expect(logEntrySchema.parse(validInput)).toEqual(validInput);
  });

  it("ctx 可省略", () => {
    const { ctx: _omit, ...noCtx } = validInput;
    expect(logEntrySchema.parse(noCtx)).toEqual(noCtx);
  });

  it("ctx 嵌套对象/数组被拒绝（标量校验生效，嵌套到不了日志）", () => {
    expect(() => logEntrySchema.parse({ ...validInput, ctx: { error: { code: "E_X" } } })).toThrow();
    expect(() => logEntrySchema.parse({ ...validInput, ctx: { list: [1, 2] } })).toThrow();
  });

  it("字段类型错误被拒绝（level/source/scope/message/ts）", () => {
    expect(() => logEntrySchema.parse({ ...validInput, level: "fatal" })).toThrow();
    expect(() => logEntrySchema.parse({ ...validInput, source: "cli" })).toThrow();
    expect(() => logEntrySchema.parse({ ...validInput, scope: 42 })).toThrow();
    expect(() => logEntrySchema.parse({ ...validInput, message: 42 })).toThrow();
    expect(() => logEntrySchema.parse({ ...validInput, ts: "1762748400000" })).toThrow();
  });

  it("缺失字段被拒绝", () => {
    const { ts: _omit, ...noTs } = validInput;
    expect(() => logEntrySchema.parse(noTs)).toThrow();
  });

  it("scope 边界：64 字符通过、65 字符被拒", () => {
    expect(logEntrySchema.parse({ ...validInput, scope: "s".repeat(64) })).toBeTruthy();
    expect(() => logEntrySchema.parse({ ...validInput, scope: "s".repeat(65) })).toThrow();
  });

  it("message 无 schema 长度上限（N12：截断只在 Logger 按 config 运行期值生效）", () => {
    const long = { ...validInput, message: "x".repeat(100_000) };
    expect(logEntrySchema.parse(long).message).toHaveLength(100_000);
  });
});

describe("logCtxSchema（标量 Record）", () => {
  it("仅收 string/number/boolean/null", () => {
    expect(logCtxSchema.parse({ a: "x", b: 1, c: true, d: null })).toEqual({ a: "x", b: 1, c: true, d: null });
  });

  it("undefined 值被拒绝（调用方不得以 { k: undefined } 形态携带可选键）", () => {
    expect(() => logCtxSchema.parse({ a: undefined })).toThrow();
  });
});
