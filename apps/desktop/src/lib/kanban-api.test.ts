// 用途：createWindowTransport 声明面密封测试（arch D8）—— 逐条驱动 windowBridgeSpec 声明表：DEV 下全部生成通道的校验失败 warn 文案与 throw/不阻断语义一次覆盖（新通道加进声明表即自动纳入，无需逐通道另写用例）
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../preload/index";
import { createWindowTransport, windowBridgeSpec } from "./kanban-api";
import { setLogSinkForTest, type LogSink } from "./logger";

/** 按声明表构造 fake window.api：invoke 通道记录调用，订阅通道捕获 handler 并返回可断言注销函数 */
function makeFakeApi() {
  const calls: Record<string, unknown[]> = {};
  const handlers: Record<string, (event: unknown) => void> = {};
  const offs: Record<string, ReturnType<typeof vi.fn>> = {};
  const api: Record<string, unknown> = {};
  for (const decl of Object.values(windowBridgeSpec.invoke)) {
    calls[decl.channel] = [];
    api[decl.channel] = async (req: unknown) => {
      calls[decl.channel].push(req);
      return { ok: true };
    };
  }
  for (const decl of Object.values(windowBridgeSpec.events)) {
    offs[decl.channel] = vi.fn();
    api[decl.channel] = (handler: (event: unknown) => void) => {
      handlers[decl.channel] = handler;
      return offs[decl.channel];
    };
  }
  return { api: api as unknown as DesktopApi, calls, handlers, offs };
}

/** 捕获 warn（scope 固定 transport）；返回断言用数组与还原函数 */
function captureWarns(): { warns: Array<{ message: string; ctx?: unknown }>; restore: () => void } {
  const warns: Array<{ message: string; ctx?: unknown }> = [];
  const sink: LogSink = (level, scope, message, ctx) => {
    if (level === "warn") {
      expect(scope).toBe("transport");
      warns.push({ message, ctx });
    }
  };
  return { warns, restore: setLogSinkForTest(sink) };
}

afterEach(() => {
  window.api = undefined;
});

describe("createWindowTransport 声明面（arch D8：一张声明表生成全部通道）", () => {
  it("window.api 缺失（如 jsdom 测试）返回 null", () => {
    expect(createWindowTransport()).toBeNull();
  });

  it("全部 invoke 通道：DEV 非法请求 warn `${label}不符合 schema` 后重抛，转发不发生", async () => {
    const fake = makeFakeApi();
    window.api = fake.api;
    const { warns, restore } = captureWarns();
    try {
      const transport = createWindowTransport()!;
      for (const [member, decl] of Object.entries(windowBridgeSpec.invoke)) {
        warns.length = 0;
        const invoke = transport[member as keyof typeof transport] as (req: unknown) => Promise<unknown>;
        await expect(invoke({ bogus: true })).rejects.toThrow();
        expect(warns.map((w) => w.message)).toEqual([`${decl.label}不符合 schema`]);
        expect(typeof (warns[0].ctx as { issues: unknown }).issues).toBe("string");
        expect(fake.calls[decl.channel]).toEqual([]);
      }
    } finally {
      restore();
    }
  });

  it("全部订阅通道：DEV 非法载荷 warn 声明 message（issues 为 JSON 数组串）且不阻断分发，注销原样返回", () => {
    const fake = makeFakeApi();
    window.api = fake.api;
    const { warns, restore } = captureWarns();
    try {
      const transport = createWindowTransport()!;
      for (const [member, decl] of Object.entries(windowBridgeSpec.events)) {
        warns.length = 0;
        const received: unknown[] = [];
        const off = (transport[member as keyof typeof transport] as (h: (e: unknown) => void) => () => void)((e) =>
          received.push(e),
        );
        fake.handlers[decl.channel]({ bogus: true });
        expect(received).toEqual([{ bogus: true }]); // 校验失败仍分发原载荷
        expect(warns.map((w) => w.message)).toEqual([decl.message]);
        const issues = (warns[0].ctx as { issues: string }).issues;
        expect(Array.isArray(JSON.parse(issues))).toBe(true);
        expect(JSON.parse(issues).length).toBeGreaterThan(0);
        off();
        expect(fake.offs[decl.channel]).toHaveBeenCalledOnce();
      }
    } finally {
      restore();
    }
  });
});
