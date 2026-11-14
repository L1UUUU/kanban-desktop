// 用途：声明式桥接工厂密封测试（arch D8）—— 生成机制本身：DEV 请求校验（warn 后重抛）、DEV 载荷校验（仅 warn 不阻断分发）、合法载荷直转、非 DEV 零校验直转；用合成声明表驱动，不依赖具体通道
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipcRequestSchema, terminalEventSchema } from "@kanban/ipc-schema";
import type { DesktopApi } from "../../preload/index";
import { bridged } from "./bridge-factory";
import { setLogSinkForTest, type LogSink } from "./logger";

/** 合成声明表：invoke 走 ipc 请求 schema，事件走终端事件 schema（均为判别式联合，非法载荷必失败） */
const spec = {
  invoke: { send: { channel: "invoke", schema: ipcRequestSchema, label: "出站测试请求" } },
  events: { subscribe: { channel: "onTerminalEvent", schema: terminalEventSchema, message: "入站测试事件不符合 schema" } },
} as const;

/** 合成 api：记录 invoke 调用；订阅捕获 handler 并返回可断言的注销函数 */
function makeFakeApi() {
  const calls: unknown[][] = [];
  let handler: ((event: unknown) => void) | null = null;
  const off = vi.fn();
  const api = {
    invoke: async (req: unknown) => {
      calls.push([req]);
      return { ok: true, echoed: req };
    },
    onTerminalEvent: (h: (event: unknown) => void) => {
      handler = h;
      return off;
    },
  };
  return {
    api: api as unknown as DesktopApi,
    calls,
    emit: (event: unknown) => handler?.(event),
    off,
  };
}

/** 捕获 warn 日志（scope 固定 transport）；返回断言用数组与还原函数 */
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
  vi.unstubAllEnvs();
  window.api = undefined;
});

describe("bridged 声明式工厂：出站 invoke 生成", () => {
  /** 生成成员带通道强类型（断言用参数/结果松化，行为不变） */
  const looseInvoke = (f: unknown): ((req: unknown) => Promise<{ ok: boolean; echoed: unknown }>) =>
    f as (req: unknown) => Promise<{ ok: boolean; echoed: unknown }>;

  it("合法请求：原样转发到声明通道并返回其结果，无 warn", async () => {
    const fake = makeFakeApi();
    const { warns, restore } = captureWarns();
    try {
      const face = bridged(fake.api, spec);
      const send = looseInvoke(face.send);
      const req = { channel: "project:list" } as const;
      const res = await send(req);
      expect(res.echoed).toBe(req); // 载荷原样直达 api 通道
      expect(fake.calls).toEqual([[req]]);
      expect(warns).toEqual([]);
    } finally {
      restore();
    }
  });

  it("DEV 非法请求：warn `${label}不符合 schema`（issues 为错误消息）后原样重抛，api 不被调用", async () => {
    const fake = makeFakeApi();
    const { warns, restore } = captureWarns();
    try {
      const face = bridged(fake.api, spec);
      const send = looseInvoke(face.send);
      await expect(send({ bogus: true })).rejects.toThrow();
      expect(warns).toHaveLength(1);
      expect(warns[0].message).toBe("出站测试请求不符合 schema");
      expect(typeof warns[0].ctx).toBe("object");
      const issues = (warns[0].ctx as { issues: unknown }).issues;
      expect(typeof issues).toBe("string");
      expect(issues).not.toBe("");
      expect(fake.calls).toEqual([]); // 校验失败先于转发
    } finally {
      restore();
    }
  });

  it("非 DEV（生产）：非法请求零校验直接转发（零开销直转路径）", async () => {
    vi.stubEnv("DEV", false);
    const fake = makeFakeApi();
    const { warns, restore } = captureWarns();
    try {
      const face = bridged(fake.api, spec);
      const send = looseInvoke(face.send);
      const res = await send({ bogus: true });
      expect(res.echoed).toEqual({ bogus: true });
      expect(fake.calls).toHaveLength(1);
      expect(warns).toEqual([]);
    } finally {
      restore();
    }
  });
});

describe("bridged 声明式工厂：入站订阅生成", () => {
  it("DEV 非法载荷：warn 声明 message（issues 为 JSON 数组串）但不阻断分发，handler 收到原载荷", () => {
    const fake = makeFakeApi();
    const { warns, restore } = captureWarns();
    try {
      const face = bridged(fake.api, spec);
      const received: unknown[] = [];
      face.subscribe((event) => received.push(event));
      fake.emit({ bogus: true });
      expect(received).toEqual([{ bogus: true }]); // 校验失败仍分发
      expect(warns).toHaveLength(1);
      expect(warns[0].message).toBe("入站测试事件不符合 schema");
      const issues = (warns[0].ctx as { issues: string }).issues;
      expect(Array.isArray(JSON.parse(issues))).toBe(true);
      expect(JSON.parse(issues).length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it("合法载荷：无 warn 原样分发；注销函数为 api 返回者", () => {
    const fake = makeFakeApi();
    const { warns, restore } = captureWarns();
    try {
      const face = bridged(fake.api, spec);
      const received: unknown[] = [];
      const off = face.subscribe((event) => received.push(event));
      fake.emit({ terminalId: "t-1", type: "data", data: "hi" });
      expect(received).toEqual([{ terminalId: "t-1", type: "data", data: "hi" }]);
      expect(warns).toEqual([]);
      off();
      expect(fake.off).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });

  it("非 DEV（生产）：非法载荷零校验直接分发", () => {
    vi.stubEnv("DEV", false);
    const fake = makeFakeApi();
    const { warns, restore } = captureWarns();
    try {
      const face = bridged(fake.api, spec);
      const received: unknown[] = [];
      face.subscribe((event) => received.push(event));
      fake.emit({ bogus: true });
      expect(received).toEqual([{ bogus: true }]);
      expect(warns).toEqual([]);
    } finally {
      restore();
    }
  });
});
