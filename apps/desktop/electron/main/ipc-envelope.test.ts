// 用途：信封工厂密封测试 —— 两方言入站拒绝/退出门闸形状与文案、三档 catch 策略（AdapterError 透传/rethrow/fail）、业务拒绝不记日志（#72 C1 Step1 新增；既有端到端契约仍由 ipc.test.ts 经 handleIpc 公共面覆盖）
import { describe, expect, it } from "vitest";
import { AdapterError } from "@kanban/cli-host";
import type { LogFn, LogLevel } from "./logger";
import { codeEnvelope, createChannelHandler, reasonEnvelope, type EnvelopeCatch, type EnvelopeDeps, type EnvelopeSchema } from "./ipc-envelope";

/** 测试用最小契约：单通道 echo 请求（手写 fake 实现结构面 EnvelopeSchema——工厂不绑 zod，desktop 主代码同理不直依赖 zod 包） */
type EchoRequest = { channel: "test:echo"; text: string };
const echoSchema: EnvelopeSchema<EchoRequest> = {
  safeParse: (raw) => {
    if (typeof raw === "object" && raw !== null && (raw as { channel?: unknown }).channel === "test:echo") {
      const text = (raw as { text?: unknown }).text;
      return typeof text === "string" && text.length > 0
        ? { success: true, data: { channel: "test:echo" as const, text } }
        : { success: false, error: { issues: [{ path: ["text"], message: "too_small" }] } };
    }
    return { success: false, error: { issues: [{ path: [], message: "invalid_literal" }] } };
  },
};
type EchoResult = { ok: false; error: { code: string; message: string } } | { ok: false; reason: string; detail?: string } | { ok: true; echoed: string };

/** 日志 spy（对齐 ipc.test.ts #53 describe 的收集形态） */
function spyLog(): { log: LogFn; entries: Array<{ level: LogLevel; scope: string; message: string }> } {
  const entries: Array<{ level: LogLevel; scope: string; message: string }> = [];
  return { log: (level, scope, message) => entries.push({ level, scope, message }), entries };
}

/** 造一个走工厂的处理器（方言用生产预设 codeEnvelope/reasonEnvelope，route 可注入） */
function makeHandler(dialect: "code" | "reason", route: (req: EchoRequest, deps: EnvelopeDeps) => Promise<EchoResult>, catchStyle: EnvelopeCatch<EchoResult>) {
  return (deps: EnvelopeDeps, raw: unknown) =>
    createChannelHandler<EchoRequest, EchoResult, EnvelopeDeps>(
      { scope: "test:ipc", schema: echoSchema, dialect: dialect === "code" ? codeEnvelope : reasonEnvelope, catchStyle },
      deps,
      route,
    )(raw);
}

const passthrough: EnvelopeCatch<EchoResult> = { kind: "adapter-passthrough", toError: codeEnvelope.toError };
const rethrow: EnvelopeCatch<EchoResult> = { kind: "rethrow" };

describe("信封工厂：入站拒绝（两方言形状与文案锚点）", () => {
  it("code 方言：E_SCHEMA + 摘要，记一条 error（scope/message 锚点）", async () => {
    const spy = spyLog();
    const res = await makeHandler("code", async (req) => ({ ok: true, echoed: req.text }), passthrough)({ log: spy.log }, { channel: "test:echo", text: "" });
    expect(res).toEqual({ ok: false, error: { code: "E_SCHEMA", message: expect.any(String) } });
    expect(spy.entries).toHaveLength(1);
    expect(spy.entries[0]).toMatchObject({ level: "error", scope: "test:ipc" });
    expect(spy.entries[0].message).toContain("E_SCHEMA");
  });

  it("reason 方言：invalid-request + detail，记一条 error", async () => {
    const spy = spyLog();
    const res = await makeHandler("reason", async (req) => ({ ok: true, echoed: req.text }), rethrow)({ log: spy.log }, "not-an-object");
    expect(res).toEqual({ ok: false, reason: "invalid-request", detail: expect.any(String) });
    expect(spy.entries).toHaveLength(1);
    expect(spy.entries[0].message).toContain("invalid-request");
  });
});

describe("信封工厂：退出门闸", () => {
  it("code 方言 → E_INTERNAL + 退出文案；reason 方言 → shutting-down + 同文案", async () => {
    const code = await makeHandler("code", async (req) => ({ ok: true, echoed: req.text }), passthrough)({ isShuttingDown: () => true }, { channel: "test:echo", text: "hi" });
    expect(code).toEqual({ ok: false, error: { code: "E_INTERNAL", message: "应用正在退出，已停止接收新请求" } });
    const reason = await makeHandler("reason", async (req) => ({ ok: true, echoed: req.text }), rethrow)({ isShuttingDown: () => true }, { channel: "test:echo", text: "hi" });
    expect(reason).toEqual({ ok: false, reason: "shutting-down", detail: "应用正在退出，已停止接收新请求" });
  });

  it("缺省 isShuttingDown（旧测试夹具不注入）恒放行", async () => {
    const res = await makeHandler("code", async (req) => ({ ok: true, echoed: req.text }), passthrough)({}, { channel: "test:echo", text: "hi" });
    expect(res).toEqual({ ok: true, echoed: "hi" });
  });
});

describe("信封工厂：catch 策略三档", () => {
  it("adapter-passthrough：AdapterError 错误码透传；非 AdapterError 兜底 E_INTERNAL；日志含原码", async () => {
    const spy = spyLog();
    const handle = makeHandler("code", async () => { throw new AdapterError("E_SESSION_NOT_FOUND", "会话不存在：s-1"); }, passthrough);
    const res = await handle({ log: spy.log }, { channel: "test:echo", text: "x" });
    expect(res).toEqual({ ok: false, error: { code: "E_SESSION_NOT_FOUND", message: "会话不存在：s-1" } });
    expect(spy.entries[0].message).toContain("E_SESSION_NOT_FOUND");
    const res2 = await makeHandler("code", async () => { throw new Error("boom"); }, passthrough)({ log: spy.log }, { channel: "test:echo", text: "x" });
    expect(res2).toEqual({ ok: false, error: { code: "E_INTERNAL", message: "boom" } });
    expect(spy.entries[1].message).toContain("E_INTERNAL");
    expect(spy.entries[1].message).toContain("boom");
  });

  it("rethrow：记一条 error 后原样 rethrow（不吞不改）", async () => {
    const spy = spyLog();
    const boom = new Error("探测爆炸");
    const handle = makeHandler("reason", async () => { throw boom; }, rethrow);
    await expect(handle({ log: spy.log }, { channel: "test:echo", text: "x" })).rejects.toBe(boom);
    expect(spy.entries).toHaveLength(1);
    expect(spy.entries[0].message).toContain("探测爆炸");
  });

  it("fail：记自定义文案并返回明确错误（config 语义）", async () => {
    const spy = spyLog();
    const handle = makeHandler(
      "code",
      async () => { throw new Error("EACCES"); },
      { kind: "fail", logMessage: (m) => `配置保存失败（新值未生效）：${m}`, toResult: (m) => ({ ok: false, error: { code: "E_INTERNAL", message: `配置保存失败，新值未生效：${m}` } }) },
    );
    const res = await handle({ log: spy.log }, { channel: "test:echo", text: "x" });
    expect(res).toEqual({ ok: false, error: { code: "E_INTERNAL", message: "配置保存失败，新值未生效：EACCES" } });
    expect(spy.entries[0].message).toBe("配置保存失败（新值未生效）：EACCES");
  });
});

describe("信封工厂：业务拒绝不记日志（#53）", () => {
  it("route 正常返回 ok:false（业务拒绝是合法结果）→ 零日志", async () => {
    const spy = spyLog();
    const res = await makeHandler("code", async () => ({ ok: false, error: { code: "E_SESSION_NOT_FOUND", message: "会话不存在：t-404" } }), passthrough)({ log: spy.log }, { channel: "test:echo", text: "x" });
    expect(res.ok).toBe(false);
    expect(spy.entries).toHaveLength(0);
  });
});
