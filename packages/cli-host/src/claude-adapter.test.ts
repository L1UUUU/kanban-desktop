// 用途：ClaudeAdapter 协议映射单测 —— FakeStream 手动注入 stream-json 消息，断言 C1 事件映射、stdio 审批三态（allow-once/allow-always 规则化/deny）、interrupt 归类已取消、hook verified 双信号、transcript 回填拼接、启动自检 fail-fast（不依赖真实 claude）
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeAdapter, type ClaudeStreamClientLike } from "./claude-adapter";
import { assertApprovalFlag, CLAUDE_BASE_ARGS, type ClaudeStreamOptions } from "./claude/client";
import { skillObservationSchema, type AdapterEvent, type ChatEvent, type SkillObservation } from "@kanban/ipc-schema";

/** 记录型 Fake 流客户端：start 立即握手成功；测试手动 emit 协议消息/控制请求/进程退出 */
class FakeStream implements ClaudeStreamClientLike {
  private static seq = 0;
  dead = false;
  exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  readonly options: ClaudeStreamOptions;
  readonly sentUsers: string[] = [];
  readonly sentControlResponses: Array<{ requestId: string; response: unknown }> = [];
  interruptCalls = 0;
  private readonly msgFns = new Set<(msg: Record<string, unknown>) => void>();
  private readonly deadFns = new Set<(err: Error) => void>();

  constructor(options: ClaudeStreamOptions) {
    this.options = options;
  }
  async start(): Promise<void> {
    FakeStream.seq += 1; // native id 现由 Adapter 预生成（--session-id），start 仅表达握手完成
  }
  sendUser(text: string): void {
    this.sentUsers.push(text);
  }
  interrupt(): Promise<void> {
    this.interruptCalls += 1;
    return Promise.resolve();
  }
  respondControlRequest(requestId: string, response: unknown): void {
    this.sentControlResponses.push({ requestId, response });
  }
  onMessage(fn: (msg: Record<string, unknown>) => void): () => void {
    this.msgFns.add(fn);
    return () => {
      this.msgFns.delete(fn);
    };
  }
  onDead(fn: (err: Error) => void): () => void {
    this.deadFns.add(fn);
    return () => {
      this.deadFns.delete(fn);
    };
  }
  stop(): void {
    this.simulateExit(null);
  }

  /* ---- 测试驱动 API ---- */
  emit(msg: Record<string, unknown>): void {
    for (const fn of this.msgFns) fn(msg);
  }
  simulateExit(code: number | null): void {
    if (this.dead) return;
    this.exitInfo = { code, signal: null };
    this.dead = true;
    for (const fn of this.deadFns) fn(new Error(`claude 进程已退出：code=${code}`));
  }
}

/** 构造被测 adapter + Fake 工厂（每次 spawn 换新实例）；hookDir 隔离在临时目录 */
function makeAdapter() {
  const hookDir = mkdtempSync(path.join(tmpdir(), "kb-claude-hook-"));
  const streams: FakeStream[] = [];
  const adapter = new ClaudeAdapter({
    hookDir,
    clientFactory: (options) => {
      const s = new FakeStream(options);
      streams.push(s);
      return s;
    },
  });
  const events: AdapterEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const chat = (sid: string) => events.filter((e): e is ChatEvent => "type" in e && e.sessionId === sid);
  const skills = (sid?: string) =>
    events.filter((e): e is SkillObservation => !("type" in e) && (!sid || e.sessionId === sid));
  return { adapter, streams, stream: () => streams.at(-1)!, events, chat, skills, hookDir };
}

const CWD = "C:\\demo";

/** 标准一轮文本流：stream_event 增量 + assistant 终文（部分 delta 覆盖，考验终文自愈；block index 与 content 数组位置对齐——真实 wire thinking=0/text=1，这里单 text 块=0） */
function playTextTurn(
  s: FakeStream,
  msgId: string,
  finalText: string,
  result: Record<string, unknown> = { type: "result", subtype: "success", session_id: "native-1" },
): void {
  const head = finalText.slice(0, 2);
  if (head) {
    s.emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: head } }, api_message_id: msgId });
  }
  const tail = finalText.slice(2, 5);
  if (tail) {
    s.emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: tail } }, api_message_id: msgId });
  }
  s.emit({ type: "assistant", message: { id: msgId, role: "assistant", content: [{ type: "text", text: finalText }] }, session_id: "native-1" });
  s.emit(result);
}

/** 审批控制请求（PoC 7 T3 wire 形状） */
function emitCanUseTool(s: FakeStream, requestId: string, toolUseId: string, toolName = "Bash"): void {
  s.emit({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: toolName,
      input: { command: `echo x > ${toolUseId}.txt`, description: "写探针文件" },
      permission_suggestions: [
        { type: "addRules", rules: [{ toolName: "Bash", ruleContent: `echo x > ${toolUseId}.txt` }], behavior: "allow", destination: "session" },
        { type: "addDirectories", directories: ["C:\\demo"], destination: "session" },
      ],
      blocked_path: `C:\\demo\\${toolUseId}.txt`,
      tool_use_id: toolUseId,
    },
  });
}

let hookRoots: string[] = [];
afterEach(() => {
  for (const dir of hookRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄延迟，残留临时目录不判失败 */
    }
  }
  hookRoots = [];
});

describe("ClaudeAdapter：createSession 与启动自检", () => {
  it("spawn 参数含审批 flag（base 恒带）+ --settings 注入文件 + --session-id 预指定 native id", async () => {
    const ctx = makeAdapter();
    hookRoots.push(ctx.hookDir);
    const { sessionId, nativeSessionId } = await ctx.adapter.createSession({ cwd: CWD });
    expect(sessionId.length).toBeGreaterThan(0);
    // native id 由 Adapter 预生成（UUID）并经 --session-id 强制（CLI 2.x system/init 懒发射，不能等 init 拿 id）
    expect(nativeSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const args = ctx.stream().options.args ?? [];
    expect(args[0]).toBe("--settings");
    expect(args[1].endsWith(path.join(sessionId, "settings.json"))).toBe(true);
    expect(args[args.indexOf("--session-id") + 1]).toBe(nativeSessionId);
    expect([...CLAUDE_BASE_ARGS]).toContain("--permission-prompt-tool");
  });

  it("注入 settings：PreToolUse/PostToolUse(Skill) matcher=Skill；ask 档追加 permissions.ask；full 档带 --dangerously-skip-permissions", async () => {
    const ctx = makeAdapter();
    hookRoots.push(ctx.hookDir);
    const { sessionId } = await ctx.adapter.createSession({ cwd: CWD, permMode: "auto" });
    const settings = JSON.parse(readFileSync(path.join(ctx.hookDir, sessionId, "settings.json"), "utf8"));
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Skill");
    expect(settings.hooks.PostToolUse[0].matcher).toBe("Skill");
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("hook-capture.mjs");
    expect(settings.permissions).toBeUndefined(); // auto 档不注入严格工具配置

    const ask = makeAdapter();
    hookRoots.push(ask.hookDir);
    const a = await ask.adapter.createSession({ cwd: CWD, permMode: "ask" });
    const askSettings = JSON.parse(readFileSync(path.join(ask.hookDir, a.sessionId, "settings.json"), "utf8"));
    expect(askSettings.permissions.ask).toContain("Read"); // 请求档：只读工具也问

    const full = makeAdapter();
    hookRoots.push(full.hookDir);
    await full.adapter.createSession({ cwd: CWD, permMode: "full" });
    expect(full.stream().options.args).toContain("--dangerously-skip-permissions");
  });

  it("启动自检 fail-fast：审批 flag 缺失即抛错（非交互=静默全拒绝不留路径）", () => {
    expect(() => assertApprovalFlag(["--print", "--output-format", "stream-json"])).toThrow("启动自检失败");
    expect(() => assertApprovalFlag(["--permission-prompt-tool", "mcp__x__y"])).toThrow("启动自检失败");
    expect(() => assertApprovalFlag([...CLAUDE_BASE_ARGS])).not.toThrow();
  });
});

describe("ClaudeAdapter：turn 与流式映射", () => {
  it("sendTurn → user 行写入；stream delta→message_delta（同 itemId/partId）；终文自愈补齐 + message_completed", async () => {
    const ctx = makeAdapter();
    hookRoots.push(ctx.hookDir);
    const { sessionId } = await ctx.adapter.createSession({ cwd: CWD });
    await ctx.adapter.sendTurn({ sessionId, text: "你好" });
    expect(ctx.stream().sentUsers).toEqual(["你好"]);
    playTextTurn(ctx.stream(), "msg-1", "前五个字加尾巴");
    const deltas = ctx.chat(sessionId).filter((e): e is Extract<ChatEvent, { type: "message_delta" }> => e.type === "message_delta");
    // delta 流「前五个字」+ 终文自愈补「加尾巴」→ 拼接与终文逐一相等（无重复无丢失）
    expect(deltas.map((d) => d.delta).join("")).toBe("前五个字加尾巴");
    expect(deltas.every((d) => d.itemId === "msg-1" && d.partId === "0")).toBe(true);
    expect(ctx.chat(sessionId).some((e) => e.type === "message_completed" && e.itemId === "msg-1")).toBe(true);
    expect(ctx.chat(sessionId).filter((e) => e.type === "turn_completed").length).toBe(1);
    expect(ctx.chat(sessionId).at(-1)).toMatchObject({ type: "session_status", status: "idle" });
  });

  it("tool_use → tool_started；tool_result → tool_completed（含输出与时长）", async () => {
    const ctx = makeAdapter();
    hookRoots.push(ctx.hookDir);
    const { sessionId } = await ctx.adapter.createSession({ cwd: CWD });
    await ctx.adapter.sendTurn({ sessionId, text: "跑命令" });
    const s = ctx.stream();
    s.emit({ type: "assistant", message: { id: "msg-1", role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "echo hi" } }] }, session_id: "native-1" });
    s.emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "hi", is_error: false }] }, session_id: "native-1" });
    playTextTurn(s, "msg-2", "完成");
    const started = ctx.chat(sessionId).find((e): e is Extract<ChatEvent, { type: "tool_started" }> => e.type === "tool_started");
    expect(started).toMatchObject({ itemId: "call-1", tool: "Bash", argsSummary: '{"command":"echo hi"}' });
    const done = ctx.chat(sessionId).find((e): e is Extract<ChatEvent, { type: "tool_completed" }> => e.type === "tool_completed");
    expect(done).toMatchObject({ itemId: "call-1", status: "completed", output: "hi" });
    expect(done!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("忙态排队：turn 进行中 sendTurn 排队，result 后自动续发", async () => {
    const ctx = makeAdapter();
    hookRoots.push(ctx.hookDir);
    const { sessionId } = await ctx.adapter.createSession({ cwd: CWD });
    await ctx.adapter.sendTurn({ sessionId, text: "一" });
    await ctx.adapter.sendTurn({ sessionId, text: "二" });
    expect(ctx.stream().sentUsers).toEqual(["一"]); // 未立即发第二个
    playTextTurn(ctx.stream(), "msg-1", "第一轮");
    expect(ctx.stream().sentUsers).toEqual(["一", "二"]); // 排队消息自动续发
    const seqs = ctx.chat(sessionId);
    const starts = seqs.filter((e) => e.type === "turn_started");
    const firstCompleted = seqs.find((e) => e.type === "turn_completed")!;
    expect(starts.length).toBe(2);
    expect(starts[1].seq).toBeGreaterThan(firstCompleted.seq);
  });

  it("result 非 success 且非中断 → session_error + idle；错误不重放", async () => {
    const ctx = makeAdapter();
    hookRoots.push(ctx.hookDir);
    const { sessionId } = await ctx.adapter.createSession({ cwd: CWD });
    await ctx.adapter.sendTurn({ sessionId, text: "x" });
    await ctx.adapter.sendTurn({ sessionId, text: "排队的" });
    ctx.stream().emit({ type: "result", subtype: "error_max_turns", is_error: true, result: "超限", session_id: "native-1" });
    expect(ctx.chat(sessionId).filter((e) => e.type === "session_error").length).toBe(1);
    expect(ctx.chat(sessionId).at(-1)).toMatchObject({ type: "session_status", status: "idle" });
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.stream().sentUsers).toEqual(["x"]); // 排队消息被丢弃
  });
});

describe("ClaudeAdapter：stdio 审批映射", () => {
  /** 建会话并发起一个待决审批 */
  async function setupApproval(decidedToolUse = "call-1") {
    const ctx = makeAdapter();
    hookRoots.push(ctx.hookDir);
    const { sessionId } = await ctx.adapter.createSession({ cwd: CWD, permMode: "ask" });
    await ctx.adapter.sendTurn({ sessionId, text: "写文件" });
    emitCanUseTool(ctx.stream(), "ap-1", decidedToolUse);
    return { ...ctx, sessionId };
  }

  it("can_use_tool → approval_requested（命令摘要 + addRules/addDirectories 建议）+ waiting", async () => {
    const { chat, sessionId } = await setupApproval();
    const req = chat(sessionId).find((e): e is Extract<ChatEvent, { type: "approval_requested" }> => e.type === "approval_requested");
    expect(req).toBeDefined();
    expect(req!.requestId).toBe("ap-1");
    expect(req!.itemId).toBe("call-1");
    expect(req!.command).toContain("echo x > call-1.txt");
    expect(req!.suggestions).toHaveLength(2);
    expect(req!.suggestions[0].kind).toBe("rule");
    expect(req!.suggestions[1].kind).toBe("directory");
    expect(chat(sessionId).some((e) => e.type === "session_status" && e.status === "waiting")).toBe(true);
  });

  it("deny → wire {behavior:deny,message}；tool_result 映射 denied", async () => {
    const ctx = await setupApproval();
    const { adapter, chat, sessionId } = ctx;
    const stream = ctx.stream();
    await adapter.resolveApproval({ sessionId, requestId: "ap-1", decision: "deny" });
    expect(stream.sentControlResponses).toEqual([
      { requestId: "ap-1", response: { behavior: "deny", message: "用户在 kanban-desktop 拒绝了该操作" } },
    ]);
    stream.emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "用户拒绝", is_error: true }] }, session_id: "native-1" });
    playTextTurn(stream, "msg-9", "好的，不执行了");
    expect(chat(sessionId).find((e): e is Extract<ChatEvent, { type: "tool_completed" }> => e.type === "tool_completed")).toMatchObject({ itemId: "call-1", status: "denied" });
    // deny 后状态回 running，turn 走到终态
    expect(chat(sessionId).at(-1)).toMatchObject({ type: "session_status", status: "idle" });
  });

  it("allow-once → wire {behavior:allow}（不带规则）", async () => {
    const ctx = await setupApproval("call-2");
    await ctx.adapter.resolveApproval({ sessionId: ctx.sessionId, requestId: "ap-1", decision: "allow-once" });
    expect(ctx.stream().sentControlResponses).toEqual([{ requestId: "ap-1", response: { behavior: "allow" } }]);
  });

  it("allow-always → 规则化：原样回传 CLI 建议的 addRules（updatedPermissions）", async () => {
    const ctx = await setupApproval("call-3");
    await ctx.adapter.resolveApproval({ sessionId: ctx.sessionId, requestId: "ap-1", decision: "allow-always" });
    const expectedRule = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "echo x > call-3.txt" }], behavior: "allow", destination: "session" };
    expect(ctx.stream().sentControlResponses).toEqual([
      { requestId: "ap-1", response: { behavior: "allow", updatedPermissions: [expectedRule] } },
    ]);
  });

  it("已决审批再响应 → E_APPROVAL_EXPIRED；未知会话 → E_SESSION_NOT_FOUND", async () => {
    const { adapter, chat, sessionId } = await setupApproval("call-4");
    await adapter.resolveApproval({ sessionId, requestId: "ap-1", decision: "allow-once" });
    await expect(adapter.resolveApproval({ sessionId, requestId: "ap-1", decision: "deny" })).rejects.toMatchObject({ code: "E_APPROVAL_EXPIRED" });
    await expect(adapter.sendTurn({ sessionId: "nope", text: "x" })).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
    await expect(adapter.interruptTurn("nope")).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
    await expect(adapter.readHistory("nope")).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
    void chat;
  });
});

describe("ClaudeAdapter：interrupt 与进程死亡/resume", () => {
  it("interrupt → 控制请求发出一次（幂等）；error_during_execution → turn_interrupted（非报错）且排队丢弃、可继续", async () => {
    const ctx = makeAdapter();
    hookRoots.push(ctx.hookDir);
    const { sessionId } = await ctx.adapter.createSession({ cwd: CWD });
    await ctx.adapter.sendTurn({ sessionId, text: "长任务" });
    const s = ctx.stream();
    s.emit({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "1" } }, api_message_id: "msg-1" });
    await ctx.adapter.sendTurn({ sessionId, text: "排队的" }); // 忙态排队（应被中断丢弃）
    await ctx.adapter.interruptTurn(sessionId);
    await ctx.adapter.interruptTurn(sessionId); // 幂等：只发一次 interrupt
    expect(s.interruptCalls).toBe(1);
    // 中断确认后 CLI 终结本轮：error_during_execution + is_error=true（PoC 7 T2）
    s.emit({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 2, session_id: "native-1" });
    const chat = ctx.chat(sessionId);
    expect(chat.filter((e) => e.type === "turn_interrupted").length).toBe(1);
    expect(chat.filter((e) => e.type === "session_error").length).toBe(0); // 归类已取消而非报错
    expect(chat.at(-1)).toMatchObject({ type: "session_status", status: "interrupted" });
    expect(s.sentUsers).toEqual(["长任务"]); // 排队消息被丢弃
    await ctx.adapter.sendTurn({ sessionId, text: "继续" }); // 同会话可继续
    expect(s.sentUsers).toEqual(["长任务", "继续"]);
  });

  it("interrupt 时待决审批先拒绝（不留挂起卡），turn 走向取消终态", async () => {
    const ctx = makeAdapter();
    hookRoots.push(ctx.hookDir);
    const { sessionId } = await ctx.adapter.createSession({ cwd: CWD });
    await ctx.adapter.sendTurn({ sessionId, text: "写文件" });
    const s = ctx.stream();
    emitCanUseTool(s, "ap-9", "call-9");
    await ctx.adapter.interruptTurn(sessionId);
    expect(s.sentControlResponses[0].response).toMatchObject({ behavior: "deny", message: "用户取消了本轮" });
    expect(s.interruptCalls).toBe(1);
    // CLI 确认中断后终结本轮（PoC 7 T2 形态）
    s.emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "native-1" });
    const chat = ctx.chat(sessionId);
    expect(chat.filter((e) => e.type === "turn_interrupted").length).toBe(1);
    expect(chat.some((e) => e.type === "approval_expired")).toBe(false); // 响应式拒绝（非过期）
    expect(chat.at(-1)).toMatchObject({ type: "session_status", status: "interrupted" });
  });

  it("进程死亡：session_exit + disconnected；sendTurn 明确报错；resume 以 --resume 原 id 重建并续用", async () => {
    const ctx = makeAdapter();
    hookRoots.push(ctx.hookDir);
    const { sessionId, nativeSessionId } = await ctx.adapter.createSession({ cwd: CWD });
    const s1 = ctx.stream();
    await ctx.adapter.sendTurn({ sessionId, text: "记住暗号" });
    playTextTurn(s1, "msg-1", "暗号是琥珀象9号");
    s1.simulateExit(0); // 进程死亡（poc-7 T4 场景：进程 A 正常退出）
    const chat = ctx.chat(sessionId);
    expect(chat.filter((e) => e.type === "session_exit").length).toBe(1);
    expect(chat.at(-1)).toMatchObject({ type: "session_status", status: "disconnected" });
    await expect(ctx.adapter.sendTurn({ sessionId, text: "x" })).rejects.toMatchObject({ code: "E_INTERNAL" });
    await ctx.adapter.resume(sessionId);
    const s2 = ctx.stream();
    expect(s2).not.toBe(s1);
    const resumeArgs = s2.options.args ?? [];
    expect(resumeArgs).toContain("--resume");
    expect(resumeArgs[resumeArgs.indexOf("--resume") + 1]).toBe(nativeSessionId);
    expect(ctx.chat(sessionId).at(-1)).toMatchObject({ type: "session_status", status: "idle" });
    await ctx.adapter.sendTurn({ sessionId, text: "暗号是什么" });
    expect(s2.sentUsers).toEqual(["暗号是什么"]);
    playTextTurn(s2, "msg-2", "琥珀象9号");
    expect(ctx.chat(sessionId).filter((e) => e.type === "turn_completed").length).toBe(2);
  });

  it("dispose 全局保留会话状态（resume 可用）；dispose 单会话移除状态", async () => {
    const ctx = makeAdapter();
    hookRoots.push(ctx.hookDir);
    const a = await ctx.adapter.createSession({ cwd: CWD });
    await ctx.adapter.dispose();
    expect(ctx.chat(a.sessionId).some((e) => e.type === "session_exit")).toBe(true);
    await ctx.adapter.resume(a.sessionId); // 状态保留：可恢复
    expect(ctx.stream().options.args).toContain("--resume");

    const b = makeAdapter();
    hookRoots.push(b.hookDir);
    const s = await b.adapter.createSession({ cwd: CWD });
    await b.adapter.dispose({ sessionId: s.sessionId });
    await expect(b.adapter.readHistory(s.sessionId)).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
  });
});

describe("ClaudeAdapter：hook verified 双信号与 T5 反例", () => {
  /** 向会话 hook-events.jsonl 追加一行（模拟注入 hook 捕获脚本落盘） */
  function appendHookLine(hookDir: string, sessionId: string, nativeSessionId: string, skill: string, capturedAt: string): void {
    const file = path.join(hookDir, sessionId, "hook-events.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({ capturedAt, hookEventName: "PreToolUse", sessionId: nativeSessionId, toolName: "Skill", toolInput: { skill } })}\n`,
      { flag: "a" },
    );
  }

  it("流内 tool_use:Skill → self_reported；hook 行 → verified（形状过 C2 契约、eventId 确定性、native→应用侧映射）", async () => {
    const ctx = makeAdapter();
    hookRoots.push(ctx.hookDir);
    const { sessionId, nativeSessionId } = await ctx.adapter.createSession({ cwd: CWD });
    await ctx.adapter.sendTurn({ sessionId, text: "/design-feature" });
    const s = ctx.stream();
    // 流内信号：assistant tool_use Skill
    s.emit({ type: "assistant", message: { id: "msg-1", role: "assistant", content: [{ type: "tool_use", id: "call-s1", name: "Skill", input: { skill: "design-feature" } }] }, session_id: nativeSessionId });
    let obs = ctx.skills(sessionId);
    expect(obs).toHaveLength(1);
    expect(skillObservationSchema.parse(obs[0])).toMatchObject({
      kind: "skill",
      sessionId,
      cli: "claude-code",
      skill: "design-feature",
      evidenceLevel: "self_reported",
      source: "claude-stream",
    });
    // hook 信号：verified 升级（经消息驱动 tail 消费）
    appendHookLine(ctx.hookDir, sessionId, nativeSessionId!, "design-feature", "2026-11-05T10:00:00.000Z");
    s.emit({ type: "assistant", message: { id: "msg-2", role: "assistant", content: [{ type: "text", text: "执行中" }] }, session_id: nativeSessionId });
    obs = ctx.skills(sessionId);
    expect(obs).toHaveLength(2);
    expect(skillObservationSchema.parse(obs[1])).toMatchObject({
      sessionId,
      evidenceLevel: "verified",
      source: "claude-hook",
      eventId: `hook:${nativeSessionId}:design-feature:2026-11-05T10:00:00.000Z`,
    });
    // 同一行重复消费（重放）→ eventId 幂等跳过：再次触发 tail 不新增
    s.emit({ type: "assistant", message: { id: "msg-3", role: "assistant", content: [{ type: "text", text: "完成" }] }, session_id: nativeSessionId });
    playTextTurn(s, "msg-4", "结束");
    expect(ctx.skills(sessionId)).toHaveLength(2);
  });

  it("T5 反例：普通文本提及 skill（无 tool_use、无 hook 行）→ 零观察信号", async () => {
    const ctx = makeAdapter();
    hookRoots.push(ctx.hookDir);
    const { sessionId } = await ctx.adapter.createSession({ cwd: CWD });
    await ctx.adapter.sendTurn({ sessionId, text: "我知道有个 skill 叫 design-feature，但不要执行" });
    playTextTurn(ctx.stream(), "msg-1", "好的，不执行");
    expect(ctx.skills(sessionId)).toHaveLength(0);
  });

  it("hook 行属他会话（native id 不匹配）→ 不误认", async () => {
    const ctx = makeAdapter();
    hookRoots.push(ctx.hookDir);
    const a = await ctx.adapter.createSession({ cwd: CWD });
    await ctx.adapter.sendTurn({ sessionId: a.sessionId, text: "x" });
    appendHookLine(ctx.hookDir, a.sessionId, "native-other", "design-feature", "2026-11-05T11:00:00.000Z");
    ctx.stream().emit({ type: "assistant", message: { id: "m", role: "assistant", content: [{ type: "text", text: "hi" }] }, session_id: a.nativeSessionId! });
    expect(ctx.skills()).toHaveLength(0);
  });
});

describe("ClaudeAdapter：readHistory transcript 直读回填", () => {
  const configRoot = mkdtempSync(path.join(tmpdir(), "kb-claude-cfg-"));
  const realCwd = mkdtempSync(path.join(tmpdir(), "kb-claude-cwd-"));
  const munged = realCwd.replace(/[:\\ /]/g, "-");

  beforeEach(() => {
    process.env.CLAUDE_CONFIG_DIR = configRoot;
  });
  afterEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  /** 写 native transcript（真实布局 projects/<munged>/<id>.jsonl） */
  function writeTranscript(nativeId: string, lines: unknown[]): string {
    const dir = path.join(configRoot, "projects", munged);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${nativeId}.jsonl`);
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    return file;
  }

  it("快照回填未见轮次 + 与实时流同键去重（已见轮不重复）+ 增量无缝拼接", async () => {
    const ctx = makeAdapter();
    hookRoots.push(ctx.hookDir);
    const { sessionId, nativeSessionId } = await ctx.adapter.createSession({ cwd: realCwd });
    // 实时见第 1 轮（msg-live-1）
    await ctx.adapter.sendTurn({ sessionId, text: "第一轮" });
    playTextTurn(ctx.stream(), "msg-live-1", "实时已见");
    // transcript 含第 1 轮（同键）+ 第 2 轮（适配器未见过——模拟断开期间他处续跑）
    writeTranscript(nativeSessionId!, [
      { type: "user", timestamp: "2026-11-05T01:00:00.000Z", message: { role: "user", content: "第一轮" } },
      { type: "assistant", timestamp: "2026-11-05T01:00:05.000Z", message: { id: "msg-live-1", role: "assistant", content: [{ type: "text", text: "实时已见" }] } },
      { type: "user", timestamp: "2026-11-05T02:00:00.000Z", message: { role: "user", content: "第二轮" } },
      { type: "assistant", timestamp: "2026-11-05T02:00:05.000Z", message: { id: "msg-backfill-1", role: "assistant", content: [{ type: "tool_use", id: "call-b1", name: "Bash", input: { command: "echo hi" } }] } },
      { type: "user", timestamp: "2026-11-05T02:00:06.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-b1", content: "hi", is_error: false }] } },
      { type: "assistant", timestamp: "2026-11-05T02:00:09.000Z", message: { id: "msg-backfill-2", role: "assistant", content: [{ type: "text", text: "回填文本" }] } },
    ]);
    const snapshot = await ctx.adapter.readHistory(sessionId);
    // 已见轮不重复：msg-live-1 相关事件只出现一次；回填轮新增 turn_started/delta/completed/tool 事件
    const liveDeltas = snapshot.filter((e) => e.type === "message_delta" && e.itemId === "msg-live-1");
    expect(liveDeltas).toHaveLength(2); // 「实时」「已见」两段 delta（流式 2 段 + 无自愈补发）
    expect(snapshot.some((e) => e.type === "message_delta" && e.itemId === "msg-backfill-2" && e.delta === "回填文本")).toBe(true);
    expect(snapshot.some((e) => e.type === "tool_started" && e.itemId === "call-b1")).toBe(true);
    expect(snapshot.some((e) => e.type === "tool_completed" && e.itemId === "call-b1")).toBe(true);
    // 回填轮成对 turn_started/turn_completed
    const starts = snapshot.filter((e) => e.type === "turn_started");
    const completions = snapshot.filter((e) => e.type === "turn_completed");
    expect(starts.length).toBe(2);
    expect(completions.length).toBe(2);
    // 快照后实时增量：seq 全部大于快照最大值（无缝拼接，不变量 4）
    const maxSeq = Math.max(...snapshot.map((e) => e.seq));
    const beforeIdx = ctx.events.length;
    await ctx.adapter.sendTurn({ sessionId, text: "第三轮" });
    playTextTurn(ctx.stream(), "msg-live-3", "新增量");
    const live = ctx.events.slice(beforeIdx).filter((e): e is ChatEvent => "type" in e && e.sessionId === sessionId);
    for (const e of live) expect(e.seq).toBeGreaterThan(maxSeq);
    const final = await ctx.adapter.readHistory(sessionId);
    const merged = [...snapshot, ...live].map((e) => e.seq);
    expect(new Set(merged).size).toBe(merged.length);
    expect(merged.length).toBe(final.length);
  });

  it("adoptSession（应用重启收养）：无进程先 readHistory 直读 transcript；resume 后可续问", async () => {
    // 会话 A：真实跑一轮后进程死亡
    const a = makeAdapter();
    hookRoots.push(a.hookDir);
    const created = await a.adapter.createSession({ cwd: realCwd });
    await a.adapter.sendTurn({ sessionId: created.sessionId, text: "埋暗号" });
    playTextTurn(a.stream(), "msg-a1", "暗号是紫鲸7号");
    a.stream().simulateExit(0);
    // mock 世界由 CLI 落盘 transcript：模拟真实归档（msg id 与实时流一致 → 同键去重依据）
    writeTranscript(created.nativeSessionId!, [
      { type: "user", timestamp: "2026-11-05T01:00:00.000Z", message: { role: "user", content: "埋暗号" } },
      { type: "assistant", timestamp: "2026-11-05T01:00:05.000Z", message: { id: "msg-a1", role: "assistant", content: [{ type: "text", text: "暗号是紫鲸7号" }] } },
    ]);
    // 应用重启：全新 adapter 实例，按 DB 持久化的 native id 收养
    const b = makeAdapter();
    hookRoots.push(b.hookDir);
    await b.adapter.adoptSession({ sessionId: created.sessionId, nativeSessionId: created.nativeSessionId!, cwd: realCwd });
    await expect(b.adapter.sendTurn({ sessionId: created.sessionId, text: "x" })).rejects.toMatchObject({ code: "E_INTERNAL" }); // 未 resume 前不可发
    const history = await b.adapter.readHistory(created.sessionId);
    expect(history.some((e) => e.type === "message_delta" && e.delta === "暗号是紫鲸7号")).toBe(true);
    expect(history.some((e) => e.type === "turn_completed")).toBe(true);
    await b.adapter.resume(created.sessionId);
    const s = b.stream();
    const resumeArgs = s.options.args ?? [];
    expect(resumeArgs[resumeArgs.indexOf("--resume") + 1]).toBe(created.nativeSessionId);
    await b.adapter.sendTurn({ sessionId: created.sessionId, text: "暗号是什么" });
    playTextTurn(s, "msg-b1", "紫鲸7号");
    // 回填轮（transcript 第 1 轮）+ 续问轮（实时）= 2 个 turn_completed
    expect(b.chat(created.sessionId).filter((e) => e.type === "turn_completed").length).toBe(2);
  });

  it("数组形态用户行（claude 2.1.317+ transcript）：含 text 块即分轮，助手文本回填不丢失", async () => {
    const ctx = makeAdapter();
    hookRoots.push(ctx.hookDir);
    const { sessionId, nativeSessionId } = await ctx.adapter.createSession({ cwd: realCwd });
    writeTranscript(nativeSessionId!, [
      // 用户输入为 text 块数组（真实 2.1.317 落盘形态）
      { type: "user", timestamp: "2026-11-05T01:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "埋暗号" }] } },
      { type: "assistant", timestamp: "2026-11-05T01:00:05.000Z", message: { id: "msg-arr-1", role: "assistant", content: [{ type: "text", text: "暗号是紫鲸7号" }] } },
      // 工具结果数组行：不另起轮
      { type: "user", timestamp: "2026-11-05T01:00:06.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t-9", content: "ok" }] } },
    ]);
    ctx.stream().simulateExit(0); // 进程死亡：readHistory 走 transcript 直读回填
    const history = await ctx.adapter.readHistory(sessionId);
    expect(history.some((e) => e.type === "message_delta" && e.delta === "暗号是紫鲸7号")).toBe(true);
    expect(history.some((e) => e.type === "turn_completed")).toBe(true);
  });
});

describe("ClaudeAdapter：readTranscript 双视角（#28）", () => {
  const configRoot = mkdtempSync(path.join(tmpdir(), "kb-claude-tr-"));
  const realCwd = mkdtempSync(path.join(tmpdir(), "kb-claude-trcwd-"));
  const munged = realCwd.replace(/[:\\ /]/g, "-");

  beforeEach(() => {
    process.env.CLAUDE_CONFIG_DIR = configRoot;
  });
  afterEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  /** 写 native transcript（真实布局 projects/<munged>/<id>.jsonl） */
  function writeTranscript(nativeId: string, lines: unknown[]): string {
    const dir = path.join(configRoot, "projects", munged);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${nativeId}.jsonl`);
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    return file;
  }

  function makeTrAdapter() {
    const hookDir = mkdtempSync(path.join(tmpdir(), "kb-claude-trhook-"));
    hookRoots.push(hookDir);
    const adapter = new ClaudeAdapter({ hookDir, clientFactory: (options) => new FakeStream(options) });
    return { adapter, hookDir };
  }

  it("user 行不再是轮边界丢弃物：产出 user/assistant 双视角 + 工具标注（string 与数组两种用户行形态）", async () => {
    const { adapter } = makeTrAdapter();
    const { sessionId, nativeSessionId } = await adapter.createSession({ cwd: realCwd });
    writeTranscript(nativeSessionId!, [
      // string 形态用户行（旧落盘形态）
      { type: "user", timestamp: "2026-11-05T01:00:00.000Z", message: { role: "user", content: "第一轮：请跑测试" } },
      { type: "assistant", timestamp: "2026-11-05T01:00:05.000Z", message: { id: "msg-t1", role: "assistant", content: [{ type: "text", text: "好的，开始跑测试。" }] } },
      // 数组形态用户行（2.1.317+ 落盘形态）
      { type: "user", timestamp: "2026-11-05T02:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "第二轮：请修复失败用例" }] } },
      { type: "assistant", timestamp: "2026-11-05T02:00:05.000Z", message: { id: "msg-t2", role: "assistant", content: [{ type: "tool_use", id: "call-t1", name: "Bash", input: { command: "pnpm vitest run" } }] } },
      // 工具结果用户行（非用户发言）：不产生 user 事件
      { type: "user", timestamp: "2026-11-05T02:00:06.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-t1", content: "2 passed" }] } },
      { type: "assistant", timestamp: "2026-11-05T02:00:09.000Z", message: { id: "msg-t3", role: "assistant", content: [{ type: "text", text: "已修复。" }] } },
      // sidechain 行：跳过
      { type: "assistant", timestamp: "2026-11-05T03:00:00.000Z", isSidechain: true, message: { id: "msg-sc", role: "assistant", content: [{ type: "text", text: "sidechain 不算" }] } },
    ]);
    const transcript = await adapter.readTranscript(sessionId);
    expect(transcript).toEqual([
      { role: "user", text: "第一轮：请跑测试" },
      { role: "assistant", text: "好的，开始跑测试。" },
      { role: "user", text: "第二轮：请修复失败用例" },
      { role: "assistant", text: "", tool: { name: "Bash", summary: JSON.stringify({ command: "pnpm vitest run" }) } },
      { role: "assistant", text: "已修复。" },
    ]);
  });

  it("无 transcript 文件（尚无 turn 的会话）→ 空数组（诚实空历史，不冒充）", async () => {
    const { adapter } = makeTrAdapter();
    const { sessionId } = await adapter.createSession({ cwd: realCwd });
    const transcript = await adapter.readTranscript(sessionId);
    expect(transcript).toEqual([]);
  });

  it("未知会话 → E_SESSION_NOT_FOUND", async () => {
    const { adapter } = makeTrAdapter();
    await expect(adapter.readTranscript("nope")).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
  });
});
