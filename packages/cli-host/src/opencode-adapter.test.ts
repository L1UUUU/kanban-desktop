// 用途：OpenCodeAdapter 协议映射单测 —— FakeHost/FakeServerClient 手动驱动 HTTP/SSE wire（1.15.7 探针形状），断言事件映射、审批轮询三态、abort 归类、/command 路由 self_reported、server-per-project 引用计数、readHistory 拼接、死亡与恢复（不依赖真实 opencode）+ 契约套参数化第四实现
import { describe, expect, it, vi } from "vitest";
import { OpenCodeAdapter, splitModelId } from "./opencode-adapter";
import type { OpenCodeApiResponse, OpenCodeSseEvent, OpenCodeServerClientLike } from "./opencode/client";
import type { OpenCodeServerHostLike } from "./opencode/server-host";
import type { PermMode } from "@kanban/ipc-schema";
import { createCollector, defineAdapterContractTests } from "./adapter.contract";
import type { AdapterEvent, ChatEvent, SkillObservation } from "@kanban/ipc-schema";

vi.setConfig({ testTimeout: 20_000 });

/** 记录型 Fake server 客户端：api 应答脚本化；测试手动 emit SSE 事件 / 模拟死亡 */
class FakeServerClient implements OpenCodeServerClientLike {
  private static seq = 0;
  private sessionSeq = 0;
  readonly port: number;
  readonly pid: number | null;
  dead = false;
  stopped = false;
  readonly apiCalls: Array<{ method: string; path: string; body?: unknown }> = [];
  /** GET /permission 返回的 pending 列表（测试填充） */
  pendingPermissions: Record<string, unknown>[] = [];
  /** GET /command 返回项 */
  commands: Array<{ name: string }> = [];
  /** GET /session/{id}/message 返回（脚本 playback 落账） */
  history: Array<{ info: Record<string, unknown>; parts: Record<string, unknown>[] }> = [];
  /** prompt_async 到达回调（nativeId 取自 path；契约 Fake 挂自动 playback） */
  onPrompt: ((nativeId: string, text: string) => void) | null = null;
  /** 测试替换 api 行为（审批 POST 失败等） */
  apiOverride: ((method: string, path: string, body?: unknown) => OpenCodeApiResponse | null) | null = null;
  private readonly eventFns = new Set<(ev: OpenCodeSseEvent) => void>();
  private readonly deadFns = new Set<(err: Error) => void>();

  constructor() {
    FakeServerClient.seq += 1;
    this.port = 41000 + FakeServerClient.seq;
    this.pid = 90000 + FakeServerClient.seq;
  }

  async api(method: string, path: string, body?: unknown): Promise<OpenCodeApiResponse> {
    const override = this.apiOverride?.(method, path, body);
    if (override) return override;
    this.apiCalls.push({ method, path, body });
    if (method === "POST" && path === "/session") {
      this.sessionSeq += 1;
      return this.ok({ id: `ses_${this.port}_${this.sessionSeq}` });
    }
    if (method === "GET" && path === "/config") return this.ok({ model: "magpie/192-168-4-61-3000/aim_glm-5.3" });
    if (method === "GET" && path === "/command") return this.ok({ items: this.commands });
    if (method === "POST" && path.endsWith("/prompt_async")) {
      this.onPrompt?.(path.split("/")[2] ?? "", String((body as { parts?: Array<{ text?: string }> })?.parts?.[0]?.text ?? ""));
      return this.ok(null, 204);
    }
    if (method === "POST" && path.endsWith("/abort")) return this.ok(null, 204);
    if (method === "GET" && path === "/permission") return this.ok(this.pendingPermissions);
    if (method === "POST" && path.includes("/permissions/")) return this.ok(null, 200);
    if (method === "GET" && /\/session\/.+\/message/.test(path)) return this.ok({ items: this.history });
    if (method === "POST" && path.endsWith("/command")) return this.ok({ info: { id: "msg_cmd" } }, 200);
    return this.ok(null, 404);
  }

  onEvent(fn: (ev: OpenCodeSseEvent) => void): () => void {
    this.eventFns.add(fn);
    return () => {
      this.eventFns.delete(fn);
    };
  }

  onDead(fn: (err: Error) => void): () => void {
    this.deadFns.add(fn);
    return () => {
      this.deadFns.delete(fn);
    };
  }

  stop(): void {
    this.stopped = true;
  }

  /* ---- 测试驱动 API ---- */
  emit(type: string, properties: Record<string, unknown>): void {
    for (const fn of this.eventFns) fn({ type, properties });
  }
  simulateDeath(): void {
    if (this.dead) return;
    this.dead = true;
    for (const fn of this.deadFns) fn(new Error("opencode server 进程已退出：code=1"));
    this.deadFns.clear();
  }

  private ok(json: unknown, status = 200): OpenCodeApiResponse {
    return { status, ok: status >= 200 && status < 300, json, text: JSON.stringify(json ?? "") };
  }
}

/** FakeHost：cwd → FakeServerClient 复用（server-per-project）；引用计数归零记录 stop（不真杀） */
class FakeHost implements OpenCodeServerHostLike {
  private readonly servers = new Map<string, FakeServerClient>();
  private readonly refs = new Map<string, Set<string>>();
  readonly stoppedCwds: string[] = [];
  readonly acquired: Array<{ cwd: string; mode: PermMode | null; ownerKey: string }> = [];

  async acquire(cwd: string, mode: PermMode | null, ownerKey: string): Promise<FakeServerClient> {
    this.acquired.push({ cwd, mode, ownerKey });
    let server = this.servers.get(cwd);
    if (!server || server.dead) {
      // 死亡条目不复用（镜像真实 host 的 onDead 移除 → 重新 spawn）
      server = new FakeServerClient();
      this.servers.set(cwd, server);
    }
    const set = this.refs.get(cwd) ?? new Set<string>();
    set.add(ownerKey);
    this.refs.set(cwd, set);
    return server;
  }

  async release(cwd: string, ownerKey: string): Promise<void> {
    const set = this.refs.get(cwd);
    if (!set) return;
    set.delete(ownerKey);
    if (set.size === 0) {
      this.refs.delete(cwd);
      this.stoppedCwds.push(cwd); // 最后一个会话释放才停 server
      this.servers.get(cwd)?.simulateDeath(); // 模拟停进程（触发 session_exit 链路）
      this.servers.delete(cwd);
    }
  }

  serverOf(cwd: string): FakeServerClient | undefined {
    return this.servers.get(cwd);
  }
  refCount(cwd: string): number {
    return this.refs.get(cwd)?.size ?? 0;
  }
}

/** 构造被测 adapter（注入 FakeHost；轮询间隔缩到 15ms） */
function makeAdapter() {
  const host = new FakeHost();
  const adapter = new OpenCodeAdapter({ host, pollIntervalMs: 15 });
  const events: AdapterEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const chat = (sid: string) => events.filter((e): e is ChatEvent => "type" in e && e.sessionId === sid);
  const skills = (sid?: string) => events.filter((e): e is SkillObservation => !("type" in e) && (!sid || e.sessionId === sid));
  return { adapter, host, events, chat, skills, server: (cwd: string) => host.serverOf(cwd)! };
}

const CWD = "C:\\demo";

/** 工具 part 帧（含审批绑定场景的非终态帧） */
function toolPartFrame(nativeId: string, msgId: string, partId: string, state: Record<string, unknown>): { sessionID: string; part: Record<string, unknown> } {
  return {
    sessionID: nativeId,
    part: { id: partId, messageID: msgId, sessionID: nativeId, type: "tool", tool: "bash", state },
  };
}

describe("OpenCodeAdapter：createSession 与 server-per-project", () => {
  it("createSession → POST /session；同 cwd 二会话共享同一 server 实例；引用计数 2", async () => {
    const ctx = makeAdapter();
    const a = await ctx.adapter.createSession({ cwd: CWD });
    const b = await ctx.adapter.createSession({ cwd: CWD });
    expect(a.nativeSessionId).toBeTruthy();
    expect(b.nativeSessionId).not.toBe(a.nativeSessionId); // 原生 session id 各自唯一
    expect(ctx.host.refCount(CWD)).toBe(2);
    expect(ctx.server(CWD).apiCalls.filter((c) => c.method === "POST" && c.path === "/session").length).toBe(2);
    // 不同 cwd 各自 server
    const c = await ctx.adapter.createSession({ cwd: "C:\\other" });
    expect(ctx.host.serverOf("C:\\other")).not.toBe(ctx.server(CWD));
    void c;
  });

  it("session 级 dispose 引用计数：最后一个会话释放才停 server", async () => {
    const ctx = makeAdapter();
    const a = await ctx.adapter.createSession({ cwd: CWD });
    const b = await ctx.adapter.createSession({ cwd: CWD });
    await ctx.adapter.dispose({ sessionId: a.sessionId });
    expect(ctx.host.refCount(CWD)).toBe(1);
    expect(ctx.host.stoppedCwds).toHaveLength(0);
    await ctx.adapter.dispose({ sessionId: b.sessionId });
    expect(ctx.host.stoppedCwds).toEqual([CWD]); // 最后一个释放才停
  });
});

describe("OpenCodeAdapter：turn 与流式映射（delta+part 双通道）", () => {
  it("delta → message_delta；快照自愈补缺失；idle → turn_completed + message_completed", async () => {
    const ctx = makeAdapter();
    const { sessionId, nativeSessionId: nativeSessionIdRaw } = await ctx.adapter.createSession({ cwd: CWD }); const nativeSessionId = nativeSessionIdRaw!;
    const server = ctx.server(CWD);
    await ctx.adapter.sendTurn({ sessionId, text: "你好" });
    const prompt = server.apiCalls.find((c) => c.path.endsWith("/prompt_async"));
    expect(prompt).toBeDefined();
    // magpie 模型切分：providerID/modelID（第一个斜杠切分，余下合并）
    expect(prompt!.body).toMatchObject({ model: { providerID: "magpie", modelID: "192-168-4-61-3000/aim_glm-5.3" } });
    server.emit("message.part.delta", { sessionID: nativeSessionId, messageID: "msg_1", partID: "prt_1", field: "text", delta: "你好，" });
    server.emit("message.part.delta", { sessionID: nativeSessionId, messageID: "msg_1", partID: "prt_1", field: "text", delta: "世界" });
    server.emit("message.part.updated", {
      sessionID: nativeSessionId,
      part: { id: "prt_1", messageID: "msg_1", sessionID: nativeSessionId, type: "text", text: "你好，世界" },
    });
    server.emit("session.idle", { sessionID: nativeSessionId });
    const chat = ctx.chat(sessionId);
    const deltas = chat.filter((e): e is Extract<ChatEvent, { type: "message_delta" }> => e.type === "message_delta");
    expect(deltas.map((d) => d.delta).join("")).toBe("你好，世界");
    expect(deltas.every((d) => d.itemId === "msg_1" && d.partId === "prt_1")).toBe(true);
    expect(chat.some((e) => e.type === "message_completed" && e.itemId === "msg_1")).toBe(true);
    expect(chat.filter((e) => e.type === "turn_completed").length).toBe(1);
    expect(chat.at(-1)).toMatchObject({ type: "session_status", status: "idle" });
  });

  it("delta 丢帧自愈：只发一次 delta 后快照全文补齐", async () => {
    const ctx = makeAdapter();
    const { sessionId, nativeSessionId: nativeSessionIdRaw } = await ctx.adapter.createSession({ cwd: CWD }); const nativeSessionId = nativeSessionIdRaw!;
    const server = ctx.server(CWD);
    await ctx.adapter.sendTurn({ sessionId, text: "自愈" });
    server.emit("message.part.delta", { sessionID: nativeSessionId, messageID: "msg_1", partID: "prt_1", field: "text", delta: "前段" });
    server.emit("message.part.updated", {
      sessionID: nativeSessionId,
      part: { id: "prt_1", messageID: "msg_1", sessionID: nativeSessionId, type: "text", text: "前段加自愈尾巴" },
    });
    server.emit("session.idle", { sessionID: nativeSessionId });
    const joined = ctx
      .chat(sessionId)
      .filter((e): e is Extract<ChatEvent, { type: "message_delta" }> => e.type === "message_delta")
      .map((e) => e.delta)
      .join("");
    expect(joined).toBe("前段加自愈尾巴"); // 无重复无丢失
  });

  it("多消息 turn（工具轮+总结轮）：新消息首帧终结上一条 message_completed", async () => {
    const ctx = makeAdapter();
    const { sessionId, nativeSessionId: nativeSessionIdRaw } = await ctx.adapter.createSession({ cwd: CWD }); const nativeSessionId = nativeSessionIdRaw!;
    const server = ctx.server(CWD);
    await ctx.adapter.sendTurn({ sessionId, text: "跑" });
    server.emit("message.part.delta", { sessionID: nativeSessionId, messageID: "msg_1", partID: "prt_1", field: "text", delta: "工具轮" });
    server.emit("message.part.delta", { sessionID: nativeSessionId, messageID: "msg_2", partID: "prt_2", field: "text", delta: "总结轮" });
    server.emit("session.idle", { sessionID: nativeSessionId });
    const chat = ctx.chat(sessionId);
    expect(chat.some((e) => e.type === "message_completed" && e.itemId === "msg_1")).toBe(true);
    expect(chat.some((e) => e.type === "message_completed" && e.itemId === "msg_2")).toBe(true); // 收尾兜底
    expect(chat.filter((e) => e.type === "turn_completed").length).toBe(1);
  });

  it("reasoning part 的 delta 被降噪（快照先标记类型）", async () => {
    const ctx = makeAdapter();
    const { sessionId, nativeSessionId: nativeSessionIdRaw } = await ctx.adapter.createSession({ cwd: CWD }); const nativeSessionId = nativeSessionIdRaw!;
    const server = ctx.server(CWD);
    await ctx.adapter.sendTurn({ sessionId, text: "思考" });
    server.emit("message.part.updated", {
      sessionID: nativeSessionId,
      part: { id: "prt_reason", messageID: "msg_1", sessionID: nativeSessionId, type: "reasoning", text: "思考链" },
    });
    server.emit("message.part.delta", { sessionID: nativeSessionId, messageID: "msg_1", partID: "prt_reason", field: "text", delta: "思考噪声" });
    server.emit("message.part.delta", { sessionID: nativeSessionId, messageID: "msg_1", partID: "prt_text", field: "text", delta: "正文" });
    server.emit("session.idle", { sessionID: nativeSessionId });
    const joined = ctx
      .chat(sessionId)
      .filter((e): e is Extract<ChatEvent, { type: "message_delta" }> => e.type === "message_delta")
      .map((e) => e.delta)
      .join("");
    expect(joined).toBe("正文"); // reasoning 不进消息流
  });

  it("tool part：pending→running→completed；output 增量 → tool_update；argsSummary 命令直出", async () => {
    const ctx = makeAdapter();
    const { sessionId, nativeSessionId: nativeSessionIdRaw } = await ctx.adapter.createSession({ cwd: CWD }); const nativeSessionId = nativeSessionIdRaw!;
    const server = ctx.server(CWD);
    await ctx.adapter.sendTurn({ sessionId, text: "跑命令" });
    server.emit("message.part.updated", toolPartFrame(nativeSessionId, "msg_1", "tool_1", { status: "pending", input: { command: "echo hi" }, time: { start: 1000 } }));
    server.emit("message.part.updated", toolPartFrame(nativeSessionId, "msg_1", "tool_1", { status: "running", input: { command: "echo hi" }, output: "h", time: { start: 1000 } }));
    server.emit("message.part.updated", toolPartFrame(nativeSessionId, "msg_1", "tool_1", { status: "completed", input: { command: "echo hi" }, output: "hi\n", time: { start: 1000, end: 1200 } }));
    server.emit("session.idle", { sessionID: nativeSessionId });
    const chat = ctx.chat(sessionId);
    const started = chat.find((e): e is Extract<ChatEvent, { type: "tool_started" }> => e.type === "tool_started");
    expect(started).toMatchObject({ itemId: "tool_1", tool: "bash", argsSummary: "echo hi" });
    expect(chat.some((e) => e.type === "tool_update" && e.itemId === "tool_1" && e.outputDelta === "i\n")).toBe(true);
    const done = chat.find((e): e is Extract<ChatEvent, { type: "tool_completed" }> => e.type === "tool_completed");
    expect(done).toMatchObject({ itemId: "tool_1", status: "completed", durationMs: 200, output: "hi\n" });
  });

  it("忙态排队：idle 后自动续发第二 turn", async () => {
    const ctx = makeAdapter();
    const { sessionId, nativeSessionId: nativeSessionIdRaw } = await ctx.adapter.createSession({ cwd: CWD }); const nativeSessionId = nativeSessionIdRaw!;
    const server = ctx.server(CWD);
    await ctx.adapter.sendTurn({ sessionId, text: "一" });
    await ctx.adapter.sendTurn({ sessionId, text: "二" }); // 排队
    expect(server.apiCalls.filter((c) => c.path.endsWith("/prompt_async")).length).toBe(1);
    server.emit("session.idle", { sessionID: nativeSessionId });
    await new Promise((r) => setTimeout(r, 30)); // 队列续发（异步）
    expect(server.apiCalls.filter((c) => c.path.endsWith("/prompt_async")).length).toBe(2);
    const starts = ctx.chat(sessionId).filter((e): e is Extract<ChatEvent, { type: "turn_started" }> => e.type === "turn_started");
    expect(starts.length).toBe(2);
    expect(ctx.chat(sessionId).filter((e) => e.type === "turn_completed").length).toBe(1); // 第二 turn 待 playback
  });
});

describe("OpenCodeAdapter：审批（轮询 + replied 兜底）", () => {
  function armPermission(server: FakeServerClient, nativeId: string, id = "per_1"): void {
    server.pendingPermissions = [
      { id, sessionID: nativeId, permission: "bash", patterns: ["echo probe-ask"], always: ["echo *"], metadata: { command: "echo probe-ask" } },
    ];
  }

  it("轮询发现 pending → approval_requested（patterns/always 建议映射 + 命令行）+ waiting", async () => {
    const ctx = makeAdapter();
    const { sessionId, nativeSessionId: nativeSessionIdRaw } = await ctx.adapter.createSession({ cwd: CWD, permMode: "ask" }); const nativeSessionId = nativeSessionIdRaw!;
    const server = ctx.server(CWD);
    await ctx.adapter.sendTurn({ sessionId, text: "审批" });
    server.emit("message.part.updated", toolPartFrame(nativeSessionId, "msg_1", "tool_1", { status: "pending", input: { command: "echo probe-ask" } }));
    armPermission(server, nativeSessionId);
    await new Promise((r) => setTimeout(r, 60)); // 等轮询 tick
    const req = ctx.chat(sessionId).find((e): e is Extract<ChatEvent, { type: "approval_requested" }> => e.type === "approval_requested");
    expect(req).toBeDefined();
    expect(req!.command).toContain("echo probe-ask");
    expect(req!.itemId).toBe("tool_1"); // 绑定非终态 tool part
    const labels = req!.suggestions.map((s) => `${s.kind}:${s.label}`);
    expect(labels).toContain("pattern:echo *"); // always 建议
    expect(labels).toContain("pattern:echo probe-ask");
    expect(ctx.chat(sessionId).some((e) => e.type === "session_status" && e.status === "waiting")).toBe(true);
  });

  it("deny → POST reject；工具 error 终态映射 denied（itemId 一致）", async () => {
    const ctx = makeAdapter();
    const { sessionId, nativeSessionId: nativeSessionIdRaw } = await ctx.adapter.createSession({ cwd: CWD, permMode: "ask" }); const nativeSessionId = nativeSessionIdRaw!;
    const server = ctx.server(CWD);
    await ctx.adapter.sendTurn({ sessionId, text: "审批" });
    server.emit("message.part.updated", toolPartFrame(nativeSessionId, "msg_1", "tool_1", { status: "pending", input: { command: "echo x" } }));
    armPermission(server, nativeSessionId, "per_deny");
    await new Promise((r) => setTimeout(r, 60));
    await ctx.adapter.resolveApproval({ sessionId, requestId: "per_deny", decision: "deny" });
    const respond = server.apiCalls.find((c) => c.path.endsWith("/permissions/per_deny"));
    expect(respond?.body).toEqual({ response: "reject" }); // 语义不换写
    server.emit("message.part.updated", toolPartFrame(nativeSessionId, "msg_1", "tool_1", { status: "error", error: "The user rejected permission to use this specific tool call.", time: { start: 1, end: 2 } }));
    server.emit("session.idle", { sessionID: nativeSessionId });
    const done = ctx.chat(sessionId).find((e): e is Extract<ChatEvent, { type: "tool_completed" }> => e.type === "tool_completed");
    expect(done).toMatchObject({ itemId: "tool_1", status: "denied" });
  });

  it("allow-once → POST once；已决再响应 → E_APPROVAL_EXPIRED", async () => {
    const ctx = makeAdapter();
    const { sessionId, nativeSessionId: nativeSessionIdRaw } = await ctx.adapter.createSession({ cwd: CWD, permMode: "ask" }); const nativeSessionId = nativeSessionIdRaw!;
    const server = ctx.server(CWD);
    await ctx.adapter.sendTurn({ sessionId, text: "审批" });
    armPermission(server, nativeSessionId, "per_once");
    await new Promise((r) => setTimeout(r, 60));
    await ctx.adapter.resolveApproval({ sessionId, requestId: "per_once", decision: "allow-once" });
    expect(server.apiCalls.find((c) => c.path.endsWith("/permissions/per_once"))?.body).toEqual({ response: "once" });
    await expect(
      ctx.adapter.resolveApproval({ sessionId, requestId: "per_once", decision: "deny" }),
    ).rejects.toMatchObject({ code: "E_APPROVAL_EXPIRED" });
  });

  it("审批先于 tool part 到达（回退绑定）：deny 后首个 error part 映射 denied", async () => {
    const ctx = makeAdapter();
    const { sessionId, nativeSessionId: nativeSessionIdRaw } = await ctx.adapter.createSession({ cwd: CWD, permMode: "ask" }); const nativeSessionId = nativeSessionIdRaw!;
    const server = ctx.server(CWD);
    await ctx.adapter.sendTurn({ sessionId, text: "审批" });
    // 无 tool part 事件：pending permission 直接可查（回退绑定 ap-per_late）
    server.pendingPermissions = [{ id: "per_late", sessionID: nativeSessionId, permission: "bash", patterns: ["echo late"] }];
    await new Promise((r) => setTimeout(r, 60));
    const req = ctx.chat(sessionId).find((e): e is Extract<ChatEvent, { type: "approval_requested" }> => e.type === "approval_requested");
    expect(req).toBeDefined();
    expect(req!.itemId).toBe("ap-per_late");
    await ctx.adapter.resolveApproval({ sessionId, requestId: "per_late", decision: "deny" });
    // deny 决定后 tool part 才以 error 终态出现 → denied（itemId 即该 part）
    server.emit("message.part.updated", toolPartFrame(nativeSessionId, "msg_1", "tool_late", { status: "error", error: "The user rejected permission to use this specific tool call.", time: { start: 1, end: 2 } }));
    server.emit("session.idle", { sessionID: nativeSessionId });
    const done = ctx.chat(sessionId).find((e): e is Extract<ChatEvent, { type: "tool_completed" }> => e.type === "tool_completed");
    expect(done).toMatchObject({ itemId: "tool_late", status: "denied" });
  });

  it("permission.replied 兜底：非我方决定 → approval_expired（server_resolved）", async () => {
    const ctx = makeAdapter();
    const { sessionId, nativeSessionId: nativeSessionIdRaw } = await ctx.adapter.createSession({ cwd: CWD, permMode: "ask" }); const nativeSessionId = nativeSessionIdRaw!;
    const server = ctx.server(CWD);
    await ctx.adapter.sendTurn({ sessionId, text: "审批" });
    armPermission(server, nativeSessionId, "per_gone");
    await new Promise((r) => setTimeout(r, 60));
    server.emit("permission.replied", { sessionID: nativeSessionId, requestID: "per_gone", reply: "once" });
    const expired = ctx.chat(sessionId).find((e): e is Extract<ChatEvent, { type: "approval_expired" }> => e.type === "approval_expired");
    expect(expired).toMatchObject({ requestId: "per_gone" });
    expect(expired!.reason).toContain("server_resolved");
    await expect(
      ctx.adapter.resolveApproval({ sessionId, requestId: "per_gone", decision: "allow-once" }),
    ).rejects.toMatchObject({ code: "E_APPROVAL_EXPIRED" });
  });

  it("审批 POST 非 2xx → E_APPROVAL_EXPIRED（服务端已终结）", async () => {
    const ctx = makeAdapter();
    const { sessionId, nativeSessionId: nativeSessionIdRaw } = await ctx.adapter.createSession({ cwd: CWD, permMode: "ask" }); const nativeSessionId = nativeSessionIdRaw!;
    const server = ctx.server(CWD);
    await ctx.adapter.sendTurn({ sessionId, text: "审批" });
    armPermission(server, nativeSessionId, "per_bad");
    await new Promise((r) => setTimeout(r, 60));
    server.apiOverride = (method, path) =>
      method === "POST" && path.endsWith("/permissions/per_bad")
        ? { status: 400, ok: false, json: null, text: "already replied" }
        : null;
    await expect(
      ctx.adapter.resolveApproval({ sessionId, requestId: "per_bad", decision: "deny" }),
    ).rejects.toMatchObject({ code: "E_APPROVAL_EXPIRED" });
  });
});

describe("OpenCodeAdapter：interrupt / 死亡 / 恢复", () => {
  it("abort → MessageAbortedError+idle 归类 turn_interrupted；运行中工具 → interrupted；可继续", async () => {
    const ctx = makeAdapter();
    const { sessionId, nativeSessionId: nativeSessionIdRaw } = await ctx.adapter.createSession({ cwd: CWD }); const nativeSessionId = nativeSessionIdRaw!;
    const server = ctx.server(CWD);
    await ctx.adapter.sendTurn({ sessionId, text: "长任务" });
    server.emit("message.part.delta", { sessionID: nativeSessionId, messageID: "msg_1", partID: "prt_1", field: "text", delta: "部分输出" });
    server.emit("message.part.updated", toolPartFrame(nativeSessionId, "msg_1", "tool_1", { status: "running", input: { command: "long" } }));
    await ctx.adapter.interruptTurn(sessionId);
    await ctx.adapter.interruptTurn(sessionId); // 幂等
    expect(server.apiCalls.filter((c) => c.path.endsWith("/abort")).length).toBe(1);
    server.emit("session.error", { sessionID: nativeSessionId, error: { name: "MessageAbortedError", message: "Aborted" } });
    server.emit("session.idle", { sessionID: nativeSessionId });
    const chat = ctx.chat(sessionId);
    expect(chat.filter((e) => e.type === "turn_interrupted").length).toBe(1);
    expect(chat.at(-1)).toMatchObject({ type: "session_status", status: "interrupted" });
    expect(chat.some((e) => e.type === "tool_completed" && e.itemId === "tool_1" && e.status === "interrupted")).toBe(true);
    // 会话可继续
    await ctx.adapter.sendTurn({ sessionId, text: "继续" });
    expect(ctx.chat(sessionId).filter((e) => e.type === "turn_started").length).toBe(2);
  });

  it("interrupt 前置拒绝待决审批（reject + approval_expired）", async () => {
    const ctx = makeAdapter();
    const { sessionId, nativeSessionId: nativeSessionIdRaw } = await ctx.adapter.createSession({ cwd: CWD, permMode: "ask" }); const nativeSessionId = nativeSessionIdRaw!;
    const server = ctx.server(CWD);
    await ctx.adapter.sendTurn({ sessionId, text: "审批" });
    server.pendingPermissions = [{ id: "per_i", sessionID: nativeSessionId, permission: "bash", patterns: ["echo i"] }];
    await new Promise((r) => setTimeout(r, 60));
    await ctx.adapter.interruptTurn(sessionId);
    expect(server.apiCalls.find((c) => c.path.endsWith("/permissions/per_i"))?.body).toEqual({ response: "reject" });
    expect(ctx.chat(sessionId).some((e) => e.type === "approval_expired" && e.requestId === "per_i")).toBe(true);
  });

  it("server 死亡 → session_exit/disconnected；sendTurn 拒绝；resume 拉起 server 后可继续", async () => {
    const ctx = makeAdapter();
    const { sessionId } = await ctx.adapter.createSession({ cwd: CWD });
    const server = ctx.server(CWD);
    server.simulateDeath();
    const chat = ctx.chat(sessionId);
    expect(chat.some((e) => e.type === "session_exit")).toBe(true);
    expect(chat.at(-1)).toMatchObject({ type: "session_status", status: "disconnected" });
    await expect(ctx.adapter.sendTurn({ sessionId, text: "x" })).rejects.toMatchObject({ code: "E_INTERNAL" });
    await ctx.adapter.resume(sessionId); // FakeHost 重建 server（新实例）
    const revived = ctx.server(CWD);
    expect(revived).not.toBe(server);
    expect(ctx.chat(sessionId).at(-1)).toMatchObject({ type: "session_status", status: "idle" });
    // resume 后可继续（原生上下文经 native id 延续）
    await ctx.adapter.sendTurn({ sessionId, text: "继续" });
    expect(revived.apiCalls.some((c) => c.path.endsWith("/prompt_async"))).toBe(true);
  });

  it("adoptSession（#13 接入点）：断开登记 → readHistory 拉起 server 回填 → resume idle", async () => {
    const ctx = makeAdapter();
    await ctx.adapter.adoptSession({ sessionId: "s-adopt", nativeSessionId: "ses_old", cwd: CWD, permMode: "ask" });
    expect(ctx.chat("s-adopt").at(-1)).toMatchObject({ type: "session_status", status: "disconnected" });
    // readHistory 按需拉起 server（首次为空历史）后灌入原生历史再回填
    await ctx.adapter.readHistory("s-adopt");
    const server = ctx.server(CWD);
    expect(server).toBeDefined();
    server.history = [
      {
        info: { id: "msg_hist", role: "assistant", parentID: "u0", time: { created: Date.now() } },
        parts: [
          { id: "prt_hist", type: "text", text: "历史暗号" },
          { id: "tool_hist", type: "tool", tool: "bash", state: { status: "completed", input: { command: "echo 1" }, output: "1", time: { start: 1, end: 2 } } },
        ],
      },
    ];
    const snapshot = await ctx.adapter.readHistory("s-adopt");
    const types = snapshot.map((e) => e.type);
    expect(types).toContain("turn_started");
    expect(types).toContain("message_delta");
    expect(types).toContain("message_completed");
    expect(types).toContain("tool_started");
    expect(types).toContain("tool_completed");
    expect(types).toContain("turn_completed");
    const text = snapshot
      .filter((e): e is Extract<ChatEvent, { type: "message_delta" }> => e.type === "message_delta")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("历史暗号");
    await ctx.adapter.resume("s-adopt");
    expect(ctx.chat("s-adopt").at(-1)).toMatchObject({ type: "session_status", status: "idle" });
  });

  it("readHistory 与实时流同键去重（快照+增量无缝拼接）", async () => {
    const ctx = makeAdapter();
    const { sessionId, nativeSessionId: nativeSessionIdRaw } = await ctx.adapter.createSession({ cwd: CWD }); const nativeSessionId = nativeSessionIdRaw!;
    const server = ctx.server(CWD);
    await ctx.adapter.sendTurn({ sessionId, text: "一" });
    server.emit("message.part.delta", { sessionID: nativeSessionId, messageID: "msg_1", partID: "prt_1", field: "text", delta: "第一轮全文" });
    server.emit("session.idle", { sessionID: nativeSessionId });
    server.history = [
      {
        info: { id: "msg_1", role: "assistant", parentID: "u1", time: { created: Date.now() } },
        parts: [{ id: "prt_1", type: "text", text: "第一轮全文" }],
      },
    ];
    const snapshot = await ctx.adapter.readHistory(sessionId);
    const maxSeq = Math.max(...snapshot.map((e) => e.seq));
    // 第二轮实时（历史未落账该轮）
    await ctx.adapter.sendTurn({ sessionId, text: "二" });
    server.emit("message.part.delta", { sessionID: nativeSessionId, messageID: "msg_2", partID: "prt_2", field: "text", delta: "第二轮" });
    server.emit("session.idle", { sessionID: nativeSessionId });
    const live = ctx.chat(sessionId).filter((e) => e.seq > maxSeq);
    expect(live.some((e) => e.type === "message_delta" && e.itemId === "msg_2")).toBe(true);
    const final = await ctx.adapter.readHistory(sessionId);
    // 历史回填不得重复第一轮（同键去重）
    const firstTurnDeltas = final.filter(
      (e): e is Extract<ChatEvent, { type: "message_delta" }> => e.type === "message_delta" && e.itemId === "msg_1",
    );
    expect(firstTurnDeltas.map((e) => e.delta).join("")).toBe("第一轮全文");
    const merged = [...snapshot, ...live].map((e) => e.seq);
    expect(new Set(merged).size).toBe(merged.length); // seq 无重复
    expect(final.length).toBe(snapshot.length + live.length);
  });
});

describe("OpenCodeAdapter：/command 路由与 SkillObservation", () => {
  it("命中已知 command → POST /session/{id}/command（arguments 必填空对象串）+ self_reported；不走 prompt_async", async () => {
    const ctx = makeAdapter();
    const { sessionId } = await ctx.adapter.createSession({ cwd: CWD });
    const server = ctx.server(CWD);
    server.commands = [{ name: "kb-probe" }, { name: "other" }];
    await ctx.adapter.sendTurn({ sessionId, text: "/kb-probe 附加说明" });
    expect(server.apiCalls.some((c) => c.path.endsWith("/prompt_async"))).toBe(false);
    const cmd = server.apiCalls.find((c) => c.method === "POST" && c.path.endsWith("/command"));
    expect(cmd?.body).toMatchObject({ command: "kb-probe", arguments: "{}" });
    const obs = ctx.skills(sessionId);
    expect(obs.length).toBe(1);
    expect(obs[0]).toMatchObject({ kind: "skill", cli: "opencode", skill: "kb-probe", evidenceLevel: "self_reported", source: "opencode-command" });
  });

  it("未命中 command 的斜杠输入按普通 prompt 发送", async () => {
    const ctx = makeAdapter();
    const { sessionId } = await ctx.adapter.createSession({ cwd: CWD });
    const server = ctx.server(CWD);
    server.commands = [{ name: "kb-probe" }];
    await ctx.adapter.sendTurn({ sessionId, text: "/not-a-command 参数" });
    const prompt = server.apiCalls.find((c) => c.path.endsWith("/prompt_async"));
    expect(prompt?.body).toMatchObject({ parts: [{ type: "text", text: "/not-a-command 参数" }] });
    expect(ctx.skills(sessionId)).toHaveLength(0);
  });

  it("splitModelId：含斜杠按第一个斜杠切分（magpie 形态）", () => {
    expect(splitModelId("magpie/192-168-4-61-3000/asw_glm-5.3")).toEqual({
      providerID: "magpie",
      modelID: "192-168-4-61-3000/asw_glm-5.3",
    });
    expect(splitModelId("plain-model")).toEqual({ providerID: "", modelID: "plain-model" });
  });
});

/* ---------------- 契约套第四实现（Fake + Codex + Claude + OpenCode） ---------------- */

/**
 * 契约 Fake server 行为：
 * - 普通 turn：首 delta 即发，余量 250ms 延迟完成（保证 interruptTurn 有窗口取消）；
 * - 「审批」开头 turn：工具 pending + pending 列表（等 resolveApproval），resolve 后按 decision 完成；
 * - abort：取消延迟完成 → MessageAbortedError + idle（归 turn_interrupted）。
 */
function makeContractAdapter() {
  const host = new FakeHost();
  const adapter = new OpenCodeAdapter({ host, pollIntervalMs: 15 });
  const events: AdapterEvent[] = [];
  adapter.subscribe((e) => events.push(e));

  const wire = (server: FakeServerClient): void => {
    let turnSeq = 0;
    let completeTimer: NodeJS.Timeout | null = null;
    let approvalMsgId: string | null = null;
    server.onPrompt = (nativeId, text) => {
      turnSeq += 1;
      if (text.startsWith("审批")) {
        approvalMsgId = `msg_a${turnSeq}`;
        server.emit("message.part.updated", toolPartFrame(nativeId, approvalMsgId, `tool_a${turnSeq}`, { status: "pending", input: { command: "echo probe" } }));
        server.pendingPermissions = [
          { id: `per_${turnSeq}`, sessionID: nativeId, permission: "bash", patterns: ["echo probe"], always: ["echo *"], metadata: { command: "echo probe" } },
        ];
        return;
      }
      approvalMsgId = null;
      const msgId = `msg_t${turnSeq}`;
      const partId = `prt_t${turnSeq}`;
      const full = "契约演示文本：结构化会话正常输出。";
      server.emit("message.part.delta", { sessionID: nativeId, messageID: msgId, partID: partId, field: "text", delta: full.slice(0, 4) });
      completeTimer = setTimeout(() => {
        completeTimer = null;
        server.emit("message.part.delta", { sessionID: nativeId, messageID: msgId, partID: partId, field: "text", delta: full.slice(4) });
        server.emit("message.part.updated", { sessionID: nativeId, part: { id: partId, messageID: msgId, sessionID: nativeId, type: "text", text: full } });
        server.emit("session.idle", { sessionID: nativeId });
        server.history.push({
          info: { id: msgId, role: "assistant", parentID: `u_${turnSeq}`, time: { created: Date.now() } },
          parts: [{ id: partId, type: "text", text: full }],
        });
      }, 250);
    };
    server.apiOverride = (method, path, body) => {
      const nativeId = path.split("/")[2] ?? "";
      if (method === "POST" && path.endsWith("/abort")) {
        if (completeTimer) clearTimeout(completeTimer);
        completeTimer = null;
        server.pendingPermissions = [];
        server.emit("session.error", { sessionID: nativeId, error: { name: "MessageAbortedError", message: "Aborted" } });
        server.emit("session.idle", { sessionID: nativeId });
        return { status: 204, ok: true, json: null, text: "" };
      }
      if (method === "POST" && path.includes("/permissions/")) {
        const decision = String((body as { response?: string })?.response ?? "");
        const msgId = approvalMsgId;
        approvalMsgId = null;
        server.pendingPermissions = [];
        const partId = `tool_a${turnSeq}`;
        setTimeout(() => {
          if (msgId) {
            if (decision === "reject") {
              server.emit("message.part.updated", toolPartFrame(nativeId, msgId, partId, { status: "error", error: "The user rejected permission to use this specific tool call.", time: { start: 1, end: 2 } }));
            } else {
              server.emit("message.part.updated", toolPartFrame(nativeId, msgId, partId, { status: "completed", input: { command: "echo probe" }, output: "probe", time: { start: 1, end: 2 } }));
            }
            server.emit("message.part.updated", { sessionID: nativeId, part: { id: `prt_a${turnSeq}`, messageID: msgId, sessionID: nativeId, type: "text", text: "审批流程完成" } });
          }
          server.emit("session.idle", { sessionID: nativeId });
        });
        return { status: 200, ok: true, json: null, text: "" };
      }
      return null;
    };
  };
  const origAcquire = host.acquire.bind(host);
  host.acquire = async (cwd, mode, ownerKey) => {
    const server = await origAcquire(cwd, mode, ownerKey);
    if (!server.onPrompt) wire(server);
    return server;
  };

  const chat = (sid: string) => events.filter((e): e is ChatEvent => "type" in e && e.sessionId === sid);
  async function driveIdle(): Promise<void> {
    const deadline = Date.now() + 10_000;
    let stableSince = 0;
    for (;;) {
      if (Date.now() > deadline) throw new Error("driveIdle 超时");
      const statuses = new Map<string, string>();
      for (const e of events) if ("type" in e && e.type === "session_status") statuses.set(e.sessionId, e.status);
      const busy = [...statuses.values()].some((s) => s === "running");
      if (!busy) {
        if (stableSince === 0) stableSince = Date.now();
        if (Date.now() - stableSince > 150) return; // waiting（审批等用户）视为稳定
      } else {
        stableSince = 0;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  return { adapter, driveIdle, chat };
}

defineAdapterContractTests(
  async () => makeContractAdapter(),
  {
    turnText: "普通",
    secondTurnText: "第二轮",
    interruptTurnText: "请从 1 慢慢数到 30",
    approvalTurnText: "审批流程",
    approvalPermMode: "ask",
    cwd: CWD,
    assistantMessages: { exactly: 1 },
    firstAssistantText: null,
    suggestionsRequired: true,
    deny: { contains: [], notContains: [] },
    once: { outputContains: [], expectSecondAsk: false },
    always: { outputContains: [], finalContains: [], expectNoSecondAsk: false },
  },
);

// 保持 createCollector 引用（契约收集器一致性由其自身保证）
void createCollector;
