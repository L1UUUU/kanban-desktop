// 用途：worker 入口 {log} 消息协议密封测试（#54 / spec #52 B 节）—— fake parentPort + 捕获 adapter 工厂 log 注入，验证 log 回调上报目标替换为 parentPort.postMessage({log:{kind,detail}})、消息形状与既有事件/命令往返/停机监听器正交共存
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CliAdapter } from "../adapter";
import type { DesktopAdapterFactoryOptions } from "./desktop-adapters";

// 捕获 worker.ts 传给 createDesktopAdapterFactory 的 options（含 log 注入点）；工厂替身返回最小 adapter（worker 入口测试不驱动真实 CLI）
const h = vi.hoisted(() => ({ factoryOptions: [] as Array<{ log?: (kind: string, detail: string) => void }> }));
vi.mock("./desktop-adapters", () => ({
  createDesktopAdapterFactory: (options: DesktopAdapterFactoryOptions) => {
    h.factoryOptions.push(options);
    return makeStubAdapter;
  },
}));

/** 最小 CliAdapter 替身（构造期能力探测足够；会话命令不被本测试驱动） */
function makeStubAdapter(): CliAdapter {
  return {
    capabilities: { approval: false, interrupt: false, resume: false, readHistory: false, skillSignal: false },
    createSession: async () => ({ sessionId: "stub", nativeSessionId: null }),
    sendTurn: async () => {},
    interruptTurn: async () => {},
    resolveApproval: async () => {},
    readHistory: async () => [],
    readTranscript: async () => [],
    resume: async () => {},
    dispose: async () => {},
    subscribe: () => () => {},
  };
}

/** fake parentPort：记录 postMessage 与 message 监听器注册（worker→main 发送侧 / main→worker 接收侧） */
class FakeParentPort {
  readonly posted: unknown[] = [];
  readonly messageListeners: Array<(e: { data: unknown }) => void> = [];
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  on(event: "message", listener: (e: { data: unknown }) => void): void {
    if (event === "message") this.messageListeners.push(listener);
  }
}

const port = new FakeParentPort();

beforeAll(async () => {
  // worker.ts 顶层有「无 parentPort 即 exit(1)」守卫：先装 fake parentPort 再动态 import
  (process as unknown as { parentPort?: unknown }).parentPort = port;
  try {
    await import("./worker");
  } finally {
    delete (process as unknown as { parentPort?: unknown }).parentPort;
  }
});

describe("worker 入口 {log} 上报（#54 spec #52 B 节）", () => {
  it("adapter log 回调上报目标 = parentPort.postMessage({ log: { kind, detail } })；kind 原样透传（worker 不做映射，ADR-0001）", () => {
    const log = h.factoryOptions[0]?.log;
    expect(typeof log).toBe("function");
    log!("stderr", "boom");
    log!("anything-else", "d");
    expect(port.posted).toEqual([
      { log: { kind: "stderr", detail: "boom" } },
      { log: { kind: "anything-else", detail: "d" } },
    ]);
  });

  it("两个命令/停机消息监听器（main→worker 接收侧）与 {log} 发送侧正交共存：互不挤占、形状互不混淆", () => {
    expect(port.messageListeners.length).toBe(2);
    const before = port.posted.length;
    h.factoryOptions[0]?.log!("parse-error", "x");
    // {log} 发送后监听器仍完整注册，且未新增 {event}/{id} 形状的消息
    expect(port.messageListeners.length).toBe(2);
    expect(port.posted.length).toBe(before + 1);
    expect(port.posted.at(-1)).toEqual({ log: { kind: "parse-error", detail: "x" } });
  });
});
