// 用途：Main 入站 IPC 路由单测 —— zod 强制校验（非法消息明确错误码 E_SCHEMA）+ 各通道路由到 Adapter + AdapterError 错误码透传（spec E/#6 验收第 4 条）
import { describe, expect, it } from "vitest";
import { FakeAdapter, VirtualClock, type CliAdapter } from "@kanban/cli-host";
import { handleIpc } from "./ipc";

/** 构造 VirtualClock 驱动的 FakeAdapter + 路由器 */
function makeRouter() {
  const clock = new VirtualClock();
  const adapter = new FakeAdapter({ clock });
  return { clock, adapter, handle: (raw: unknown) => handleIpc(adapter, raw) };
}

describe("Main 入站强制校验", () => {
  it("非法消息被拒并返回 E_SCHEMA + 可读摘要（验收第 4 条）", async () => {
    const { handle } = makeRouter();
    const cases: unknown[] = [
      null,
      "session:send",
      { channel: "session:nuke" },
      { channel: "session:send", sessionId: "s", text: "" },
      { channel: "session:send", sessionId: "", text: "hi" },
      { channel: "session:create", cli: "codex", cwd: "C:\\p" }, // #6 最小集仅 fake
    ];
    for (const raw of cases) {
      const res = await handle(raw);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("E_SCHEMA");
        expect(res.error.message.length).toBeGreaterThan(0);
      }
    }
  });

  it("session:create 路由到 adapter，返回会话元数据", async () => {
    const { handle } = makeRouter();
    const res = await handle({
      channel: "session:create",
      cli: "fake",
      cwd: "C:\\project2\\kanban-desktop",
      title: "演示会话",
      permMode: "auto",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.sessionId).toBeTruthy();
      expect(res.cli).toBe("fake");
      expect(res.title).toBe("演示会话");
    }
  });

  it("session:send / interrupt / resolveApproval 路由成功（ok:true）", async () => {
    const { clock, adapter, handle } = makeRouter();
    const created = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p" });
    const sessionId = created.ok ? created.sessionId! : "";
    expect((await handle({ channel: "session:send", sessionId, text: "默认演示" })).ok).toBe(true);
    clock.runToIdle();
    expect((await handle({ channel: "session:interrupt", sessionId })).ok).toBe(true);

    // 走一次完整审批决定：订阅 adapter 事件拿真实 requestId
    const requested = new Promise<string>((resolve) => {
      const off = adapter.subscribe((e) => {
        if ("type" in e && e.type === "approval_requested") {
          off();
          resolve(e.requestId);
        }
      });
    });
    await handle({ channel: "session:send", sessionId, text: "审批演示" });
    clock.runToIdle();
    const requestId = await requested;
    const resolved = await handle({
      channel: "session:resolveApproval",
      sessionId,
      requestId,
      decision: "deny",
    });
    expect(resolved.ok).toBe(true);
    clock.runToIdle();
  });

  it("AdapterError 错误码透传（过期审批 E_APPROVAL_EXPIRED / 未知会话 E_SESSION_NOT_FOUND）；意外异常兜底 E_INTERNAL", async () => {
    const { handle } = makeRouter();
    const res = await handle({ channel: "session:send", sessionId: "ghost", text: "hi" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_SESSION_NOT_FOUND");
    const res1 = await handle({
      channel: "session:resolveApproval",
      sessionId: "ghost",
      requestId: "ap-x",
      decision: "deny",
    });
    expect(res1.ok).toBe(false);
    if (!res1.ok) expect(res1.error.code).toBe("E_SESSION_NOT_FOUND");

    // 抛非 AdapterError 的 adapter → E_INTERNAL 兜底
    const boom = {
      capabilities: new FakeAdapter({ clock: new VirtualClock() }).capabilities,
      createSession: async () => ({ sessionId: "s-boom" }),
      sendTurn: async () => {
        throw new Error("boom");
      },
      interruptTurn: async () => {},
      resolveApproval: async () => {},
      readHistory: async () => [],
      resume: async () => {},
      dispose: async () => {},
      subscribe: () => () => {},
    };
    const res2 = await handleIpc(boom as unknown as CliAdapter, {
      channel: "session:send",
      sessionId: "s-boom",
      text: "x",
    });
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.error.code).toBe("E_INTERNAL");
  });
});
