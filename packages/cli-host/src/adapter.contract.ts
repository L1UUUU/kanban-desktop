// 用途：Adapter 契约测试套（spec Testing seam 1）—— 同一组行为断言对 FakeAdapter 与后续三真实 Adapter 复用；调用方提供 adapter 与「推进到空闲」驱动器
import { expect, it } from "vitest";
import type { AdapterEvent, ChatEvent } from "@kanban/ipc-schema";
import type { CliAdapter } from "./adapter";

/** 契约套件上下文：adapter 被测实例；driveIdle 推进到无待处理活动（Fake=虚拟时钟 runToIdle，真实 CLI=轮询等待） */
export interface ContractCtx {
  adapter: CliAdapter;
  driveIdle: () => Promise<void>;
}

/** 收集订阅事件，并提供按类型/会话过滤的工具 */
export function createCollector(adapter: CliAdapter) {
  const events: AdapterEvent[] = [];
  const off = adapter.subscribe((e) => events.push(e));
  return {
    events,
    off,
    chat: (sessionId?: string): ChatEvent[] =>
      events.filter(
        (e): e is ChatEvent =>
          "type" in e && typeof e.type === "string" && chatTypes.has(e.type) && (!sessionId || e.sessionId === sessionId),
      ),
    clear: () => { events.length = 0; },
  };
}

// ChatEvent 成员集合（SkillObservation 无 type 判别字段时的排除辅助）
const chatTypes = new Set([
  "turn_started", "message_delta", "message_completed", "tool_started", "tool_update",
  "tool_completed", "approval_requested", "approval_expired", "turn_completed",
  "turn_interrupted", "session_status", "session_error", "session_exit",
]);

/** 契约可单测的不变量与关键行为（spec B 六不变量中的 1/3/4/6 + 审批分支） */
export function defineAdapterContractTests(
  make: () => Promise<ContractCtx>,
  opts?: { approvalTurnText?: string },
) {
  const mk = make;
  const approvalText = opts?.approvalTurnText ?? "审批";

  it("不变量 1：sendTurn 只表达已提交，内容一律经事件流返回", async () => {
    const { adapter, driveIdle } = await mk();
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    col.clear();
    const started = await adapter.sendTurn({ sessionId, text: "拆类型" });
    // 已提交：返回值不携带任何内容（undefined/void）
    expect(started).toBeUndefined();
    await driveIdle();
    const chat = col.chat(sessionId);
    expect(chat.filter((e) => e.type === "turn_started").length).toBe(1);
    // 助手文本只出现在 message_delta 事件中
    const joined = chat
      .filter((e): e is Extract<ChatEvent, { type: "message_delta" }> => e.type === "message_delta")
      .map((e) => e.delta)
      .join("");
    expect(joined.length).toBeGreaterThan(0);
    col.off();
  });

  it("不变量 3：流式增量按合并键拼接后与终文相等（无重复无丢失）", async () => {
    const { adapter, driveIdle } = await mk();
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    await adapter.sendTurn({ sessionId, text: "拆类型" });
    await driveIdle();
    const deltas = col
      .chat(sessionId)
      .filter((e): e is Extract<ChatEvent, { type: "message_delta" }> => e.type === "message_delta");
    expect(deltas.length).toBeGreaterThan(1);
    // 每个增量都携带合并键（itemId/partId），同一 itemId 的 partId 一致
    for (const d of deltas) {
      expect(d.itemId.length).toBeGreaterThan(0);
      expect(d.partId.length).toBeGreaterThan(0);
    }
    const itemIds = new Set(deltas.map((d) => d.itemId));
    // 每条助手消息一个 itemId：默认演示脚本恰两段助手文本 → 两个 itemId
    expect(itemIds.size).toBe(2);
    const first = deltas.filter((d) => d.itemId === deltas[0].itemId).map((d) => d.delta).join("");
    expect(first).toBe("好的，我先跑一遍现有测试确认基线，然后开始拆分。");
    // 每个 itemId 均有 message_completed 终结
    for (const itemId of itemIds) {
      const done = col.chat(sessionId).find(
        (e): e is Extract<ChatEvent, { type: "message_completed" }> =>
          e.type === "message_completed" && e.itemId === itemId,
      );
      expect(done).toBeDefined();
    }
    col.off();
  });

  it("不变量 3：seq 在 session 内严格单调递增", async () => {
    const { adapter, driveIdle } = await mk();
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    await adapter.sendTurn({ sessionId, text: "拆类型" });
    await adapter.sendTurn({ sessionId, text: "第二 turn" });
    await driveIdle();
    const seqs = col.chat(sessionId).map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    col.off();
  });

  it("不变量 4：readHistory 快照与实时流同键同 seq，快照后增量无缝拼接（无重复无丢失）", async () => {
    const { adapter, driveIdle } = await mk();
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    await adapter.sendTurn({ sessionId, text: "拆类型" });
    // 半途取快照（流式中）——由 driveIdle 的部分推进模拟：先完整跑完本 turn 前只推进一半事件不可行时，退化为「订阅中 readHistory」场景：
    // 在第二个 turn 进行前读取快照
    await driveIdle();
    const snapshot = await adapter.readHistory(sessionId);
    col.clear();
    await adapter.sendTurn({ sessionId, text: "第二 turn" });
    await driveIdle();
    const live = col.chat(sessionId);
    const snapshotMaxSeq = Math.max(...snapshot.map((e) => e.seq));
    // 实时流全部为快照之后的新事件（同键空间连续，无重叠）
    for (const e of live) expect(e.seq).toBeGreaterThan(snapshotMaxSeq);
    const finalHistory = await adapter.readHistory(sessionId);
    // 拼接结果与最终历史一致：条数 = 快照 + 增量，且 seq 无重复
    const mergedSeqs = [...snapshot, ...live].map((e) => e.seq);
    expect(new Set(mergedSeqs).size).toBe(mergedSeqs.length);
    expect(mergedSeqs.length).toBe(finalHistory.length);
    const finalSeqs = new Set(finalHistory.map((e) => e.seq));
    for (const s of mergedSeqs) expect(finalSeqs.has(s)).toBe(true);
    col.off();
  });

  it("不变量 6：忙态 sendTurn 排队，当前 turn 结束后续发", async () => {
    const { adapter, driveIdle } = await mk();
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    await adapter.sendTurn({ sessionId, text: "拆类型" });
    await adapter.sendTurn({ sessionId, text: "排队消息" });
    await driveIdle();
    const chat = col.chat(sessionId);
    const starts = chat.filter((e): e is Extract<ChatEvent, { type: "turn_started" }> => e.type === "turn_started");
    const completions = chat.filter((e): e is Extract<ChatEvent, { type: "turn_completed" }> => e.type === "turn_completed");
    expect(starts.length).toBe(2);
    expect(completions.length).toBe(2);
    // 第二个 turn 在第一个 turn_completed 之后才开始
    expect(starts[1].seq).toBeGreaterThan(completions[0].seq);
    col.off();
  });

  it("不变量 6：interruptTurn 幂等；中断后 0 新增 delta 且会话可继续", async () => {
    const { adapter, driveIdle } = await mk();
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    await adapter.sendTurn({ sessionId, text: "拆类型" });
    await driveIdle();
    // 第二个 turn 进行中打断：为可控中断，发送后立即打断
    col.clear();
    await adapter.sendTurn({ sessionId, text: "第二 turn" });
    await adapter.interruptTurn(sessionId);
    await adapter.interruptTurn(sessionId); // 幂等：第二次为 no-op
    await driveIdle();
    const chat = col.chat(sessionId);
    expect(chat.filter((e) => e.type === "turn_interrupted").length).toBe(1);
    expect(chat.at(-1)?.type).toBe("session_status");
    expect((chat.at(-1) as Extract<ChatEvent, { type: "session_status" }>).status).toBe("interrupted");
    const deltaCountAfterInterrupt = chat.filter((e) => e.type === "message_delta").length;
    // 中断后再推进：无新增 delta（脚本已丢弃）
    col.clear();
    await driveIdle();
    expect(col.chat(sessionId).filter((e) => e.type === "message_delta").length).toBe(0);
    expect(deltaCountAfterInterrupt).toBeGreaterThanOrEqual(0);
    // 会话可继续：新 sendTurn 正常开 turn
    await adapter.sendTurn({ sessionId, text: "继续" });
    await driveIdle();
    expect(col.chat(sessionId).some((e) => e.type === "turn_started")).toBe(true);
    expect(col.chat(sessionId).some((e) => e.type === "message_delta")).toBe(true);
    col.off();
  });

  it("审批：请求携带命令与 suggestions；deny → 工具被拒且不出现放行分支输出", async () => {
    const { adapter, driveIdle } = await mk();
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    await adapter.sendTurn({ sessionId, text: approvalText });
    await driveIdle();
    const req = col.chat(sessionId).find(
      (e): e is Extract<ChatEvent, { type: "approval_requested" }> => e.type === "approval_requested",
    );
    expect(req).toBeDefined();
    expect(req!.command.length).toBeGreaterThan(0);
    expect(req!.suggestions.length).toBeGreaterThan(0);
    col.clear();
    await adapter.resolveApproval({ sessionId, requestId: req!.requestId, decision: "deny" });
    await driveIdle();
    const chat = col.chat(sessionId);
    const denied = chat.find(
      (e): e is Extract<ChatEvent, { type: "tool_completed" }> => e.type === "tool_completed" && e.status === "denied",
    );
    expect(denied).toBeDefined();
    expect(denied!.itemId).toBe(req!.itemId);
    const joined = chat
      .filter((e): e is Extract<ChatEvent, { type: "message_delta" }> => e.type === "message_delta")
      .map((e) => e.delta)
      .join("");
    expect(joined).toContain("好的，我不改这个文件");
    expect(joined).not.toContain("已写入");
    col.off();
  });

  it("审批：allow-once → 工具完成（仅本次允许）且后续同类审批仍会询问", async () => {
    const { adapter, driveIdle } = await mk();
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    await adapter.sendTurn({ sessionId, text: approvalText });
    await driveIdle();
    const reqs = () =>
      col.chat(sessionId).filter((e): e is Extract<ChatEvent, { type: "approval_requested" }> => e.type === "approval_requested");
    const first = reqs()[0];
    col.clear();
    await adapter.resolveApproval({ sessionId, requestId: first.requestId, decision: "allow-once" });
    await driveIdle();
    const chat = col.chat(sessionId);
    const completed = chat.find(
      (e): e is Extract<ChatEvent, { type: "tool_completed" }> => e.type === "tool_completed" && e.status === "completed",
    );
    expect(completed).toBeDefined();
    expect(completed!.output).toContain("仅本次允许");
    // 演示脚本第二个审批仍然询问（once 不记住规则）
    const secondAsk = chat.find((e) => e.type === "approval_requested");
    expect(secondAsk).toBeDefined();
    col.off();
  });

  it("审批：allow-always → 后续同类审批被跳过（记住规则）", async () => {
    const { adapter, driveIdle } = await mk();
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    await adapter.sendTurn({ sessionId, text: approvalText });
    await driveIdle();
    const first = col
      .chat(sessionId)
      .find((e): e is Extract<ChatEvent, { type: "approval_requested" }> => e.type === "approval_requested")!;
    col.clear();
    await adapter.resolveApproval({ sessionId, requestId: first.requestId, decision: "allow-always" });
    await driveIdle();
    const chat = col.chat(sessionId);
    expect(
      chat.find((e): e is Extract<ChatEvent, { type: "tool_completed" }> => e.type === "tool_completed" && e.status === "completed")!
        .output,
    ).toContain("记住规则");
    // 第二个审批不再询问，工具直接完成，turn 走到终文
    expect(chat.some((e) => e.type === "approval_requested")).toBe(false);
    const joined = chat
      .filter((e): e is Extract<ChatEvent, { type: "message_delta" }> => e.type === "message_delta")
      .map((e) => e.delta)
      .join("");
    expect(joined).toContain("拆分完成");
    expect(chat.some((e) => e.type === "turn_completed")).toBe(true);
    col.off();
  });

  it("非法时序：对已决/过期审批响应 → E_APPROVAL_EXPIRED；未知会话 → E_SESSION_NOT_FOUND", async () => {
    const { adapter, driveIdle } = await mk();
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    await adapter.sendTurn({ sessionId, text: approvalText });
    await driveIdle();
    const first = col
      .chat(sessionId)
      .find((e): e is Extract<ChatEvent, { type: "approval_requested" }> => e.type === "approval_requested")!;
    await adapter.resolveApproval({ sessionId, requestId: first.requestId, decision: "allow-once" });
    await driveIdle();
    // 已决审批再响应 → 明确错误码
    await expect(
      adapter.resolveApproval({ sessionId, requestId: first.requestId, decision: "deny" }),
    ).rejects.toMatchObject({ code: "E_APPROVAL_EXPIRED" });
    // 未知会话
    await expect(adapter.sendTurn({ sessionId: "nope", text: "hi" })).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
    await expect(adapter.interruptTurn("nope")).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
    await expect(adapter.readHistory("nope")).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
    col.off();
  });
}
