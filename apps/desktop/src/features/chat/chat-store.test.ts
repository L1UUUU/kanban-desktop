// 用途：chat-store 归并器单测 —— ChatEvent 按合并键归并成会话视图（不变量 3/4 的 renderer 侧效果：无重复无丢失）
import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatEventSeed } from "@kanban/ipc-schema";
import { ChatStore } from "./chat-store";

/** 构造 ChatEvent 字面量（seq 递增），作为独立于实现的输入源 */
function ev(seq: number, e: ChatEventSeed): ChatEvent {
  return { ...e, sessionId: "s-1", seq, at: `2026-11-05T10:00:${String(seq).padStart(2, "0")}Z` } as ChatEvent;
}

function makeStore() {
  const store = new ChatStore();
  store.registerSession({ sessionId: "s-1", cli: "fake", title: "演示会话", permMode: "auto", model: "默认模型" });
  return store;
}

describe("chat-store 恢复会话登记（#7 重启恢复）", () => {
  it("registerRestored：按 DB 行登记，状态强制 disconnected、项目/目录身份带齐", () => {
    const store = new ChatStore();
    store.registerRestored({
      id: "s-old",
      kind: "structured",
      cli: "claude",
      nativeSessionId: "thread-x",
      projectId: "p-1",
      title: "新会话 · Claude",
      cwd: "C:\\repo",
      permMode: "ask",
      status: "running", // 上次退出前的落库状态：恢复后统一显示断开
      lastActiveAt: "2026-11-04T00:00:00.000Z",
      dirIdentity: "worktree",
      worktreeName: "poc7",
    });
    const s = store.getSession("s-old")!;
    expect(s.status).toBe("disconnected");
    expect(s).toMatchObject({ cli: "claude", title: "新会话 · Claude", projectId: "p-1", permMode: "ask" });
    expect(s.dirIdentity).toBe("worktree");
    expect(s.worktreeName).toBe("poc7");
    expect(s.items).toHaveLength(0);
  });

  it("registerSession 携带项目与目录身份（新建会话行徽标数据）", () => {
    const store = new ChatStore();
    store.registerSession({
      sessionId: "s-9",
      cli: "codex",
      title: "新会话 · Codex",
      permMode: "auto",
      model: "默认模型",
      projectId: "p-1",
      cwd: "C:\\repo",
      dirIdentity: "main",
      worktreeName: null,
    });
    expect(store.getSession("s-9")).toMatchObject({ projectId: "p-1", dirIdentity: "main", cwd: "C:\\repo" });
  });
});

describe("chat-store 事件归并", () => {
  it("message_delta 按 (itemId,partId) 追加：流式文本拼接完整、乱序键不串扰", () => {
    const store = makeStore();
    store.applyEvent(ev(1, { type: "message_delta", itemId: "m-1", partId: "0", delta: "你" }));
    store.applyEvent(ev(2, { type: "message_delta", itemId: "m-1", partId: "0", delta: "好" }));
    store.applyEvent(ev(3, { type: "message_delta", itemId: "m-1", partId: "0", delta: "，世界" }));
    const s = store.getSession("s-1")!;
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: "assistant", itemId: "m-1", text: "你好，世界", streaming: true });
  });

  it("同一 turn 多段助手消息：不同 itemId 生成独立条目", () => {
    const store = makeStore();
    store.applyEvent(ev(1, { type: "message_delta", itemId: "m-1", partId: "0", delta: "第一段" }));
    store.applyEvent(ev(2, { type: "message_delta", itemId: "m-2", partId: "0", delta: "第二段" }));
    const s = store.getSession("s-1")!;
    expect(s.items.map((i) => (i.kind === "assistant" ? i.text : i.kind))).toEqual(["第一段", "第二段"]);
  });

  it("turn_completed 清除流式光标（cursor 只在 turn 进行中显示）", () => {
    const store = makeStore();
    store.applyEvent(ev(1, { type: "message_delta", itemId: "m-1", partId: "0", delta: "hi" }));
    store.applyEvent(ev(2, { type: "turn_completed" }));
    expect((store.getSession("s-1")!.items[0] as { streaming: boolean }).streaming).toBe(false);
  });

  it("工具生命周期：started(running) → update(输出追加) → completed(终态+时长+输出追加)", () => {
    const store = makeStore();
    store.applyEvent(ev(1, { type: "tool_started", itemId: "tl-1", tool: "Bash", argsSummary: "pnpm test" }));
    store.applyEvent(ev(2, { type: "tool_update", itemId: "tl-1", outputDelta: " ✓ 1 passed\n" }));
    store.applyEvent(ev(3, { type: "tool_completed", itemId: "tl-1", status: "completed", durationMs: 3600, output: "Tests 13 passed" }));
    const tool = store.getSession("s-1")!.items[0];
    expect(tool).toMatchObject({
      kind: "tool",
      tool: "Bash",
      status: "completed",
      durationMs: 3600,
    });
    expect((tool as { output: string }).output).toBe(" ✓ 1 passed\n\nTests 13 passed");
  });

  it("审批：requested 设置待决（命令+suggestions）；expired/turn 清理；interrupted 置取消标记", () => {
    const store = makeStore();
    store.applyEvent(ev(1, { type: "session_status", status: "running" }));
    store.applyEvent(
      ev(2, {
        type: "approval_requested",
        requestId: "ap-1",
        itemId: "tl-1",
        command: "Edit x.ts",
        suggestions: [{ kind: "addRules", label: "允许规则", detail: "Edit(src/**)" }],
      }),
    );
    expect(store.getSession("s-1")!.pendingApproval).toMatchObject({ requestId: "ap-1", command: "Edit x.ts" });
    store.applyEvent(ev(3, { type: "approval_expired", requestId: "ap-1", reason: "timed_out" }));
    expect(store.getSession("s-1")!.pendingApproval).toBeNull();
    // 新 turn 清残留审批（原型 L230）；中断置取消标记
    store.applyEvent(
      ev(4, {
        type: "approval_requested",
        requestId: "ap-2",
        itemId: "tl-1",
        command: "Edit y.ts",
        suggestions: [],
      }),
    );
    store.applyEvent(ev(5, { type: "turn_interrupted", reason: "user" }));
    const s = store.getSession("s-1")!;
    expect(s.pendingApproval).toBeNull();
    expect(s.lastTurnInterrupted).toBe(true);
    store.applyEvent(ev(6, { type: "turn_started", turnId: "t-2" }));
    expect(store.getSession("s-1")!.lastTurnInterrupted).toBe(false);
  });

  it("session_error 记录错误；下一 turn_started 清除", () => {
    const store = makeStore();
    store.applyEvent(ev(1, { type: "session_error", code: "E_FAKE_CRASH", message: "进程退出" }));
    expect(store.getSession("s-1")!.lastError).toEqual({ code: "E_FAKE_CRASH", message: "进程退出" });
    store.applyEvent(ev(2, { type: "turn_started", turnId: "t-9" }));
    expect(store.getSession("s-1")!.lastError).toBeNull();
  });

  it("用户消息为 renderer 本地回显（ChatEvent 无 user 成员）；未知会话事件自动建占位会话", () => {
    const store = new ChatStore();
    store.registerSession({ sessionId: "s-1", cli: "fake", title: "A", permMode: "auto", model: "默认模型" });
    store.appendUserMessage("s-1", "帮我拆类型");
    expect(store.getSession("s-1")!.items[0]).toMatchObject({ kind: "user", text: "帮我拆类型" });
    store.applyEvent(
      ({ ...ev(1, { type: "session_status", status: "running" }), sessionId: "s-ghost" }) as ChatEvent,
    );
    expect(store.getSession("s-ghost")).toBeDefined();
  });

  it("快照稳定性：无变更时 getSnapshot 引用不变；active 会话切换生效", () => {
    const store = new ChatStore();
    store.registerSession({ sessionId: "s-1", cli: "fake", title: "A", permMode: "auto", model: "默认模型" });
    const snap1 = store.getSnapshot();
    const snap2 = store.getSnapshot();
    expect(snap1).toBe(snap2);
    store.registerSession({ sessionId: "s-2", cli: "fake", title: "B", permMode: "auto", model: "默认模型" });
    expect(store.getSnapshot().activeId).toBe("s-2");
    store.setActive("s-1");
    expect(store.getSnapshot().activeId).toBe("s-1");
    expect(store.getSnapshot()).not.toBe(snap1);
  });
});
