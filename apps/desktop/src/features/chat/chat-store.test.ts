// 用途：chat-store 归并器单测 —— ChatEvent 按合并键归并成会话视图（不变量 3/4 的 renderer 侧效果：无重复无丢失）；
// arch C8 起另测草稿单属主（判别联合互斥、setActive/discardAllDrafts 两类齐丢、PTY 迟到登记单点）
import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatEventSeed, IpcRequest, IpcResult } from "@kanban/ipc-schema";
import { ChatStore, type ChatStoreDeps } from "./chat-store";
import type { StructuredSessionView } from "./session-view";

/** 最小构造依赖（本套事件归并/结构化草稿用例不驱动 PTY 草稿 IPC 链路） */
const MIN_DEPS: ChatStoreDeps = {
  invoke: () => Promise.resolve({ ok: false, error: { code: "E_INTERNAL", message: "stub" } } satisfies IpcResult),
  disposeTerminal: () => undefined,
};

/** 构造 ChatEvent 字面量（seq 递增），作为独立于实现的输入源 */
function ev(seq: number, e: ChatEventSeed): ChatEvent {
  return { ...e, sessionId: "s-1", seq, at: `2026-11-05T10:00:${String(seq).padStart(2, "0")}Z` } as ChatEvent;
}

function makeStore() {
  const store = new ChatStore(MIN_DEPS);
  store.registerSession({ sessionId: "s-1", cli: "fake", title: "演示会话", permMode: "auto" });
  return store;
}

/** 取结构化会话视图（收窄断言：本套事件归并/草稿用例均为结构化会话） */
function structured(store: ChatStore, id: string): StructuredSessionView {
  const s = store.getSession(id);
  if (!s || s.kind !== "structured") throw new Error(`会话 ${id} 非结构化视图`);
  return s;
}

describe("chat-store 恢复会话登记（#7 重启恢复）", () => {
  it("registerRestored：按 DB 行登记，状态强制 disconnected、项目/目录身份带齐", () => {
    const store = new ChatStore(MIN_DEPS);
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
      createdAt: "2026-11-04T00:00:00.000Z",
      archivedAt: null,
      dirIdentity: "worktree",
      worktreeName: "poc7",
    });
    const s = structured(store, "s-old");
    expect(s.status).toBe("disconnected");
    expect(s).toMatchObject({ cli: "claude", title: "新会话 · Claude", projectId: "p-1", permMode: "ask" });
    expect(s.model, "DB 无 model 列：恢复会话模型为空（chip 显示层派生默认名，issue #77）").toBeUndefined();
    expect(s.dirIdentity).toBe("worktree");
    expect(s.worktreeName).toBe("poc7");
    expect(s.items).toHaveLength(0);
  });

  it("registerSession 携带项目与目录身份（新建会话行徽标数据）", () => {
    const store = new ChatStore(MIN_DEPS);
    store.registerSession({
      sessionId: "s-9",
      cli: "codex",
      title: "新会话 · Codex",
      permMode: "auto",
      model: "fake-standard",
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
    const s = structured(store, "s-1");
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: "assistant", itemId: "m-1", text: "你好，世界", streaming: true });
  });

  it("同一 turn 多段助手消息：不同 itemId 生成独立条目", () => {
    const store = makeStore();
    store.applyEvent(ev(1, { type: "message_delta", itemId: "m-1", partId: "0", delta: "第一段" }));
    store.applyEvent(ev(2, { type: "message_delta", itemId: "m-2", partId: "0", delta: "第二段" }));
    const s = structured(store, "s-1");
    expect(s.items.map((i) => (i.kind === "assistant" ? i.text : i.kind))).toEqual(["第一段", "第二段"]);
  });

  it("turn_completed 清除流式光标（cursor 只在 turn 进行中显示）", () => {
    const store = makeStore();
    store.applyEvent(ev(1, { type: "message_delta", itemId: "m-1", partId: "0", delta: "hi" }));
    store.applyEvent(ev(2, { type: "turn_completed" }));
    expect((structured(store, "s-1").items[0] as { streaming: boolean }).streaming).toBe(false);
  });

  it("工具生命周期：started(running) → update(输出追加) → completed(终态+时长+输出追加)", () => {
    const store = makeStore();
    store.applyEvent(ev(1, { type: "tool_started", itemId: "tl-1", tool: "Bash", argsSummary: "pnpm test" }));
    store.applyEvent(ev(2, { type: "tool_update", itemId: "tl-1", outputDelta: " ✓ 1 passed\n" }));
    store.applyEvent(ev(3, { type: "tool_completed", itemId: "tl-1", status: "completed", durationMs: 3600, output: "Tests 13 passed" }));
    const tool = structured(store, "s-1").items[0];
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
    expect(structured(store, "s-1").pendingApproval).toMatchObject({ requestId: "ap-1", command: "Edit x.ts" });
    store.applyEvent(ev(3, { type: "approval_expired", requestId: "ap-1", reason: "timed_out" }));
    expect(structured(store, "s-1").pendingApproval).toBeNull();
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
    const s = structured(store, "s-1");
    expect(s.pendingApproval).toBeNull();
    expect(s.lastTurnInterrupted).toBe(true);
    store.applyEvent(ev(6, { type: "turn_started", turnId: "t-2" }));
    expect(structured(store, "s-1").lastTurnInterrupted).toBe(false);
  });

  it("session_error 记录错误；下一 turn_started 清除", () => {
    const store = makeStore();
    store.applyEvent(ev(1, { type: "session_error", code: "CLI_EXIT", message: "进程退出" }));
    expect(structured(store, "s-1").lastError).toEqual({ code: "CLI_EXIT", message: "进程退出" });
    store.applyEvent(ev(2, { type: "turn_started", turnId: "t-9" }));
    expect(structured(store, "s-1").lastError).toBeNull();
  });

  it("用户消息为 renderer 本地回显（ChatEvent 无 user 成员）；未知会话事件自动建占位会话", () => {
    const store = new ChatStore(MIN_DEPS);
    store.registerSession({ sessionId: "s-1", cli: "fake", title: "A", permMode: "auto" });
    store.appendUserMessage("s-1", "帮我拆类型");
    expect(structured(store, "s-1").items[0]).toMatchObject({ kind: "user", text: "帮我拆类型" });
    store.applyEvent(
      ({ ...ev(1, { type: "session_status", status: "running" }), sessionId: "s-ghost" }) as ChatEvent,
    );
    expect(store.getSession("s-ghost")).toBeDefined();
  });

  it("快照稳定性：无变更时 getSnapshot 引用不变；active 会话切换生效", () => {
    const store = new ChatStore(MIN_DEPS);
    store.registerSession({ sessionId: "s-1", cli: "fake", title: "A", permMode: "auto" });
    const snap1 = store.getSnapshot();
    const snap2 = store.getSnapshot();
    expect(snap1).toBe(snap2);
    store.registerSession({ sessionId: "s-2", cli: "fake", title: "B", permMode: "auto" });
    expect(store.getSnapshot().activeId).toBe("s-2");
    store.setActive("s-1");
    expect(store.getSnapshot().activeId).toBe("s-1");
    expect(store.getSnapshot()).not.toBe(snap1);
  });
});

describe("chat-store 断开会话恢复（#9：readHistory 快照 + 实时增量无缝拼接契约）", () => {
  // 一个完整 Fake turn 的事件日志（两条助手消息 + 工具卡 + 状态流转）
  const fullLog: ChatEvent[] = [
    ev(1, { type: "turn_started", turnId: "t-1" }),
    ev(2, { type: "message_delta", itemId: "m-1", partId: "0", delta: "基线全绿。" }),
    ev(3, { type: "message_completed", itemId: "m-1", partId: "0" }),
    ev(4, { type: "tool_started", itemId: "tl-1", tool: "Bash", argsSummary: "pnpm test" }),
    ev(5, { type: "tool_update", itemId: "tl-1", outputDelta: " ✓ 3 passed\n" }),
    ev(6, { type: "tool_completed", itemId: "tl-1", status: "completed", durationMs: 1200, output: "done" }),
    ev(7, { type: "message_delta", itemId: "m-2", partId: "0", delta: "拆分" }),
    ev(8, { type: "message_delta", itemId: "m-2", partId: "0", delta: "完成。" }),
    ev(9, { type: "message_completed", itemId: "m-2", partId: "0" }),
    ev(10, { type: "turn_completed" }),
    ev(11, { type: "session_status", status: "idle" }),
  ];

  /** 断开会话登记（registerRestored 最小行） */
  function makeRestored(): ChatStore {
    const store = new ChatStore(MIN_DEPS);
    store.registerRestored({
      id: "s-1",
      kind: "structured",
      cli: "fake",
      nativeSessionId: null,
      projectId: null,
      title: "历史会话",
      cwd: null,
      permMode: "auto",
      status: "idle",
      lastActiveAt: null,
      createdAt: "2026-11-04T00:00:00.000Z",
      archivedAt: null,
      dirIdentity: "none",
      worktreeName: null,
    });
    return store;
  }

  it("applySnapshot(前半) + 实时(后半) 拼接 == 全量重放终态（无重复无丢失，#9 契约断言）", () => {
    // 参照：全新会话直接全量重放
    const whole = makeStore();
    for (const e of fullLog) whole.applyEvent(e);

    // 被测：断开会话登记 → 快照重建（前 6 条，截在工具完成后）→ 实时增量续上（后 5 条）
    const restored = makeRestored();
    const k = 6;
    restored.applySnapshot("s-1", fullLog.slice(0, k));
    for (const e of fullLog.slice(k)) restored.applyEvent(e);

    const a = structured(whole, "s-1");
    const b = structured(restored, "s-1");
    expect(b.items).toEqual(a.items); // 条目级终态相等（同一合并键归并，快照/实时无分叉）
    expect(b.items).toHaveLength(3); // m-1 + 工具卡 + m-2（两条 delta 合并为一条）
  });

  it("applySnapshot 跳过状态类事件：断开态不被历史 session_status 冒充（resume 后由实时流驱动）", () => {
    const store = makeRestored();
    store.applySnapshot("s-1", fullLog); // 日志末尾有 session_status(idle)
    expect(structured(store, "s-1").status).toBe("disconnected");
    // resume 成功：实时 session_status(idle) 到达后转正常态
    store.applyEvent(ev(12, { type: "session_status", status: "idle" }));
    expect(structured(store, "s-1").status).toBe("idle");
  });

  it("applySnapshot 跳过 session_error/session_exit（#41 钉住）：历史错误不随快照重建复活", () => {
    const store = makeRestored();
    store.applySnapshot("s-1", [
      ev(1, { type: "turn_started", turnId: "t-1" }),
      ev(2, { type: "session_error", code: "AUTH_EXPIRED", message: "登录态失效" }),
      ev(3, { type: "session_exit", exitCode: 1, reason: "崩溃" }),
      ev(4, { type: "turn_completed" }),
    ]);
    // 快照中的错误/退出事件不冒充当前错误（实时错误经事件流到达；resume 后状态由实时 session_status 驱动）
    expect(structured(store, "s-1").lastError).toBeNull();
    expect(structured(store, "s-1").items).toHaveLength(0); // turn_started/completed 不产条目
  });
});

describe("chat-store 恢复引导三态（#42：banner 状态机 idle/resuming/failed）", () => {
  /** 断开会话登记（恢复引导条的数据源） */
  function makeDisconnected(): ChatStore {
    const store = new ChatStore(MIN_DEPS);
    store.registerRestored({
      id: "s-1",
      kind: "structured",
      cli: "fake",
      nativeSessionId: null,
      projectId: null,
      title: "历史会话",
      cwd: null,
      permMode: "auto",
      status: "idle",
      lastActiveAt: null,
      createdAt: "2026-11-04T00:00:00.000Z",
      archivedAt: null,
      dirIdentity: "none",
      worktreeName: null,
    });
    return store;
  }

  it("登记即待恢复（idle）；markResuming → resuming；markResumeFailed → failed（附 IPC 错误码与消息）", () => {
    const store = makeDisconnected();
    expect(structured(store, "s-1").resumeState).toEqual({ phase: "idle" });
    store.markResuming("s-1");
    expect(structured(store, "s-1").resumeState).toEqual({ phase: "resuming" });
    store.markResumeFailed("s-1", "E_SESSION_NOT_FOUND", "原生历史文件不可读");
    expect(structured(store, "s-1").resumeState).toEqual({
      phase: "failed",
      code: "E_SESSION_NOT_FOUND",
      message: "原生历史文件不可读",
    });
  });

  it("恢复成功收敛：session_status 非 disconnected 实时事件到达 → resumeState 复位 idle（banner 消失依据）", () => {
    const store = makeDisconnected();
    store.markResuming("s-1");
    store.markResumeFailed("s-1", "E_INTERNAL", "x");
    store.markResuming("s-1"); // 失败后重试
    store.applyEvent(ev(1, { type: "session_status", status: "idle" })); // resume 成功的实时回流
    expect(structured(store, "s-1").resumeState).toEqual({ phase: "idle" });
    expect(structured(store, "s-1").status).toBe("idle");
    // 生命周期继续（再断开）：引导条重新从待恢复开始，不残留旧失败态
    store.applyEvent(ev(2, { type: "session_status", status: "disconnected" }));
    expect(structured(store, "s-1").resumeState).toEqual({ phase: "idle" });
  });

  it("未登记会话 markResuming/markResumeFailed 安全无操作", () => {
    const store = new ChatStore(MIN_DEPS);
    expect(() => store.markResuming("s-none")).not.toThrow();
    expect(() => store.markResumeFailed("s-none", "E_INTERNAL", "x")).not.toThrow();
  });
});

describe("chat-store CLI 异常退出终态化（#13/spec H：不崩溃、不自动继续、不宣称运行中）", () => {
  it("session_exit：流式助手停光标、运行中工具置 interrupted、审批清理、明确报错；session_status disconnected 同样终态化", () => {
    const store = makeStore();
    // turn 进行中：助手流式 + 工具运行中 + 待决审批
    store.applyEvent(ev(1, { type: "turn_started", turnId: "t1" }));
    store.applyEvent(ev(2, { type: "message_delta", itemId: "m1", partId: "0", delta: "写到一半" }));
    store.applyEvent(ev(3, { type: "tool_started", itemId: "tl1", tool: "commandExecution", argsSummary: "echo x" }));
    store.applyEvent(ev(4, { type: "approval_requested", requestId: "ap1", itemId: "tl1", command: "echo x", suggestions: [] }));
    // CLI 进程死亡：session_exit + disconnected（三 Adapter 的死亡链顺序）
    store.applyEvent(ev(5, { type: "session_exit", exitCode: 1, reason: "codex app-server 已退出" }));
    store.applyEvent(ev(6, { type: "session_status", status: "disconnected" }));
    const s = structured(store, "s-1");
    expect(s.items.find((i) => i.kind === "assistant")!.streaming).toBe(false); // 不宣称运行中
    expect(s.items.find((i) => i.kind === "tool")).toMatchObject({ status: "interrupted" }); // 中断中的工具不自动继续
    expect(s.pendingApproval).toBeNull();
    expect(s.lastError?.code).toBe("E_SESSION_EXIT");
    expect(s.lastError?.message).toContain("exit 1");
    expect(s.status).toBe("disconnected");
  });

  it("disconnected 无 session_exit（OpenCode server 停等路径）：同样终态化但不伪造错误", () => {
    const store = makeStore();
    store.applyEvent(ev(1, { type: "turn_started", turnId: "t1" }));
    store.applyEvent(ev(2, { type: "tool_started", itemId: "tl1", tool: "commandExecution", argsSummary: "x" }));
    store.applyEvent(ev(3, { type: "session_status", status: "disconnected" }));
    const s = structured(store, "s-1");
    expect(s.items.find((i) => i.kind === "tool")).toMatchObject({ status: "interrupted" });
    expect(s.lastError).toBeNull();
  });
});

describe("chat-store 会话内错误清除（#46）", () => {
  it("clearError：清除会话 lastError（错误卡「知道了」动作数据源）", () => {
    const store = makeStore();
    store.setError("s-1", "E_INTERNAL", "x");
    expect(structured(store, "s-1").lastError).not.toBeNull();
    store.clearError("s-1");
    expect(structured(store, "s-1").lastError).toBeNull();
  });
});

describe("chat-store 草稿生命周期（#59：点「＋」只开草稿不落库；单草稿；失败保留；切走即丢）", () => {
  const META = { cli: "claude" as const, cwd: "C:\\repo", projectId: "p-1" };

  /** 取结构化草稿数据（收窄断言辅助：快照草稿为判别联合，arch C8） */
  function structuredDraft(store: ChatStore) {
    const d = store.getSnapshot().draft;
    if (!d || d.kind !== "structured") throw new Error("结构化草稿不在位");
    return d.data;
  }

  it("openDraft：草稿就位（不进 sessions、不改 activeId；占位名不在状态层构造——显示层 defaultSessionTitle 派生，arch C8）", () => {
    const store = makeStore();
    const before = store.getSnapshot().sessions.length;
    const replaced = store.openDraft(META);
    expect(replaced).toBe(null);
    const d = structuredDraft(store);
    expect(d).toMatchObject({ cli: "claude", cwd: "C:\\repo", projectId: "p-1", title: undefined, input: "", submitError: null });
    // 不落库不进列表：sessions 不变、activeId 保持原会话
    expect(store.getSnapshot().sessions).toHaveLength(before);
    expect(store.getSnapshot().activeId).toBe("s-1");
  });

  it("单草稿：已有草稿再 openDraft = 替换（replacedHint 置位、旧输入与参数丢弃）", () => {
    const store = makeStore();
    store.openDraft(META);
    store.updateDraft({ input: "没发出去的话" });
    const replaced = store.openDraft({ cli: "codex", cwd: "C:\\repo2", projectId: null });
    expect(replaced).toBe("structured");
    const d = structuredDraft(store);
    expect(d).toMatchObject({ cli: "codex", cwd: "C:\\repo2", projectId: null, replacedHint: true, input: "" });
  });

  it("切会话（setActive）自动丢弃草稿；discardDraft 显式丢弃后快照为 null", () => {
    const store = makeStore();
    store.registerSession({ sessionId: "s-2", cli: "fake", title: "另一会话", permMode: "auto" });
    // registerSession 会激活 s-2；先回 s-1 再开草稿
    store.setActive("s-1");
    store.openDraft(META);
    store.updateDraft({ input: "草稿输入" });
    store.setActive("s-2");
    expect(store.getSnapshot().draft).toBeNull();
    // 显式丢弃同效
    store.openDraft(META);
    store.discardDraft();
    expect(store.getSnapshot().draft).toBeNull();
  });

  it("updateDraft：input/permMode/model 可改（提交失败保留输入的数据基础）", () => {
    const store = makeStore();
    store.openDraft(META);
    store.updateDraft({ input: "首条消息草稿", permMode: "ask", model: "gpt-5.6-luna" });
    expect(structuredDraft(store)).toMatchObject({ input: "首条消息草稿", permMode: "ask", model: "gpt-5.6-luna" });
  });

  it("提交失败：setDraftSubmitError 记录错误且草稿与输入保留；clearDraftSubmitError 清除", () => {
    const store = makeStore();
    store.openDraft(META);
    store.updateDraft({ input: "要重试的首条" });
    store.setDraftSubmitError("E_SPAWN_NOT_FOUND", "未找到 claude 可执行文件");
    const d = structuredDraft(store);
    expect(d.submitError).toMatchObject({ code: "E_SPAWN_NOT_FOUND", message: "未找到 claude 可执行文件" });
    expect(d.input).toBe("要重试的首条"); // 失败保留输入
    expect(store.getSnapshot().sessions).toHaveLength(1); // 无空会话行
    store.clearDraftSubmitError();
    expect(structuredDraft(store).submitError).toBeNull();
  });

  it("requirementId 随草稿携带（看板卡片进入草稿：随首条消息落到新会话的数据源）", () => {
    const store = makeStore();
    store.openDraft({ ...META, requirementId: "REQ-001" });
    expect(structuredDraft(store).requirementId).toBe("REQ-001");
  });
});

// ========== arch C8 草稿单属主（判别联合互斥 / 两类齐丢 / PTY 机制内聚与迟到登记） ==========
describe("chat-store 草稿单属主（arch C8：替换/丢弃/迟到登记互斥判定单点）", () => {
  /** PTY 链路可编程依赖：记录 invoke 与 xterm 释放，terminal:create 应答可注入（缺省成功） */
  function makePtyDeps(replies: Array<IpcResult | Promise<IpcResult>> = []) {
    const invokes: IpcRequest[] = [];
    const disposed: string[] = [];
    let seq = 0;
    const deps: ChatStoreDeps = {
      invoke: (req) => {
        invokes.push(req);
        const r = replies[seq++];
        return Promise.resolve(r ?? { ok: true, sessionId: "sid", cli: "pty", title: "终端 · pwsh" });
      },
      disposeTerminal: (terminalId) => disposed.push(terminalId),
    };
    return { deps, invokes, disposed };
  }

  /** 冲刷微任务链（terminal:create 应答落定；ms>0 用于迟到应答） */
  const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));

  /** 取 PTY 草稿快照（收窄断言辅助） */
  function ptyDraft(store: ChatStore) {
    const d = store.getSnapshot().draft;
    if (!d || d.kind !== "pty") throw new Error("PTY 草稿不在位");
    return d.data;
  }

  const PTY_OPTS = { projectId: null, cwd: "C:\\repo" };

  it("structured↔pty 双向替换：被替方丢弃且 replacedHint 置位；PTY 被替换时 xterm 释放", () => {
    const { deps, disposed } = makePtyDeps();
    const store = new ChatStore(deps);
    expect(store.openPtyDraft(PTY_OPTS)).toBe(null); // 首开无替换
    expect(ptyDraft(store).replacedHint).toBe(false);
    expect(store.openDraft({ cli: "claude", cwd: "C:\\repo" })).toBe("pty"); // PTY → 结构化
    const d = store.getSnapshot().draft;
    expect(d?.kind).toBe("structured");
    if (d?.kind !== "structured") throw new Error("结构化草稿不在位");
    expect(d.data.replacedHint).toBe(true);
    expect(disposed).toHaveLength(1); // PTY 草稿的 xterm 释放
    expect(store.openPtyDraft(PTY_OPTS)).toBe("structured"); // 结构化 → PTY（#65 反向替换）
    expect(ptyDraft(store).replacedHint).toBe(true);
  });

  it("pty→pty 同类替换：新终端 id 且旧 xterm 释放，replacedHint=true", () => {
    const { deps, disposed } = makePtyDeps();
    const store = new ChatStore(deps);
    store.openPtyDraft(PTY_OPTS);
    const first = ptyDraft(store).terminalId;
    expect(store.openPtyDraft({ projectId: null, cwd: "C:\\new" })).toBe("pty");
    const second = ptyDraft(store);
    expect(second.terminalId).not.toBe(first);
    expect(second.cwd).toBe("C:\\new");
    expect(second.replacedHint).toBe(true);
    expect(disposed).toEqual([first]);
  });

  it("setActive 切会话 = 离开草稿：两类齐丢（PTY 含 xterm 释放）并激活目标", () => {
    const { deps, disposed } = makePtyDeps();
    const store = new ChatStore(deps);
    store.registerSession({ sessionId: "s-a", cli: "claude", title: "A", permMode: "auto" });
    store.openPtyDraft(PTY_OPTS);
    const id = ptyDraft(store).terminalId;
    store.setActive("s-a");
    expect(store.getSnapshot().draft).toBeNull();
    expect(store.getSnapshot().activeId).toBe("s-a");
    expect(disposed).toEqual([id]);
    store.openDraft({ cli: "claude", cwd: "C:\\repo" });
    store.setActive("s-a"); // 再切：结构化同样被丢
    expect(store.getSnapshot().draft).toBeNull();
  });

  it("discardAllDrafts 两类齐丢（切项目 effect 单调用；PTY 含 xterm 释放）", () => {
    const { deps, disposed } = makePtyDeps();
    const store = new ChatStore(deps);
    store.openDraft({ cli: "claude", cwd: "C:\\repo" });
    store.discardAllDrafts();
    expect(store.getSnapshot().draft).toBeNull();
    store.openPtyDraft(PTY_OPTS);
    const id = ptyDraft(store).terminalId;
    store.discardAllDrafts();
    expect(store.getSnapshot().draft).toBeNull();
    expect(disposed).toEqual([id]);
  });

  it("PTY 首输入经门闸触发创建（不直写通道）；成功后登记会话行并补写在途剩余输入", async () => {
    const { deps, invokes } = makePtyDeps();
    const store = new ChatStore(deps);
    store.openPtyDraft(PTY_OPTS);
    const id = ptyDraft(store).terminalId;
    expect(store.handlePtyDraftInput(id, "a")).toBe(true); // 首输入 → terminal:create
    store.handlePtyDraftInput(id, "b"); // 创建在途的输入进缓冲
    expect(store.handlePtyDraftInput("ghost", "x")).toBe(false); // 非草稿 id 不拦截（调用方直写通道）
    const create = invokes.find((r) => r.channel === "terminal:create");
    expect(create).toMatchObject({ terminalId: id, firstInput: "a" });
    await flush();
    // 成功：会话行登记（pty 行 + 激活）、草稿清空、剩余输入经 terminal:write 补写
    expect(store.getSession(id)).toMatchObject({ kind: "pty", title: "终端 · pwsh" });
    expect(store.getSnapshot().activeId).toBe(id);
    expect(store.getSnapshot().draft).toBeNull();
    expect(
      invokes.filter((r) => r.channel === "terminal:write").map((r) => (r.channel === "terminal:write" ? r.data : "")),
    ).toEqual(["b"]);
  });

  it("丢弃后迟到的创建成功仍登记会话行（不复活草稿、不干扰后续草稿）", async () => {
    const { deps } = makePtyDeps([
      new Promise<IpcResult>((r) => setTimeout(() => r({ ok: true, sessionId: "sid", cli: "pty", title: "终端 · pwsh" }), 10)),
    ]);
    const store = new ChatStore(deps);
    store.openPtyDraft(PTY_OPTS);
    const id = ptyDraft(store).terminalId;
    store.handlePtyDraftInput(id, "a");
    store.discardAllDrafts(); // 草稿丢弃，创建在途不取消
    store.openDraft({ cli: "claude", cwd: "C:\\repo" }); // 用户已开新草稿
    await flush(20);
    expect(store.getSession(id)).toMatchObject({ kind: "pty" }); // Main 已落库，行仍登记
    expect(store.getSnapshot().draft?.kind).toBe("structured"); // 新草稿不被迟到结果打扰
  });
});

// ========== #58 会话行移除（归档/删除编排的 renderer 侧；spec #57 D 节） ==========
describe("removeSession（#58）", () => {
  function reg(store: ChatStore, id: string): void {
    store.registerSession({ sessionId: id, cli: "fake", title: id, permMode: "auto" });
  }

  it("移除行；激活会话被移除时切到下一条，无则上一条，全无则空态", () => {
    const store = new ChatStore(MIN_DEPS);
    reg(store, "s-1");
    reg(store, "s-2");
    reg(store, "s-3");
    store.setActive("s-1");
    store.removeSession("s-1");
    expect(store.getSnapshot().sessions.map((s) => s.sessionId)).toEqual(["s-2", "s-3"]);
    expect(store.getSnapshot().activeId).toBe("s-2"); // 排序中的下一条

    store.setActive("s-3");
    store.removeSession("s-3");
    expect(store.getSnapshot().activeId).toBe("s-2"); // 无下一条 → 上一条

    store.removeSession("s-2");
    expect(store.getSnapshot().sessions).toEqual([]);
    expect(store.getSnapshot().activeId).toBeNull(); // 全无 → 空态
  });

  it("移除非激活会话不动激活；未知 id no-op", () => {
    const store = new ChatStore(MIN_DEPS);
    reg(store, "s-1");
    reg(store, "s-2");
    store.setActive("s-2");
    store.removeSession("s-1");
    expect(store.getSnapshot().activeId).toBe("s-2");
    store.removeSession("ghost");
    expect(store.getSnapshot().sessions).toHaveLength(1);
  });
});

describe("chat-store updateSession 扩 title（#94 / ADR 0003：派生/重命名标题的本地刷新出口）", () => {
  it("patch 携带 title 即更新会话行标题；未知 id no-op", () => {
    const store = new ChatStore(MIN_DEPS);
    store.registerSession({ sessionId: "s-1", cli: "claude", title: "默认演示", permMode: "auto" });
    store.updateSession("s-1", { title: "我起的名字" });
    expect(store.getSession("s-1")?.title).toBe("我起的名字");
    store.updateSession("ghost", { title: "x" }); // 未知 id：不抛不改
    expect(store.getSnapshot().sessions).toHaveLength(1);
  });
});
