// 用途：CliHost seam 单测 —— command 分发（经 AdapterRouter）、事件聚合、未支持 CLI 报错、shutdown 拒绝新命令并 dispose 全部 adapter；run-once/cancel-run-once 命令路由（#29 C5 演进）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CliHost, type HostCommand } from "./cli-host";
import { FakeAdapter } from "../fake-adapter";
import type { AdapterEvent } from "@kanban/ipc-schema";
import type { CliAdapter } from "../adapter";

function makeHost() {
  const adapters: FakeAdapter[] = [];
  const host = new CliHost((cli) => {
    if (cli === "fake" || cli === "codex") {
      const a = new FakeAdapter();
      adapters.push(a);
      return a as CliAdapter;
    }
    throw new Error(`未支持：${cli}`);
  });
  const events: AdapterEvent[] = [];
  host.subscribe((e) => events.push(e));
  return { host, adapters, events };
}

describe("CliHost seam（C5）", () => {
  it("command createSession 按 cli 分发并返回应用侧 id；未支持 CLI 明确报错", async () => {
    const { host } = makeHost();
    const r = await host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "fake" } });
    expect(r.sessionId).toBeDefined();
    expect(r.nativeSessionId).toBeNull(); // Fake 无原生 id
    const codex = await host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "codex" } });
    expect(codex.sessionId).toBeDefined();
    await expect(host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "claude" } })).rejects.toMatchObject({
      code: "E_INTERNAL",
    });
  });

  it("sendTurn/readHistory 按 sessionId 路由到正确 adapter；事件聚合订阅", async () => {
    const { host, events } = makeHost();
    const s1 = await host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "fake" } });
    const s2 = await host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "codex" } });
    await host.command({ kind: "sendTurn", sessionId: s1.sessionId!, text: "排队消息" });
    await new Promise((r) => setTimeout(r, 1500));
    // 两会话事件都聚合到同一订阅
    const ids = new Set(events.filter((e) => "type" in e).map((e) => (e as { sessionId: string }).sessionId));
    expect(ids.has(s1.sessionId!)).toBe(true);
    const history = await host.command({ kind: "readHistory", sessionId: s1.sessionId! });
    expect(history.events!.length).toBeGreaterThan(0);
    // 第二会话（未发过 turn）：仅 createSession 的初始状态事件
    const h2 = await host.command({ kind: "readHistory", sessionId: s2.sessionId! });
    expect(h2.events!.every((e) => e.type === "session_status")).toBe(true);
  });

  it("未知会话命令报 E_SESSION_NOT_FOUND", async () => {
    const { host } = makeHost();
    await expect(host.command({ kind: "sendTurn", sessionId: "nope", text: "x" })).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
  });

  it("adoptSession（#13 恢复编排）：按 cli 分发收养并登记路由，后续命令按 sessionId 可达", async () => {
    const { host, events } = makeHost();
    await host.command({
      kind: "adoptSession",
      sessionId: "s-restored",
      nativeSessionId: "native-1",
      cwd: "C:\\demo",
      cli: "codex",
      permMode: "auto",
    });
    // 收养事件（session_status disconnected）聚合到订阅
    expect(events.some((e) => "type" in e && e.type === "session_status" && (e as { sessionId: string }).sessionId === "s-restored")).toBe(true);
    // 路由登记：收养会话的 readHistory/resume/interruptTurn 可达（Fake 实现语义）
    const history = await host.command({ kind: "readHistory", sessionId: "s-restored" });
    expect(history.events).toBeDefined();
    await host.command({ kind: "resume", sessionId: "s-restored" });
    await host.command({ kind: "interruptTurn", sessionId: "s-restored" });
    await expect(
      host.command({ kind: "adoptSession", sessionId: "s-dup", nativeSessionId: "n", cwd: "C:\\demo", cli: "claude" }),
    ).rejects.toMatchObject({ code: "E_INTERNAL" }); // 未支持 CLI
  });

  it("dispose 单会话命令：只终止该会话，其余会话与命令通道可用", async () => {
    const { host } = makeHost();
    const s1 = await host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "fake" } });
    const s2 = await host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "fake" } });
    await host.command({ kind: "dispose", sessionId: s1.sessionId! });
    await expect(host.command({ kind: "readHistory", sessionId: s1.sessionId! })).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
    await host.command({ kind: "sendTurn", sessionId: s2.sessionId!, text: "还在" }); // 其余会话不受影响
  });

  it("shutdown：拒绝新命令并 dispose 全部 adapter", async () => {
    const { host, adapters } = makeHost();
    await host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "fake" } });
    await host.shutdown({ reason: "test" });
    await expect(host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "fake" } })).rejects.toMatchObject({ code: "E_INTERNAL" });
    // dispose 后原会话不可用
    await expect(host.command({ kind: "readHistory", sessionId: "any" })).rejects.toMatchObject({ code: "E_INTERNAL" });
    expect(adapters.length).toBeGreaterThan(0);
  });
});

describe("CliHost run-once 命令（C5 演进，#29）", () => {
  /** fake CLI（node.exe 直连；KANBAN_CLAUDE_BIN 指向 node.exe 走真实解析链） */
  const FAKE_CLI = path.join(import.meta.dirname, "../../tests/fixtures/fake-cli.mjs");
  let cwd: string;

  beforeAll(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "kb-host-runonce-"));
    process.env.KANBAN_CLAUDE_BIN = process.execPath;
  });

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
    delete process.env.KANBAN_CLAUDE_BIN;
  });

  it("run-once 命令：worker 协议内路由执行，结果经 runOnce 字段回传", { timeout: 20_000 }, async () => {
    const { host } = makeHost();
    const r = await host.command({ kind: "run-once", runId: "h-1", cli: "claude", args: [FAKE_CLI, "ok", "H1"], cwd });
    expect(r.runOnce).toMatchObject({ status: "completed", exitCode: 0 });
    expect(r.runOnce!.stdout).toContain("fake-out:H1");
  });

  it("cancel-run-once 命令：终结进行中执行（cancelled）；未知 runId no-op 不报错", { timeout: 20_000 }, async () => {
    const { host } = makeHost();
    const p = host.command({ kind: "run-once", runId: "h-2", cli: "claude", args: [FAKE_CLI, "sleep", "60000"], cwd });
    await host.command({ kind: "cancel-run-once", runId: "h-2" });
    expect((await p).runOnce).toMatchObject({ status: "cancelled" });
    await expect(host.command({ kind: "cancel-run-once", runId: "nope" })).resolves.toBeDefined();
  });

  it("shutdown：终止进行中的 run-once（cancelled 收口）并拒绝新命令", { timeout: 20_000 }, async () => {
    const { host } = makeHost();
    const p = host.command({ kind: "run-once", runId: "h-3", cli: "claude", args: [FAKE_CLI, "sleep", "60000"], cwd });
    await host.shutdown({ reason: "test" });
    expect((await p).runOnce).toMatchObject({ status: "cancelled" });
    await expect(host.command({ kind: "run-once", runId: "h-4", cli: "claude", args: [FAKE_CLI, "ok"], cwd })).rejects.toMatchObject({ code: "E_INTERNAL" });
  });
});

// HostCommand 类型形状冒烟（编译期断言用）
void ({} as HostCommand);
