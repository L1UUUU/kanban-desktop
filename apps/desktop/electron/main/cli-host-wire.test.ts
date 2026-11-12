// 用途：wire 契约密封 roundtrip 测试（issue #73）—— FakeProc(CliHostClient) ↔ createPortHandler ↔ 真实 CliHost(FakeAdapter 工厂)，按 allKinds 清单逐 kind 验证 {kind,payload} 报文与返回值直传形状；清单完备性由编译期 Equal 断言锁死（CliAdapter 加命令方法未登记即红）——此后新方法只要进接口，本测试自动要求其 wire 形状被登记覆盖
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdapterEvent } from "@kanban/ipc-schema";

// node 测试环境无 Electron 运行时：桩掉 utilityProcess（测试一律经 fork 注入替身，真实 fork 分支不触达）
vi.mock("electron", () => ({
  utilityProcess: {
    fork: (): never => {
      throw new Error("测试必须注入 fork 替身");
    },
  },
}));

import { CliHost, createPortHandler, FakeAdapter, type CliAdapter, type HostCommand, type ParentPortLike } from "@kanban/cli-host";
import { CliHostClient, type UtilityProcessLike } from "./cli-host-client";

/** wire 全 kind 清单（roundtrip 逐 kind 断言的驱动面）；satisfies 拦截非法 kind，Equal 拦截缺漏 */
const allKinds = [
  "createSession",
  "sendTurn",
  "interruptTurn",
  "resolveApproval",
  "readHistory",
  "readTranscript",
  "resume",
  "dispose",
  "adoptSession",
  "listChildPids",
  "runOnce",
  "cancelRunOnce",
  "listModels",
  "setModel",
] as const satisfies readonly HostCommand["kind"][];

/** 编译期双向相等断言（Equal 惯用法）：清单缺 kind → false 不可赋给 true 字面量 → 编译红 */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const allKindsComplete: Equal<(typeof allKinds)[number], HostCommand["kind"]> = true;
void allKindsComplete;

/**
 * 桥接替身 proc：client.postMessage → 投递 worker 侧 port 消息监听器（main→worker 方向）；
 * port.postMessage → 回发 client message 监听器（worker→main 方向）。两条消息通道全内存往返，不触真实 utilityProcess。
 */
class BridgeProc implements UtilityProcessLike {
  readonly posted: unknown[] = [];
  private readonly messageListeners: Array<(msg: unknown) => void> = [];
  private readonly portListeners = new Set<(e: { data: unknown }) => void>();
  readonly pid = 7373;
  postMessage(message: unknown): void {
    this.posted.push(message);
    for (const l of this.portListeners) l({ data: message });
  }
  on(event: "message" | "exit" | "spawn", listener: (...args: never[]) => void): void {
    // 仅注册 message（roundtrip 驱动面）；exit/spawn 本测试不触发（fork 注入形态不绑 Job guard，pid 构造即绪）
    if (event === "message") this.messageListeners.push(listener as unknown as (msg: unknown) => void);
  }
  kill(): void {}
  /** worker→main 方向回发（FakePort.postMessage 的落点） */
  postToMain(msg: unknown): void {
    for (const l of this.messageListeners) l(msg);
  }
  /** 暴露 worker 侧端口视图（createPortHandler 注册目标） */
  asPort(): ParentPortLike {
    return {
      on: (_event, listener) => {
        this.portListeners.add(listener);
      },
      postMessage: (msg) => this.postToMain(msg),
    };
  }
}

/** 组装完整 wire 链：client（main 侧）↔ BridgeProc ↔ createPortHandler(真实 CliHost + FakeAdapter 工厂)（worker 侧）；事件流 {event} 上报同 worker.ts 接线 */
function makeWire() {
  const proc = new BridgeProc();
  const host = new CliHost(() => new FakeAdapter() as CliAdapter);
  const client = new CliHostClient({ workerPath: "unused-with-fake-fork", dataDir: "unused", fork: () => proc });
  host.subscribe((event) => proc.postToMain({ event }));
  createPortHandler(host, proc.asPort());
  return { proc, host, client };
}

/** 取 posted 报文的 cmd 部分（wire 报文断言辅助） */
const cmdOf = (posted: unknown): HostCommand => (posted as { cmd: HostCommand }).cmd;

/** fake CLI（node.exe 直连；KANBAN_CLAUDE_BIN 指向 node.exe 走真实解析链，驱动 runOnce 真实 spawn） */
const FAKE_CLI = join(import.meta.dirname, "../../../../packages/cli-host/tests/fixtures/fake-cli.mjs");
let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "kb-wire-roundtrip-"));
  process.env.KANBAN_CLAUDE_BIN = process.execPath;
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.KANBAN_CLAUDE_BIN;
});

describe("wire 契约 roundtrip（issue #73）", () => {
  it("allKinds 清单完备：无重复且含改名后的 runOnce/cancelRunOnce（编译期 Equal 断言在上，此处运行时兜底）", () => {
    expect(new Set(allKinds).size).toBe(allKinds.length);
    expect(allKinds).toContain("runOnce");
    expect(allKinds).toContain("cancelRunOnce");
  });

  it("createSession：报文 {kind,payload}；返回值直传（nativeSessionId 归一化 null；model 实际采用值回传）；事件经 {event} 同步回流", async () => {
    const { proc, client } = makeWire();
    const events: AdapterEvent[] = [];
    client.subscribe((e) => events.push(e));
    const s = await client.createSession({ cwd: "C:\\wire", cli: "fake", model: "fake-standard" });
    expect(s.sessionId).toMatch(/^s-/);
    expect(s.nativeSessionId).toBeNull();
    expect(s.model).toBe("fake-standard"); // issue #76：实际采用 model 经 wire 回传
    expect(proc.posted[0]).toEqual({ id: 1, cmd: { kind: "createSession", payload: { cwd: "C:\\wire", cli: "fake", model: "fake-standard" } } });
    expect(events.some((e) => "type" in e && e.type === "session_status" && (e as { sessionId: string }).sessionId === s.sessionId)).toBe(true);
  });

  it("sendTurn：payload 即 SendTurnInput", async () => {
    const { proc, client } = makeWire();
    const s = await client.createSession({ cwd: "C:\\wire", cli: "fake" });
    const base = proc.posted.length;
    await client.sendTurn({ sessionId: s.sessionId, text: "排队消息" });
    expect(cmdOf(proc.posted[base])).toEqual({ kind: "sendTurn", payload: { sessionId: s.sessionId, text: "排队消息" } });
  });

  it("interruptTurn：payload 为 sessionId 字符串；错误码经 wire 原样回传", async () => {
    const { proc, client } = makeWire();
    await expect(client.interruptTurn("s-nope")).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
    expect(cmdOf(proc.posted[0])).toEqual({ kind: "interruptTurn", payload: "s-nope" });
  });

  it("resolveApproval：payload 即 ResolveApprovalInput（未知会话按错误码回传）", async () => {
    const { proc, client } = makeWire();
    await expect(client.resolveApproval({ sessionId: "s-x", requestId: "r", decision: "allow-once" })).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
    expect(cmdOf(proc.posted[0])).toEqual({ kind: "resolveApproval", payload: { sessionId: "s-x", requestId: "r", decision: "allow-once" } });
  });

  it("readHistory：返回值直传 ChatEvent[]（未发 turn 仅初始状态事件）", async () => {
    const { proc, client } = makeWire();
    const s = await client.createSession({ cwd: "C:\\wire", cli: "fake" });
    const events = await client.readHistory(s.sessionId);
    expect(Array.isArray(events)).toBe(true);
    expect(events.every((e) => e.type === "session_status")).toBe(true);
    expect(cmdOf(proc.posted.at(-1))).toEqual({ kind: "readHistory", payload: s.sessionId });
  });

  it("readTranscript：返回值直传 TranscriptEvent[]（新会话空剧本）", async () => {
    const { proc, client } = makeWire();
    const s = await client.createSession({ cwd: "C:\\wire", cli: "fake" });
    await expect(client.readTranscript(s.sessionId)).resolves.toEqual([]);
    expect(cmdOf(proc.posted.at(-1))).toEqual({ kind: "readTranscript", payload: s.sessionId });
  });

  it("resume：void 命令返回 undefined", async () => {
    const { proc, client } = makeWire();
    const s = await client.createSession({ cwd: "C:\\wire", cli: "fake" });
    await expect(client.resume(s.sessionId)).resolves.toBeUndefined();
    expect(cmdOf(proc.posted.at(-1))).toEqual({ kind: "resume", payload: s.sessionId });
  });

  it("dispose（会话粒度）：payload 即 DisposeInput；会话终止后命令按 E_SESSION_NOT_FOUND 回传", async () => {
    const { proc, client } = makeWire();
    const s = await client.createSession({ cwd: "C:\\wire", cli: "fake" });
    await expect(client.dispose({ sessionId: s.sessionId })).resolves.toBeUndefined();
    expect(cmdOf(proc.posted.at(-1))).toEqual({ kind: "dispose", payload: { sessionId: s.sessionId } });
    await expect(client.readHistory(s.sessionId)).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
  });

  it("adoptSession：payload 即 AdoptSessionInput（cli 缺省显式补 fake）；收养会话命令可达", async () => {
    const { proc, client } = makeWire();
    await client.adoptSession({ sessionId: "s-adopt", nativeSessionId: "n-1", cwd: "C:\\wire", cli: "codex" });
    expect(cmdOf(proc.posted[0])).toEqual({ kind: "adoptSession", payload: { sessionId: "s-adopt", nativeSessionId: "n-1", cwd: "C:\\wire", cli: "codex" } });
    await expect(client.adoptSession({ sessionId: "s-adopt-2", nativeSessionId: "n", cwd: "C:\\wire" })).resolves.toBeUndefined(); // cli 缺省
    expect((cmdOf(proc.posted.at(-1)) as { payload: { cli?: string } }).payload.cli).toBe("fake");
    await expect(client.readHistory("s-adopt")).resolves.toBeInstanceOf(Array); // 路由登记
  });

  it("listChildPids：零参命令 payload=undefined；返回值直传 pid 数组（Fake 无子进程 → 空集）", async () => {
    const { proc, client } = makeWire();
    await expect(client.listChildPids()).resolves.toEqual([]);
    expect(cmdOf(proc.posted[0])).toEqual({ kind: "listChildPids", payload: undefined });
  });

  it("runOnce：真实 spawn 链路经 wire（env 解析链 → fake-cli 直连），返回值直传 RunOnceResult", { timeout: 20_000 }, async () => {
    const { proc, client } = makeWire();
    const r = await client.runOnce({ runId: "w-1", cli: "claude", args: [FAKE_CLI, "ok", "W1"], cwd: workDir });
    expect(r).toMatchObject({ status: "completed", exitCode: 0 });
    expect(r.stdout).toContain("fake-out:W1");
    expect(cmdOf(proc.posted[0])).toEqual({ kind: "runOnce", payload: { runId: "w-1", cli: "claude", args: [FAKE_CLI, "ok", "W1"], cwd: workDir } });
  });

  it("cancelRunOnce：payload 为 runId 字符串；进行中执行终结 cancelled；未知 runId no-op", { timeout: 20_000 }, async () => {
    const { proc, client } = makeWire();
    const p = client.runOnce({ runId: "w-2", cli: "claude", args: [FAKE_CLI, "sleep", "60000"], cwd: workDir });
    await client.cancelRunOnce("w-2");
    expect(cmdOf(proc.posted.at(-1))).toEqual({ kind: "cancelRunOnce", payload: "w-2" });
    expect(await p).toMatchObject({ status: "cancelled" });
    await expect(client.cancelRunOnce("nope")).resolves.toBeUndefined();
  });

  it("listModels：payload 即 ListModelsInput（cli 缺省显式补 fake）；返回值直传 ModelEntry[]（Fake 两条、首条默认，issue #76）", async () => {
    const { proc, client } = makeWire();
    const models = await client.listModels({ cwd: "C:\\wire" });
    expect(models).toHaveLength(2);
    expect(models[0].isDefault).toBe(true);
    expect(models[1].isDefault).toBe(false);
    expect(cmdOf(proc.posted[0])).toEqual({ kind: "listModels", payload: { cwd: "C:\\wire", cli: "fake" } });
    const withCli = await client.listModels({ cwd: "C:\\wire", cli: "fake" });
    expect(cmdOf(proc.posted.at(-1))).toEqual({ kind: "listModels", payload: { cwd: "C:\\wire", cli: "fake" } });
    expect(withCli).toHaveLength(2);
  });

  it("setModel：payload 即 SetModelInput；返回值直传生效模型（issue #79）；未知会话错误码经 wire 原样回传", async () => {
    const { proc, client } = makeWire();
    const s = await client.createSession({ cwd: "C:\\wire", cli: "fake", model: "fake-standard" });
    await expect(client.setModel({ sessionId: s.sessionId, model: "fake-lite" })).resolves.toEqual({ model: "fake-lite" });
    expect(cmdOf(proc.posted.at(-1))).toEqual({ kind: "setModel", payload: { sessionId: s.sessionId, model: "fake-lite" } });
    await expect(client.setModel({ sessionId: "s-nope", model: "x" })).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
  });
});
