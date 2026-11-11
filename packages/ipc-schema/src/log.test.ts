// 用途：日志 wire 契约密封单测（#55 spec #52 C 节）—— logLevelSchema/logEntrySchema 往返、ctx 逐键标量剥离（嵌套对象丢弃 = 逐键剥、条目保留）、scope 边界、message 无长度上限（N12：截断只在 Logger 按 config 生效）+ 诊断 kind 联合（issue #68：LOG_KINDS 全集供两包 producer 签名收窄）
import { describe, expect, it } from "vitest";
import { LOG_KINDS, logCtxSchema, logEntrySchema, logKindSchema, logLevelSchema, logSourceSchema, type LogEntryWire } from "./log";

// renderer 经 log:write 上报的典型形状（独立于实现构造，作为期望来源）
const validInput: LogEntryWire = {
  level: "error",
  source: "renderer",
  scope: "chat",
  message: "会话创建后自动关联被拒绝",
  ts: 1762748400000,
  ctx: { sessionId: "run-1", attempt: 2, ok: false },
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

  it("ctx 嵌套键被剥、标量键保留、message 不丢（spec #52 C 节「嵌套对象丢弃」为逐键剥离，条目本身保留）", () => {
    const parsed = logEntrySchema.parse({
      ...validInput,
      message: "关键消息不能丢",
      ctx: { error: { code: "E_X" }, list: [1, 2], n: null, sessionId: "run-1" },
    });
    expect(parsed.message).toBe("关键消息不能丢");
    expect(parsed.ctx).toEqual({ sessionId: "run-1" });
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

describe("logCtxSchema（标量 Record，逐键剥离）", () => {
  it("仅保留 string/number/boolean 标量键", () => {
    expect(logCtxSchema.parse({ a: "x", b: 1, c: true })).toEqual({ a: "x", b: 1, c: true });
  });

  it("嵌套对象/数组/null/undefined 值逐键剥离，标量键不受牵连（不整条丢弃）", () => {
    expect(
      logCtxSchema.parse({ err: { code: "E_X" }, list: [1, 2], n: null, u: undefined, keep: "x", cnt: 3, ok: false }),
    ).toEqual({ keep: "x", cnt: 3, ok: false });
  });
});

describe("logKindSchema（诊断 kind 联合，issue #68）", () => {
  it("LOG_KINDS 全集各自往返且无重复（生产者横跨 cli-host 适配器与 desktop main）", () => {
    expect(LOG_KINDS.length).toBeGreaterThan(0);
    expect(new Set(LOG_KINDS).size).toBe(LOG_KINDS.length);
    for (const k of LOG_KINDS) expect(logKindSchema.parse(k)).toBe(k);
  });

  it("联合外取值被拒绝（wire 守卫用：parentPort 消息 kind 未命中 → Main debug 兜底）", () => {
    expect(logKindSchema.safeParse("brand-new-kind").success).toBe(false);
    expect(logKindSchema.safeParse("").success).toBe(false);
    expect(logKindSchema.safeParse(123).success).toBe(false);
  });
});
