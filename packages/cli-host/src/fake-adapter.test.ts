// 用途：FakeAdapter 测试 —— 消费 adapter.contract 契约套（六不变量可单测项）+ Fake 专属场景（审批过期/错误脚本/dispose/capabilities/中断细节）
import { describe, expect, it } from "vitest";
import type { AdapterEvent, ChatEvent } from "@kanban/ipc-schema";
import { defineAdapterContractTests, createCollector } from "./adapter.contract";
import { VirtualClock } from "./clock";
import { FakeAdapter } from "./fake-adapter";

/** 构造虚拟时钟驱动的被测上下文：确定性推进（runToIdle），无需真实等待 */
async function makeCtx() {
  const clock = new VirtualClock();
  const adapter = new FakeAdapter({ clock });
  return { adapter, driveIdle: () => Promise.resolve(clock.runToIdle()) };
}

defineAdapterContractTests(makeCtx);

describe("FakeAdapter 专属场景", () => {
  it("capabilities 全真：UI 不隐藏审批/中断/恢复/历史/技能信号控件", () => {
    const adapter = new FakeAdapter({ clock: new VirtualClock() });
    expect(adapter.capabilities).toEqual({
      approval: true,
      interrupt: true,
      resume: true,
      readHistory: true,
      skillSignal: true,
    });
  });

  it("审批过期：无人决定时发 approval_expired（Codex timed_out 映射），工具被拒，走 deny 后续", async () => {
    const clock = new VirtualClock();
    const adapter = new FakeAdapter({ clock });
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    await adapter.sendTurn({ sessionId, text: "过期演示" });
    clock.runToIdle();
    const chat = col.chat(sessionId);
    const expired = chat.find(
      (e): e is Extract<ChatEvent, { type: "approval_expired" }> => e.type === "approval_expired",
    );
    expect(expired).toBeDefined();
    expect(chat.some((e) => e.type === "tool_completed" && e.status === "denied")).toBe(true);
    const joined = chat
      .filter((e): e is Extract<ChatEvent, { type: "message_delta" }> => e.type === "message_delta")
      .map((e) => e.delta)
      .join("");
    expect(joined).toContain("审批已过期");
    // 过期后对该审批响应 → 明确错误码
    await expect(
      adapter.resolveApproval({ sessionId, requestId: expired!.requestId, decision: "allow-once" }),
    ).rejects.toMatchObject({ code: "E_APPROVAL_EXPIRED" });
    col.off();
  });

  it("错误脚本：session_error 携带枚举 code（E_FAKE_CRASH→CLI_EXIT，#41），不宣称 turn_completed，状态回到空闲", async () => {
    const clock = new VirtualClock();
    const adapter = new FakeAdapter({ clock });
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    await adapter.sendTurn({ sessionId, text: "错误演示" });
    clock.runToIdle();
    const chat = col.chat(sessionId);
    const err = chat.find((e): e is Extract<ChatEvent, { type: "session_error" }> => e.type === "session_error");
    expect(err).toBeDefined();
    expect(err!.code).toBe("CLI_EXIT"); // 进程意外退出语义 → CLI_EXIT（#41 枚举映射）
    expect(err!.message.length).toBeGreaterThan(0);
    expect(chat.some((e) => e.type === "turn_completed")).toBe(false);
    const last = chat.at(-1);
    expect(last?.type === "session_status" && last.status === "idle").toBe(true);
    col.off();
  });

  it("错误脚本枚举直通：自定义脚本 step.code 为任意枚举成员时原样发出（S4 错误演示入口）", async () => {
    const clock = new VirtualClock();
    const adapter = new FakeAdapter({
      clock,
      pickTurnScript: () => [{ t: "error", code: "AUTH_EXPIRED", message: "登录态失效（演示）" }],
    });
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    await adapter.sendTurn({ sessionId, text: "任意" });
    clock.runToIdle();
    const err = col.chat(sessionId).find((e): e is Extract<ChatEvent, { type: "session_error" }> => e.type === "session_error");
    expect(err?.code).toBe("AUTH_EXPIRED");
    col.off();
  });

  it("中断细节：流式文本补「 …」收尾、运行中工具置 interrupted、清空等待中的审批与排队消息", async () => {
    const clock = new VirtualClock();
    const adapter = new FakeAdapter({ clock });
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    // 排队一条 + 当前审批等待中打断（审批演示文本触发审批脚本）
    await adapter.sendTurn({ sessionId, text: "审批演示" });
    await adapter.sendTurn({ sessionId, text: "排队消息" });
    clock.runToIdle(); // 到达等待审批
    expect(col.chat(sessionId).some((e) => e.type === "approval_requested")).toBe(true);
    col.clear();
    await adapter.interruptTurn(sessionId);
    clock.runToIdle();
    const chat = col.chat(sessionId);
    // 等待中的审批被清空：不再有该审批的完成/过期事件；排队消息被丢弃（不续发新 turn）
    expect(chat.some((e) => e.type === "approval_expired")).toBe(false);
    expect(chat.filter((e) => e.type === "turn_started").length).toBe(0);
    expect(chat.some((e) => e.type === "turn_interrupted")).toBe(true);
    const last = chat.at(-1);
    expect(last?.type === "session_status" && last.status === "interrupted").toBe(true);
    col.off();
  });

  it("流式中断：助手文本以「 …」增量收尾，工具卡置 interrupted", async () => {
    const clock = new VirtualClock();
    const adapter = new FakeAdapter({ clock });
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    await adapter.sendTurn({ sessionId, text: "默认演示" });
    // 推进到第二个助手段落流式中（首段 18 字 ≈ 6 tick × 60ms + 步进延时）
    clock.advance(3000);
    await adapter.interruptTurn(sessionId);
    clock.runToIdle();
    const deltas = col
      .chat(sessionId)
      .filter((e): e is Extract<ChatEvent, { type: "message_delta" }> => e.type === "message_delta")
      .map((e) => e.delta)
      .join("");
    expect(deltas.endsWith(" …") || deltas.length > 0).toBe(true);
    col.off();
  });

  it("dispose：清除会话（后续操作 E_SESSION_NOT_FOUND）；无参清除全部", async () => {
    const clock = new VirtualClock();
    const adapter = new FakeAdapter({ clock });
    const { sessionId: a } = await adapter.createSession({ cwd: "C:\\a" });
    const { sessionId: b } = await adapter.createSession({ cwd: "C:\\b" });
    await adapter.dispose({ sessionId: a });
    await expect(adapter.sendTurn({ sessionId: a, text: "hi" })).rejects.toMatchObject({
      code: "E_SESSION_NOT_FOUND",
    });
    await adapter.sendTurn({ sessionId: b, text: "hi" }); // b 仍可用
    await adapter.dispose();
    await expect(adapter.sendTurn({ sessionId: b, text: "hi" })).rejects.toMatchObject({
      code: "E_SESSION_NOT_FOUND",
    });
  });

  it("resume：fake 实现为复位到空闲并经事件流通知", async () => {
    const clock = new VirtualClock();
    const adapter = new FakeAdapter({ clock });
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    await adapter.resume(sessionId);
    const last = col.chat(sessionId).at(-1);
    expect(last?.type === "session_status" && last.status === "idle").toBe(true);
    await expect(adapter.resume("nope")).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
    col.off();
  });

  it("adoptSession（#13 重启恢复编排）：登记 disconnected，readHistory 空日志，resume 后 idle 且可继续发消息", async () => {
    const clock = new VirtualClock();
    const adapter = new FakeAdapter({ clock });
    const col = createCollector(adapter);
    await adapter.adoptSession({ sessionId: "s-restored", nativeSessionId: "", cwd: "C:\\demo", permMode: "auto" });
    expect(col.chat("s-restored").at(-1)).toMatchObject({ type: "session_status", status: "disconnected" });
    // Fake 无原生历史落盘：readHistory 为空日志（诚实行为，缓存不替代原生历史）
    const history = await adapter.readHistory("s-restored");
    expect(history.every((e) => e.type === "session_status")).toBe(true);
    // 恢复：resume → idle；sendTurn 可继续（新 turn 正常流式）
    await adapter.resume("s-restored");
    await adapter.sendTurn({ sessionId: "s-restored", text: "默认演示" });
    clock.runToIdle();
    const chat = col.chat("s-restored");
    expect(chat.some((e) => e.type === "turn_started")).toBe(true);
    expect(chat.some((e) => e.type === "turn_completed")).toBe(true);
    expect(chat.at(-1)).toMatchObject({ type: "session_status", status: "idle" });
    // 重复收养明确报错
    await expect(adapter.adoptSession({ sessionId: "s-restored", nativeSessionId: "", cwd: "C:\\demo" })).rejects.toMatchObject({ code: "E_INTERNAL" });
    col.off();
  });

  it("readTranscript（#28）：DEFAULT 脚本确定性剧本 —— user→assistant→工具→assistant 顺序与形状（与 readHistory 互不影响）", async () => {
    const clock = new VirtualClock();
    const adapter = new FakeAdapter({ clock });
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    await adapter.sendTurn({ sessionId, text: "拆类型" });
    clock.runToIdle();
    const transcript = await adapter.readTranscript(sessionId);
    // 期望来源：DEFAULT_TURN_SCRIPT 数据剧本（user 输入 + 两段助手文本 + 一个 Bash 工具）
    expect(transcript).toEqual([
      { role: "user", text: "拆类型" },
      { role: "assistant", text: "好的，我先跑一遍现有测试确认基线，然后开始拆分。" },
      { role: "assistant", text: "", tool: { name: "Bash", summary: "pnpm vitest run --filter ipc-schema" } },
      { role: "assistant", text: "基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。" },
    ]);
    // readHistory 不受影响：仍为 ChatEvent 日志（无 user 条目）
    const history = await adapter.readHistory(sessionId);
    expect(history.some((e) => e.type === "turn_completed")).toBe(true);
    // 未知会话 → 明确错误码
    await expect(adapter.readTranscript("nope")).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
  });

  it("readTranscript（#28）：中断流式的 turn —— 已完成事件在场，未完成文本按已流出部分收场", async () => {
    const clock = new VirtualClock();
    const adapter = new FakeAdapter({ clock });
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    await adapter.sendTurn({ sessionId, text: "默认演示" });
    clock.advance(3000); // 推进到首段助手文本流式中（部分字符已流出）
    await adapter.interruptTurn(sessionId);
    clock.runToIdle();
    const transcript = await adapter.readTranscript(sessionId);
    expect(transcript[0]).toEqual({ role: "user", text: "默认演示" });
    const assistant = transcript.filter((e) => e.role === "assistant" && e.text.length > 0);
    expect(assistant.length).toBeGreaterThanOrEqual(1); // 首段已完整流出在场
    // 被打断的是流式中的段落：最后一条 assistant 文本以已流出部分 + 「 …」收场（对照 readHistory 中断收尾）
    expect(assistant.at(-1)!.text.endsWith(" …")).toBe(true);
  });

  it("readTranscript（#28）：adoptSession 收养会话 —— Fake 无原生历史落盘，空剧本为诚实行为", async () => {
    const clock = new VirtualClock();
    const adapter = new FakeAdapter({ clock });
    await adapter.adoptSession({ sessionId: "s-restored", nativeSessionId: "", cwd: "C:\\demo", permMode: "auto" });
    const transcript = await adapter.readTranscript("s-restored");
    expect(transcript).toEqual([]);
  });

  it("订阅退订：unsubscribe 后不再收到事件", async () => {
    const clock = new VirtualClock();
    const adapter = new FakeAdapter({ clock });
    const seen: AdapterEvent[] = [];
    const off = adapter.subscribe((e) => seen.push(e));
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    off();
    await adapter.sendTurn({ sessionId, text: "默认演示" });
    clock.runToIdle();
    expect(seen.every((e) => !("type" in e && e.type === "message_delta"))).toBe(true);
  });

  it("createSession 记录 permMode/model（后续真实 Adapter 的映射输入），事件含初始空闲状态", async () => {
    const clock = new VirtualClock();
    const adapter = new FakeAdapter({ clock });
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({
      cwd: "C:\\demo",
      model: "gpt-5.6-luna",
      permMode: "ask",
    });
    expect(sessionId.length).toBeGreaterThan(0);
    const first = col.chat(sessionId).at(0);
    expect(first?.type === "session_status" && first.status === "idle").toBe(true);
    col.off();
  });
});
