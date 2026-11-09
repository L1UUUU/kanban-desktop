// 用途：CodexAdapter 协议映射单测 —— FakeRpc 手动注入通知/服务端请求，断言 C1 事件映射、审批三态、终文自愈、忙态排队、interrupt 幂等、进程退出报错（不依赖真实 codex）
import { tmpdir } from "node:os";
import path from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CodexAdapter, type CodexRpcClientLike } from "./codex-adapter";
import { ExeNotFoundError } from "./adapter";
import type { AdapterEvent, ChatEvent } from "@kanban/ipc-schema";

/** 记录型 Fake app-server：request 响应 + 测试手动 emit 通知/服务端请求/进程退出 */
class FakeRpc implements CodexRpcClientLike {
  dead = false;
  /** 模拟子进程 pid（listChildPids 用；null=未启动） */
  pid: number | null = null;
  readonly calls: Array<{ method: string; params: unknown }> = [];
  private readonly notifHandlers = new Map<string, Set<(p: unknown, m: string) => void>>();
  private readonly serverHandlers = new Map<string, (p: unknown, id: number | string) => unknown>();
  private readonly deadFns = new Set<(err: Error) => void>();
  private threadN = 0;
  /** 测试钩子：thread/start 前置失败（模拟 rpc error） */
  failThreadStart: string | null = null;
  /** 测试钩子：turn/start 前置失败（模拟 rpc error，认证失效归类的提交路径） */
  failTurnStart: string | null = null;
  /** 测试钩子：按 method 预置响应（thread/read、thread/resume 等，adoptSession 恢复链路） */
  readonly responses: Record<string, unknown> = {};
  /** 测试钩子：thread/read includeTurns 抛错（模拟未 materialized，t0-01 发现 5） */
  failReadIncludeTurns = false;

  start(): void {
    /* 测试不 spawn */
  }
  stop(): void {
    this.simulateExit(null); // kill → 进程退出链（同步触发 onDead，与真实进程 kill 等价）
  }
  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "initialize") return {};
    if (method === "thread/read" && this.failReadIncludeTurns && (params as { includeTurns?: boolean } | undefined)?.includeTurns) {
      throw new Error("thread is not materialized yet");
    }
    if (this.responses[method] !== undefined) return this.responses[method];
    if (method === "thread/start") {
      if (this.failThreadStart) throw new Error(`rpc -32602: ${this.failThreadStart}`);
      this.threadN += 1;
      return { thread: { id: `th-${this.threadN}` }, model: (params as { model?: string })?.model ?? "m0" };
    }
    if (method === "turn/start" && this.failTurnStart) throw new Error(this.failTurnStart);
    return {}; // turn/start、turn/interrupt 等提交即回
  }
  onServerRequest(method: string, handler: (p: unknown, id: number | string) => unknown): void {
    this.serverHandlers.set(method, handler);
  }
  on(method: string, fn: (p: unknown, m: string) => void): () => void {
    if (!this.notifHandlers.has(method)) this.notifHandlers.set(method, new Set());
    this.notifHandlers.get(method)!.add(fn);
    return () => {
      this.notifHandlers.get(method)?.delete(fn);
    };
  }
  onDead(fn: (err: Error) => void): () => void {
    this.deadFns.add(fn);
    return () => {
      this.deadFns.delete(fn);
    };
  }

  /* ---- 测试驱动 API ---- */
  emit(method: string, params: unknown): void {
    for (const fn of this.notifHandlers.get(method) ?? []) fn(params, method);
  }
  /** 服务端审批请求：resolve 值即回给服务端的 wire decision */
  async serverRequest(method: string, params: unknown): Promise<{ decision?: string }> {
    const handler = this.serverHandlers.get(method);
    if (!handler) throw new Error(`未注册：${method}`);
    return (await handler(params, 9901)) as { decision?: string };
  }
  /** 模拟进程死亡（触发 adapter 的 onDead → session_exit 链） */
  simulateExit(code: number | null): void {
    if (this.dead) return;
    this.dead = true;
    for (const fn of this.deadFns) fn(new Error(`codex app-server 已退出：code=${code}`));
  }
  callsOf(method: string): unknown[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }
}

/** 构造被测 adapter + 挂接事件收集（进程死后 factory 换新 FakeRpc，可断言重启次数） */
function makeAdapter() {
  const rpcs: FakeRpc[] = [new FakeRpc()];
  let current = rpcs[0];
  const adapter = new CodexAdapter({
    clientFactory: () => {
      if (current.dead) {
        current = new FakeRpc();
        rpcs.push(current);
      }
      return current;
    },
    resolveModel: async (requested) => requested ?? "gpt-probe-ok",
  });
  const events: AdapterEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const chat = (sid: string) => events.filter((e): e is ChatEvent => "type" in e && e.sessionId === sid);
  return { rpc: rpcs[0], rpcs, adapter, events, chat };
}

const CWD = "C:\\demo";

describe("CodexAdapter：createSession 与权限映射", () => {
  it("createSession 调 thread/start（cwd/model/权限参数），返回原生 thread id", async () => {
    const { rpc, adapter } = makeAdapter();
    const { sessionId, nativeSessionId } = await adapter.createSession({ cwd: CWD, model: "gpt-x", permMode: "ask" });
    expect(nativeSessionId).toBe("th-1");
    expect(sessionId.length).toBeGreaterThan(0);
    const start = rpc.callsOf("thread/start")[0] as Record<string, unknown>;
    expect(start.cwd).toBe(CWD);
    expect(start.model).toBe("gpt-x");
    expect(start.approvalPolicy).toBe("untrusted");
    expect(start.sandbox).toBe("workspace-write");
  });

  it("权限三档映射：auto=on-request+workspace-write；full=never+danger-full-access", async () => {
    const a = makeAdapter();
    await a.adapter.createSession({ cwd: CWD, permMode: "auto" });
    const b = makeAdapter();
    await b.adapter.createSession({ cwd: CWD, permMode: "full" });
    expect(a.rpc.callsOf("thread/start")[0]).toMatchObject({ approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(b.rpc.callsOf("thread/start")[0]).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
  });

  it("thread/start 失败抛 AdapterError（中文可定位）", async () => {
    const { rpc, adapter } = makeAdapter();
    rpc.failThreadStart = "Invalid request: cwd not found";
    await expect(adapter.createSession({ cwd: "C:\\nope" })).rejects.toMatchObject({ code: "E_INTERNAL" });
  });
});

describe("CodexAdapter：turn 与流式映射", () => {
  it("sendTurn → turn/start 参数正确；delta→message_delta；completed→终文自愈补 delta + message_completed", async () => {
    const { rpc, adapter, chat } = makeAdapter();
    const { sessionId } = await adapter.createSession({ cwd: CWD });
    await adapter.sendTurn({ sessionId, text: "你好" });
    const start = rpc.callsOf("turn/start")[0] as { threadId: string; input: Array<{ type: string; text: string }> };
    expect(start.threadId).toBe("th-1");
    expect(start.input[0]).toMatchObject({ type: "text", text: "你好" });
    rpc.emit("turn/started", { threadId: "th-1", turn: { id: "turn-1", status: "inProgress" } });
    // delta 到达 5 字，终文 7 字 → completed 时应补发缺失 2 字（无重复无丢失，与终文逐一相等）
    rpc.emit("item/agentMessage/delta", { threadId: "th-1", turnId: "turn-1", itemId: "m1", delta: "前五个字" });
    rpc.emit("item/completed", { threadId: "th-1", turnId: "turn-1", item: { type: "agentMessage", id: "m1", text: "前五个字加尾巴" } });
    rpc.emit("turn/completed", { threadId: "th-1", turn: { id: "turn-1", status: "completed" } });
    const deltas = chat(sessionId).filter((e): e is Extract<ChatEvent, { type: "message_delta" }> => e.type === "message_delta");
    expect(deltas.map((d) => d.delta).join("")).toBe("前五个字加尾巴");
    expect(deltas.every((d) => d.itemId === "m1" && d.partId === "0")).toBe(true);
    expect(chat(sessionId).some((e) => e.type === "message_completed")).toBe(true);
    expect(chat(sessionId).filter((e) => e.type === "turn_completed").length).toBe(1);
    expect(chat(sessionId).at(-1)).toMatchObject({ type: "session_status", status: "idle" });
  });

  it("commandExecution：started→tool_started；outputDelta→tool_update；completed exitCode!=0 输出带退出码标记", async () => {
    const { rpc, adapter, chat } = makeAdapter();
    const { sessionId } = await adapter.createSession({ cwd: CWD });
    await adapter.sendTurn({ sessionId, text: "跑命令" });
    rpc.emit("turn/started", { threadId: "th-1", turn: { id: "t1", status: "inProgress" } });
    rpc.emit("item/started", { threadId: "th-1", turnId: "t1", item: { type: "commandExecution", id: "cmd1", command: "echo hi", cwd: CWD, status: "inProgress" } });
    rpc.emit("item/commandExecution/outputDelta", { threadId: "th-1", turnId: "t1", itemId: "cmd1", delta: "hi\n" });
    rpc.emit("item/completed", { threadId: "th-1", turnId: "t1", item: { type: "commandExecution", id: "cmd1", command: "echo hi", cwd: CWD, status: "failed", exitCode: 1, aggregatedOutput: "boom", durationMs: 12 } });
    rpc.emit("turn/completed", { threadId: "th-1", turn: { id: "t1", status: "completed" } });
    const started = chat(sessionId).find((e): e is Extract<ChatEvent, { type: "tool_started" }> => e.type === "tool_started");
    expect(started).toMatchObject({ itemId: "cmd1", tool: "commandExecution", argsSummary: "echo hi" });
    expect(chat(sessionId).find((e): e is Extract<ChatEvent, { type: "tool_update" }> => e.type === "tool_update")).toMatchObject({ itemId: "cmd1", outputDelta: "hi\n" });
    const done = chat(sessionId).find((e): e is Extract<ChatEvent, { type: "tool_completed" }> => e.type === "tool_completed");
    expect(done).toMatchObject({ itemId: "cmd1", status: "completed", durationMs: 12 });
    expect(done!.output).toContain("exit 1");
    expect(done!.output).toContain("boom");
  });

  it("忙态排队：turn 进行中 sendTurn 排队，completed 后自动续发", async () => {
    const { rpc, adapter, chat } = makeAdapter();
    const { sessionId } = await adapter.createSession({ cwd: CWD });
    await adapter.sendTurn({ sessionId, text: "一" });
    rpc.emit("turn/started", { threadId: "th-1", turn: { id: "t1", status: "inProgress" } });
    await adapter.sendTurn({ sessionId, text: "二" });
    expect(rpc.callsOf("turn/start").length).toBe(1); // 未立即发第二个
    rpc.emit("turn/completed", { threadId: "th-1", turn: { id: "t1", status: "completed" } });
    // 排队消息自动续发
    await new Promise((r) => setTimeout(r, 10));
    expect(rpc.callsOf("turn/start").length).toBe(2);
    expect((rpc.callsOf("turn/start")[1] as { input: Array<{ text: string }> }).input[0].text).toBe("二");
    // 两个 turn_started，且第二个在第一个 turn_completed 之后（排队续发语义）
    const seqOf = chat(sessionId);
    const firstCompleted = seqOf.find((e) => e.type === "turn_completed")!;
    const starts = seqOf.filter((e) => e.type === "turn_started");
    expect(starts.length).toBe(2);
    expect(starts[1].seq).toBeGreaterThan(firstCompleted.seq);
  });

  it("error 通知 willRetry=false → session_error 一次；failed 终态不重复报错", async () => {
    const { rpc, adapter, chat } = makeAdapter();
    const { sessionId } = await adapter.createSession({ cwd: CWD });
    await adapter.sendTurn({ sessionId, text: "x" });
    rpc.emit("turn/started", { threadId: "th-1", turn: { id: "t1", status: "inProgress" } });
    rpc.emit("error", { threadId: "th-1", turnId: "t1", error: { message: "model_not_found" }, willRetry: false });
    rpc.emit("turn/completed", { threadId: "th-1", turn: { id: "t1", status: "failed", error: { message: "model_not_found" } } });
    expect(chat(sessionId).filter((e) => e.type === "session_error").length).toBe(1);
    expect(chat(sessionId).at(-1)).toMatchObject({ type: "session_status", status: "idle" });
    // willRetry=true 的 error 不报（服务端重试中）
    rpc.emit("error", { threadId: "th-1", turnId: "t1", error: { message: "transient" }, willRetry: true });
    expect(chat(sessionId).filter((e) => e.type === "session_error").length).toBe(1);
  });

  it("session_error 枚举映射（#41）：error 通知认证类文本 → AUTH_EXPIRED；非认证 → INTERNAL", async () => {
    const a = makeAdapter();
    const { sessionId: sidA } = await a.adapter.createSession({ cwd: CWD });
    await a.adapter.sendTurn({ sessionId: sidA, text: "x" });
    a.rpc.emit("turn/started", { threadId: "th-1", turn: { id: "t1", status: "inProgress" } });
    a.rpc.emit("error", { threadId: "th-1", turnId: "t1", error: { message: "Please log in with ChatGPT to continue" }, willRetry: false });
    const errA = a.chat(sidA).find((e): e is Extract<ChatEvent, { type: "session_error" }> => e.type === "session_error");
    expect(errA?.code).toBe("AUTH_EXPIRED");

    const b = makeAdapter();
    const { sessionId: sidB } = await b.adapter.createSession({ cwd: CWD });
    await b.adapter.sendTurn({ sessionId: sidB, text: "x" });
    b.rpc.emit("turn/started", { threadId: "th-1", turn: { id: "t1", status: "inProgress" } });
    b.rpc.emit("error", { threadId: "th-1", turnId: "t1", error: { message: "model_not_found" }, willRetry: false });
    const errB = b.chat(sidB).find((e): e is Extract<ChatEvent, { type: "session_error" }> => e.type === "session_error");
    expect(errB?.code).toBe("INTERNAL");
  });

  it("session_error 枚举映射（#41）：failed 终态 error.message 认证类 → AUTH_EXPIRED", async () => {
    const { rpc, adapter, chat } = makeAdapter();
    const { sessionId } = await adapter.createSession({ cwd: CWD });
    await adapter.sendTurn({ sessionId, text: "x" });
    rpc.emit("turn/started", { threadId: "th-1", turn: { id: "t1", status: "inProgress" } });
    rpc.emit("turn/completed", { threadId: "th-1", turn: { id: "t1", status: "failed", error: { message: "401 Unauthorized: ChatGPT login expired" } } });
    const err = chat(sessionId).find((e): e is Extract<ChatEvent, { type: "session_error" }> => e.type === "session_error");
    expect(err?.code).toBe("AUTH_EXPIRED");
  });

  it("session_error 枚举映射（#41）：turn/start 提交失败 rpc 401 → AUTH_EXPIRED；普通失败 → INTERNAL", async () => {
    const a = makeAdapter();
    const { sessionId: sidA } = await a.adapter.createSession({ cwd: CWD });
    a.rpc.failTurnStart = "rpc 401: Not logged in. Please log in with ChatGPT.";
    await a.adapter.sendTurn({ sessionId: sidA, text: "x" }).catch(() => {});
    const errA = a.chat(sidA).find((e): e is Extract<ChatEvent, { type: "session_error" }> => e.type === "session_error");
    expect(errA?.code).toBe("AUTH_EXPIRED");

    const b = makeAdapter();
    const { sessionId: sidB } = await b.adapter.createSession({ cwd: CWD });
    b.rpc.failTurnStart = "rpc -32602: invalid turn input";
    await b.adapter.sendTurn({ sessionId: sidB, text: "x" }).catch(() => {});
    const errB = b.chat(sidB).find((e): e is Extract<ChatEvent, { type: "session_error" }> => e.type === "session_error");
    expect(errB?.code).toBe("INTERNAL");
  });

  it("readHistory 返回本进程事件日志（快照=已发事件，同键同 seq）", async () => {
    const { rpc, adapter } = makeAdapter();
    const { sessionId } = await adapter.createSession({ cwd: CWD });
    await adapter.sendTurn({ sessionId, text: "x" });
    rpc.emit("turn/started", { threadId: "th-1", turn: { id: "t1", status: "inProgress" } });
    const history = await adapter.readHistory(sessionId);
    expect(history.some((e) => e.type === "turn_started")).toBe(true);
    const seqs = history.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
  });
});

describe("CodexAdapter：审批映射", () => {
  /** 建 ask 会话并推进到工具运行中 */
  async function setupApprovalSession() {
    const ctx = makeAdapter();
    const { sessionId } = await ctx.adapter.createSession({ cwd: CWD, permMode: "ask" });
    await ctx.adapter.sendTurn({ sessionId, text: "写文件" });
    ctx.rpc.emit("turn/started", { threadId: "th-1", turn: { id: "t1", status: "inProgress" } });
    ctx.rpc.emit("item/started", { threadId: "th-1", turnId: "t1", item: { type: "commandExecution", id: "cmd1", command: "echo x > out.txt", cwd: CWD, status: "inProgress" } });
    return { ...ctx, sessionId };
  }

  it("requestApproval → approval_requested（含 suggestions）+ waiting；deny → wire declined + 工具 denied", async () => {
    const { rpc, adapter, chat, sessionId } = await setupApprovalSession();
    const respondPromise = rpc.serverRequest("item/commandExecution/requestApproval", {
      threadId: "th-1",
      turnId: "t1",
      itemId: "cmd1",
      command: "echo x > out.txt",
      cwd: CWD,
      reason: null,
      proposedExecpolicyAmendment: ["Bash(echo *)"],
    });
    const req = chat(sessionId).find((e): e is Extract<ChatEvent, { type: "approval_requested" }> => e.type === "approval_requested");
    expect(req).toBeDefined();
    expect(req!.command).toContain("out.txt");
    expect(req!.itemId).toBe("cmd1");
    expect(req!.suggestions.length).toBe(1);
    expect(chat(sessionId).some((e) => e.type === "session_status" && e.status === "waiting")).toBe(true);
    await adapter.resolveApproval({ sessionId, requestId: req!.requestId, decision: "deny" });
    await expect(respondPromise).resolves.toEqual({ decision: "declined" });
    rpc.emit("item/completed", { threadId: "th-1", turnId: "t1", item: { type: "commandExecution", id: "cmd1", command: "echo x > out.txt", status: "declined", exitCode: null, aggregatedOutput: null, durationMs: 3 } });
    expect(chat(sessionId).find((e): e is Extract<ChatEvent, { type: "tool_completed" }> => e.type === "tool_completed")).toMatchObject({ itemId: "cmd1", status: "denied" });
    // deny 后状态回 running（不再 waiting），turn 可继续到终态
    const lastStatus = chat(sessionId).filter((e): e is Extract<ChatEvent, { type: "session_status" }> => e.type === "session_status").at(-1)!;
    expect(lastStatus.status).not.toBe("waiting");
  });

  it("allow-once → wire accept", async () => {
    const { rpc, adapter, chat, sessionId } = await setupApprovalSession();
    const p = rpc.serverRequest("item/commandExecution/requestApproval", { threadId: "th-1", turnId: "t1", itemId: "cmd1", command: "c" });
    const req = chat(sessionId).find((e): e is Extract<ChatEvent, { type: "approval_requested" }> => e.type === "approval_requested")!;
    await adapter.resolveApproval({ sessionId, requestId: req.requestId, decision: "allow-once" });
    await expect(p).resolves.toEqual({ decision: "accept" });
  });

  it("allow-always → wire acceptForSession", async () => {
    const { rpc, adapter, chat, sessionId } = await setupApprovalSession();
    const p = rpc.serverRequest("item/commandExecution/requestApproval", { threadId: "th-1", turnId: "t1", itemId: "cmd1", command: "c" });
    const req = chat(sessionId).find((e): e is Extract<ChatEvent, { type: "approval_requested" }> => e.type === "approval_requested")!;
    await adapter.resolveApproval({ sessionId, requestId: req.requestId, decision: "allow-always" });
    await expect(p).resolves.toEqual({ decision: "acceptForSession" });
  });

  it("serverRequest/resolved（服务端终决）→ approval_expired + 工具 denied；此后 resolveApproval → E_APPROVAL_EXPIRED", async () => {
    const { rpc, adapter, chat, sessionId } = await setupApprovalSession();
    const respondPromise = rpc.serverRequest("item/commandExecution/requestApproval", { threadId: "th-1", turnId: "t1", itemId: "cmd1", command: "c" });
    const req = chat(sessionId).find((e): e is Extract<ChatEvent, { type: "approval_requested" }> => e.type === "approval_requested")!;
    rpc.emit("serverRequest/resolved", { threadId: "th-1", requestId: 9901 });
    expect(chat(sessionId).find((e): e is Extract<ChatEvent, { type: "approval_expired" }> => e.type === "approval_expired")).toMatchObject({ requestId: req.requestId, reason: "server_resolved" });
    expect(chat(sessionId).some((e) => e.type === "tool_completed" && e.itemId === "cmd1" && e.status === "denied")).toBe(true);
    await expect(
      adapter.resolveApproval({ sessionId, requestId: req.requestId, decision: "allow-once" }),
    ).rejects.toMatchObject({ code: "E_APPROVAL_EXPIRED" });
    await expect(respondPromise).resolves.toBeDefined(); // 挂起响应被释放（防泄漏）
  });

  it("已决审批再响应 → E_APPROVAL_EXPIRED；未知会话 → E_SESSION_NOT_FOUND", async () => {
    const { rpc, adapter, chat, sessionId } = await setupApprovalSession();
    const p = rpc.serverRequest("item/commandExecution/requestApproval", { threadId: "th-1", turnId: "t1", itemId: "cmd1", command: "c" });
    const req = chat(sessionId).find((e): e is Extract<ChatEvent, { type: "approval_requested" }> => e.type === "approval_requested")!;
    await adapter.resolveApproval({ sessionId, requestId: req.requestId, decision: "allow-once" });
    await expect(p).resolves.toEqual({ decision: "accept" });
    await expect(
      adapter.resolveApproval({ sessionId, requestId: req.requestId, decision: "deny" }),
    ).rejects.toMatchObject({ code: "E_APPROVAL_EXPIRED" });
    await expect(adapter.sendTurn({ sessionId: "nope", text: "x" })).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
    await expect(adapter.interruptTurn("nope")).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
    await expect(adapter.readHistory("nope")).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
  });

  it("fileChange 审批：command 标注文件修改；grantRoot 进 suggestions", async () => {
    const { rpc, adapter, chat, sessionId } = await setupApprovalSession();
    const p = rpc.serverRequest("item/fileChange/requestApproval", { threadId: "th-1", turnId: "t1", itemId: "cmd1", reason: "需要写入项目外文件", grantRoot: "C:\\outside" });
    const req = chat(sessionId).find((e): e is Extract<ChatEvent, { type: "approval_requested" }> => e.type === "approval_requested")!;
    expect(req.command).toContain("文件");
    expect(req.suggestions.some((s) => s.kind === "grant-root")).toBe(true);
    await adapter.resolveApproval({ sessionId, requestId: req.requestId, decision: "allow-once" });
    await expect(p).resolves.toEqual({ decision: "accept" });
  });
});

describe("CodexAdapter：interrupt 与退出", () => {
  it("interrupt 带 turnId 且幂等；interrupted 终态 → turn_interrupted + 队列清空 + 可继续", async () => {
    const { rpc, adapter, chat } = makeAdapter();
    const { sessionId } = await adapter.createSession({ cwd: CWD });
    await adapter.sendTurn({ sessionId, text: "长任务" });
    rpc.emit("turn/started", { threadId: "th-1", turn: { id: "t1", status: "inProgress" } });
    await adapter.sendTurn({ sessionId, text: "排队的" }); // 忙态排队（应被中断丢弃）
    await adapter.interruptTurn(sessionId);
    await adapter.interruptTurn(sessionId); // 幂等：不重发 turn/interrupt
    expect(rpc.callsOf("turn/interrupt").length).toBe(1);
    expect(rpc.callsOf("turn/interrupt")[0]).toEqual({ threadId: "th-1", turnId: "t1" });
    rpc.emit("turn/completed", { threadId: "th-1", turn: { id: "t1", status: "interrupted" } });
    expect(chat(sessionId).filter((e) => e.type === "turn_interrupted").length).toBe(1);
    expect(chat(sessionId).at(-1)).toMatchObject({ type: "session_status", status: "interrupted" });
    await new Promise((r) => setTimeout(r, 10));
    expect(rpc.callsOf("turn/start").length).toBe(1); // 排队消息被丢弃
    await adapter.sendTurn({ sessionId, text: "继续" }); // 会话可继续
    expect(rpc.callsOf("turn/start").length).toBe(2);
  });

  it("无活动 turn 时 interrupt 为 no-op（幂等）", async () => {
    const { rpc, adapter } = makeAdapter();
    const { sessionId } = await adapter.createSession({ cwd: CWD });
    await adapter.interruptTurn(sessionId);
    await adapter.interruptTurn(sessionId);
    expect(rpc.callsOf("turn/interrupt").length).toBe(0);
  });

  it("进程退出：全部会话 session_exit + disconnected；旧会话报错，新会话自动重启进程", async () => {
    const { rpc, rpcs, adapter, chat } = makeAdapter();
    const { sessionId } = await adapter.createSession({ cwd: CWD });
    rpc.emit("turn/started", { threadId: "th-1", turn: { id: "t1", status: "inProgress" } });
    rpc.simulateExit(1);
    const exits = chat(sessionId).filter((e) => e.type === "session_exit");
    expect(exits.length).toBe(1);
    expect(chat(sessionId).at(-1)).toMatchObject({ type: "session_status", status: "disconnected" });
    await expect(adapter.sendTurn({ sessionId, text: "x" })).rejects.toMatchObject({ code: "E_INTERNAL" });
    // 新会话：自动重启 app-server（新 client 实例），旧会话保持断开
    const before = rpcs.length;
    const fresh = await adapter.createSession({ cwd: CWD });
    expect(rpcs.length).toBe(before + 1);
    expect(fresh.nativeSessionId).toBeDefined();
  });

  it("dispose 全局 → stop 进程；dispose 单会话 → 进程保留其余会话可用", async () => {
    const a = makeAdapter();
    const s1 = await a.adapter.createSession({ cwd: CWD });
    const s2 = await a.adapter.createSession({ cwd: CWD });
    await a.adapter.dispose({ sessionId: s1.sessionId });
    expect(a.rpc.dead).toBe(false); // 进程保留（Session 粒度）
    await expect(a.adapter.sendTurn({ sessionId: s2.sessionId, text: "ok" })).resolves.toBeUndefined();
    await a.adapter.dispose();
    expect(a.rpc.dead).toBe(true);
  });
});

describe("CodexAdapter：adoptSession 与跨进程恢复（#13）", () => {
  const NATIVE = "th-old";
  /** 预置 thread/read 原生历史：completed turn（userMessage+agentMessage+commandExecution）+ interrupted turn */
  function seedNativeHistory(rpc: ReturnType<typeof makeAdapter>["rpc"]): void {
    rpc.responses["thread/read"] = {
      thread: {
        id: NATIVE,
        turns: [
          {
            id: "turn-1",
            status: "completed",
            items: [
              { id: "u1", type: "userMessage", content: [{ type: "text", text: "记住暗号 KBL-CX" }] },
              { id: "a1", type: "agentMessage", text: "收到暗号 KBL-CX" },
              { id: "cmd1", type: "commandExecution", command: "echo hi", status: "completed", exitCode: 0, aggregatedOutput: "hi", durationMs: 12 },
            ],
          },
          { id: "turn-2", status: "interrupted", items: [{ id: "a2", type: "agentMessage", text: "被打断的输出" }] },
        ],
      },
    };
  }

  it("adoptSession：按 native thread id 登记 disconnected（无进程交互）", async () => {
    const { rpc, adapter, chat } = makeAdapter();
    await adapter.adoptSession({ sessionId: "s-adopt", nativeSessionId: NATIVE, cwd: CWD, permMode: "auto" });
    expect(rpc.calls.length).toBe(0); // 不拉进程（登记即达）
    expect(chat("s-adopt").at(-1)).toMatchObject({ type: "session_status", status: "disconnected" });
    // 重复收养明确报错
    await expect(adapter.adoptSession({ sessionId: "s-adopt", nativeSessionId: NATIVE, cwd: CWD })).rejects.toMatchObject({ code: "E_INTERNAL" });
  });

  it("readHistory（收养态）：thread/read includeTurns 回填 —— agentMessage 终文、工具终态、turn 终态（interrupted 在场不重放）、userMessage 不入流", async () => {
    const ctx = makeAdapter();
    seedNativeHistory(ctx.rpc);
    await ctx.adapter.adoptSession({ sessionId: "s-adopt", nativeSessionId: NATIVE, cwd: CWD });
    const history = await ctx.adapter.readHistory("s-adopt");
    expect(ctx.rpc.callsOf("thread/read")[0]).toEqual({ threadId: NATIVE, includeTurns: true });
    const deltas = history.filter((e): e is Extract<ChatEvent, { type: "message_delta" }> => e.type === "message_delta");
    expect(deltas.map((d) => d.delta).join("")).toContain("收到暗号 KBL-CX");
    expect(deltas.map((d) => d.delta).join("")).toContain("被打断的输出");
    // userMessage 不进 ChatEvent（renderer 本地回显口径）
    expect(deltas.length).toBe(2);
    const toolDone = history.find((e): e is Extract<ChatEvent, { type: "tool_completed" }> => e.type === "tool_completed");
    expect(toolDone).toMatchObject({ itemId: "cmd1", status: "completed", durationMs: 12, output: "hi" });
    expect(history.filter((e) => e.type === "turn_completed").length).toBe(1);
    const interrupted = history.find((e) => e.type === "turn_interrupted");
    expect(interrupted).toBeDefined(); // 中断 turn 以 interrupted 终态在场（t0-01 发现 6）
    // seq 严格单调（与实时流同键空间，不变量 4 的回填侧）
    const seqs = history.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    // 二次 readHistory 不重复回填
    const again = await ctx.adapter.readHistory("s-adopt");
    expect(again.length).toBe(history.length);
  });

  it("readHistory（未 materialized）：includeTurns 失败回退无参 read，历史为空不报错", async () => {
    const ctx = makeAdapter();
    ctx.rpc.failReadIncludeTurns = true;
    ctx.rpc.responses["thread/read"] = { thread: { id: NATIVE } };
    await ctx.adapter.adoptSession({ sessionId: "s-adopt", nativeSessionId: NATIVE, cwd: CWD });
    const history = await ctx.adapter.readHistory("s-adopt");
    expect(history.every((e) => e.type === "session_status")).toBe(true); // 仅登记事件，无历史条目
    expect(ctx.rpc.callsOf("thread/read").length).toBe(2); // includeTurns 失败 → 无参重试
  });

  it("resume（收养态）：新进程 thread/resume 同 thread → idle；此后 sendTurn 可继续", async () => {
    const ctx = makeAdapter();
    seedNativeHistory(ctx.rpc);
    ctx.rpc.responses["thread/resume"] = { thread: { id: NATIVE } };
    await ctx.adapter.adoptSession({ sessionId: "s-adopt", nativeSessionId: NATIVE, cwd: CWD });
    await ctx.adapter.resume("s-adopt");
    expect(ctx.rpc.callsOf("thread/resume")[0]).toEqual({ threadId: NATIVE });
    expect(ctx.chat("s-adopt").at(-1)).toMatchObject({ type: "session_status", status: "idle" });
    // 恢复后可继续：sendTurn 不再报「进程已退出」
    await expect(ctx.adapter.sendTurn({ sessionId: "s-adopt", text: "暗号是什么？" })).resolves.toBeUndefined();
    expect(ctx.rpc.callsOf("turn/start").length).toBe(1);
    expect(ctx.chat("s-adopt").some((e) => e.type === "turn_started")).toBe(true);
  });
});

describe("CodexAdapter：readTranscript 双视角（#28）", () => {
  const NATIVE = "th-tr";
  /** 预置 thread/read 原生历史：completed turn（userMessage+agentMessage+commandExecution+fileChange）+ interrupted turn */
  function seedTranscriptHistory(rpc: ReturnType<typeof makeAdapter>["rpc"]): void {
    rpc.responses["thread/read"] = {
      thread: {
        id: NATIVE,
        turns: [
          {
            id: "turn-1",
            status: "completed",
            items: [
              { id: "u1", type: "userMessage", content: [{ type: "text", text: "请实现 X 并跑测试" }] },
              { id: "a1", type: "agentMessage", text: "收到，我先看代码。" },
              { id: "cmd1", type: "commandExecution", command: "pnpm vitest run", status: "completed", exitCode: 0, aggregatedOutput: "ok", durationMs: 12 },
              { id: "fc1", type: "fileChange", status: "completed", changes: [{ path: "src/a.ts" }, { path: "src/b.ts" }], durationMs: 5 },
              { id: "a2", type: "agentMessage", text: "完成。" },
            ],
          },
          { id: "turn-2", status: "interrupted", items: [{ id: "a3", type: "agentMessage", text: "被打断的输出" }] },
        ],
      },
    };
  }

  /** 写 rollout 落盘文件（真实 ~/.codex/sessions 行序形态：event_msg 双视角 + response_item 工具） */
  function writeRollout(file: string): void {
    const lines = [
      { timestamp: "2026-11-05T01:00:00.000Z", type: "session_meta", payload: { session_id: NATIVE, cwd: CWD } },
      { timestamp: "2026-11-05T01:00:01.000Z", type: "turn_context", payload: { turn_id: "t1", cwd: CWD } },
      { timestamp: "2026-11-05T01:00:02.000Z", type: "event_msg", payload: { type: "user_message", message: "请实现 X 并跑测试", images: [], local_images: [] } },
      { timestamp: "2026-11-05T01:00:03.000Z", type: "event_msg", payload: { type: "agent_message", message: "收到，我先看代码。", phase: "commentary", memory_citation: null } },
      {
        timestamp: "2026-11-05T01:00:04.000Z",
        type: "response_item",
        payload: { type: "custom_tool_call", id: "ctc_1", status: "completed", call_id: "call_1", name: "exec", input: "await tools.shell_command({command:'pnpm vitest run'})" },
      },
      { timestamp: "2026-11-05T01:00:05.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_1", output: [] } },
      { timestamp: "2026-11-05T01:00:06.000Z", type: "event_msg", payload: { type: "agent_message", message: "完成。", phase: "final_answer", memory_citation: null } },
      // 噪音行：developer 注入的 user response_item 不入 user 视角（event_msg.user_message 才是用户发言）
      { timestamp: "2026-11-05T01:00:07.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<recommended_plugins>环境注入</recommended_plugins>" }] } },
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  }

  it("主路径 rollout 落盘解析：user/assistant/工具全形态（thread/read 只拿 path，不 resume、不发 turn）", async () => {
    const rolloutFile = path.join(tmpdir(), `kb-cx-rollout-${Date.now()}.jsonl`);
    writeRollout(rolloutFile);
    const ctx = makeAdapter();
    ctx.rpc.responses["thread/read"] = { thread: { id: NATIVE, path: rolloutFile, turns: [] } };
    await ctx.adapter.adoptSession({ sessionId: "s-tr", nativeSessionId: NATIVE, cwd: CWD });
    const transcript = await ctx.adapter.readTranscript("s-tr");
    expect(transcript).toEqual([
      { role: "user", text: "请实现 X 并跑测试" },
      { role: "assistant", text: "收到，我先看代码。" },
      { role: "assistant", text: "", tool: { name: "exec", summary: "await tools.shell_command({command:'pnpm vitest run'})" } },
      { role: "assistant", text: "完成。" },
    ]);
    // 只读保证：仅 thread/read（includeTurns），无 thread/resume、无 turn/start
    expect(ctx.rpc.callsOf("thread/read").length).toBe(1);
    expect((ctx.rpc.callsOf("thread/read")[0] as { includeTurns?: boolean }).includeTurns).toBe(true);
    expect(ctx.rpc.callsOf("thread/resume").length).toBe(0);
    expect(ctx.rpc.callsOf("turn/start").length).toBe(0);
    rmSync(rolloutFile, { force: true });
  });

  it("回退：rollout 不可用（无 path）→ thread/read turns 映射（工具按归档条目，interrupted turn 事件在场）", async () => {
    const ctx = makeAdapter();
    seedTranscriptHistory(ctx.rpc); // thread 无 path
    await ctx.adapter.adoptSession({ sessionId: "s-tr", nativeSessionId: NATIVE, cwd: CWD });
    const transcript = await ctx.adapter.readTranscript("s-tr");
    expect(transcript).toEqual([
      { role: "user", text: "请实现 X 并跑测试" },
      { role: "assistant", text: "收到，我先看代码。" },
      { role: "assistant", text: "", tool: { name: "commandExecution", summary: "pnpm vitest run" } },
      { role: "assistant", text: "", tool: { name: "fileChange", summary: "src/a.ts, src/b.ts" } },
      { role: "assistant", text: "完成。" },
      { role: "assistant", text: "被打断的输出" },
    ]);
    expect(ctx.rpc.callsOf("thread/resume").length).toBe(0);
    expect(ctx.rpc.callsOf("turn/start").length).toBe(0);
  });

  it("本进程会话同样从原生历史拉取（权威源与本地日志无关）", async () => {
    const ctx = makeAdapter();
    ctx.rpc.responses["thread/read"] = {
      thread: { id: "th-1", turns: [{ id: "t1", status: "completed", items: [{ id: "u1", type: "userMessage", content: "只回复：好的" }] }] },
    };
    const { sessionId } = await ctx.adapter.createSession({ cwd: CWD });
    const transcript = await ctx.adapter.readTranscript(sessionId);
    expect(transcript).toEqual([{ role: "user", text: "只回复：好的" }]);
  });

  it("未 materialized：includeTurns 失败回退无参 read，空转剧本不报错", async () => {
    const ctx = makeAdapter();
    ctx.rpc.failReadIncludeTurns = true;
    ctx.rpc.responses["thread/read"] = { thread: { id: NATIVE } };
    await ctx.adapter.adoptSession({ sessionId: "s-tr", nativeSessionId: NATIVE, cwd: CWD });
    const transcript = await ctx.adapter.readTranscript("s-tr");
    expect(transcript).toEqual([]);
    expect(ctx.rpc.callsOf("thread/read").length).toBe(2); // includeTurns 失败 → 无参重试
  });

  it("未知会话 → E_SESSION_NOT_FOUND", async () => {
    const ctx = makeAdapter();
    await expect(ctx.adapter.readTranscript("nope")).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
  });
});

describe("CodexAdapter：listChildPids（#44 C5 演进）", () => {
  it("共享单进程模型：多会话一个 app-server pid，只报一份；未启动为空集", async () => {
    const { rpc, adapter } = makeAdapter();
    expect(await adapter.listChildPids!()).toEqual([]); // 未启动
    rpc.pid = 4242;
    await adapter.createSession({ cwd: CWD });
    await adapter.createSession({ cwd: CWD });
    expect(await adapter.listChildPids!()).toEqual([4242]); // 两会话共享，仍只一份
  });

  it("进程死亡 → 集合清空；重启进程后新会话 pid 重新出现（集合随进程重建）", async () => {
    const { rpc, rpcs, adapter } = makeAdapter();
    rpc.pid = 4242;
    await adapter.createSession({ cwd: CWD });
    rpc.simulateExit(1);
    expect(await adapter.listChildPids!()).toEqual([]); // 死亡不报陈旧 pid
    await adapter.createSession({ cwd: CWD }); // 触发重启进程（factory 换新 FakeRpc）
    rpcs.at(-1)!.pid = 5252;
    expect(await adapter.listChildPids!()).toEqual([5252]);
  });

  it("会话级 dispose 保留共享进程 pid（t0-01 T3：进程供其他 thread 使用）；全量 dispose 清空", async () => {
    const { rpc, adapter } = makeAdapter();
    rpc.pid = 4242;
    const a = await adapter.createSession({ cwd: CWD });
    const b = await adapter.createSession({ cwd: CWD });
    await adapter.dispose({ sessionId: a.sessionId });
    expect(await adapter.listChildPids!()).toEqual([4242]); // 进程仍受本应用管理
    await adapter.dispose({ sessionId: b.sessionId });
    expect(await adapter.listChildPids!()).toEqual([4242]); // 会话清空但进程按设计保留
    await adapter.dispose(); // 全量：受控终止共享进程
    expect(await adapter.listChildPids!()).toEqual([]);
  });
});

describe("CodexAdapter：spawn 失败协议级映射（#46）", () => {
  it("exe 解析失败（ExeNotFoundError）→ createSession 拒绝 E_SPAWN_NOT_FOUND", async () => {
    const adapter = new CodexAdapter({
      clientFactory: () => {
        // 模拟真实 resolveCodexExe 落空时抛出的类型化错误（exe.ts #46 起 throw ExeNotFoundError）
        throw new ExeNotFoundError("未找到 codex 可执行文件（已尝试：npm 全局 vendored）");
      },
    });
    await expect(adapter.createSession({ cwd: "C:\\demo" })).rejects.toMatchObject({
      code: "E_SPAWN_NOT_FOUND",
      message: expect.stringContaining("未找到 codex 可执行文件"),
    });
  });
});
