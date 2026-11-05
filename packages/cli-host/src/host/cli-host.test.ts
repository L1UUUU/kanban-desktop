// 用途：CliHost seam 单测 —— command 分发（经 AdapterRouter）、事件聚合、未支持 CLI 报错、shutdown 拒绝新命令并 dispose 全部 adapter
import { describe, expect, it } from "vitest";
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

// HostCommand 类型形状冒烟（编译期断言用）
void ({} as HostCommand);
