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

/** 契约可单测的不变量与关键行为（spec B 六不变量中的 1/3/4/6 + 审批分支）
 *  opts 默认值 = FakeAdapter 演示脚本行为；真实 CLI 实现传通用化断言（输出不可控处放宽，副作用以 verify 钩子断言） */
export interface ContractOptions {
  /** 触发审批的 turn 文本（Fake 默认「审批」） */
  approvalTurnText?: string;
  /** 常规 turn 文本（默认「拆类型」） */
  turnText?: string;
  /** 第二 turn 文本（默认「第二 turn」） */
  secondTurnText?: string;
  /** 中断场景 turn 文本（真实 CLI 须用长任务确保可中断；默认同 secondTurnText） */
  interruptTurnText?: string;
  /** 助手消息条数断言：缺省精确 2（Fake 脚本）；真实 CLI 传 { atLeast: 1 } */
  assistantMessages?: { exactly?: number; atLeast?: number };
  /** 首段助手终文断言（缺省 Fake 终文；null 跳过——真实 CLI 输出不可控） */
  firstAssistantText?: string | null;
  /** 审批建议项是否必须非空（默认 true；真实 CLI 的 amendment 可选） */
  suggestionsRequired?: boolean;
  /** 审批场景会话权限档（缺省不传=各实现默认；真实 Codex 须传 "ask"（untrusted）保证审批必弹） */
  approvalPermMode?: "ask" | "auto" | "full";
  /** 会话 cwd（缺省 "C:\\demo" 占位——Fake 不看 cwd；真实 CLI 执行命令须传真实存在的目录） */
  cwd?: string;
  /** deny 分支断言（文案 + 文件系统副作用 verify 钩子） */
  deny?: { contains?: string[]; notContains?: string[]; verify?: () => Promise<void> };
  /** allow-once 分支断言 */
  once?: { outputContains?: string[]; expectSecondAsk?: boolean; verify?: () => Promise<void> };
  /** allow-always 分支断言 */
  always?: { outputContains?: string[]; finalContains?: string[]; expectNoSecondAsk?: boolean; verify?: () => Promise<void> };
}

export function defineAdapterContractTests(
  make: () => Promise<ContractCtx>,
  opts?: ContractOptions,
) {
  const approvalText = opts?.approvalTurnText ?? "审批";
  const turnText = opts?.turnText ?? "拆类型";
  const secondText = opts?.secondTurnText ?? "第二 turn";
  const interruptText = opts?.interruptTurnText ?? secondText;
  const firstText = opts?.firstAssistantText !== undefined ? opts.firstAssistantText : "好的，我先跑一遍现有测试确认基线，然后开始拆分。";
  const suggestionsRequired = opts?.suggestionsRequired ?? true;
  const contractCwd = opts?.cwd ?? "C:\\demo";

  it("不变量 1：sendTurn 只表达已提交，内容一律经事件流返回", async () => {
    const { adapter, driveIdle } = await make();
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: contractCwd });
    col.clear();
    const started = await adapter.sendTurn({ sessionId, text: turnText });
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
    const { adapter, driveIdle } = await make();
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: contractCwd });
    await adapter.sendTurn({ sessionId, text: turnText });
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
    // 每条助手消息一个 itemId：Fake 演示脚本恰两段助手文本；真实 CLI 输出条数不可控 → atLeast
    if (opts?.assistantMessages?.atLeast !== undefined) {
      expect(itemIds.size).toBeGreaterThanOrEqual(opts.assistantMessages.atLeast);
    } else {
      expect(itemIds.size).toBe(opts?.assistantMessages?.exactly ?? 2);
    }
    if (firstText !== null) {
      const first = deltas.filter((d) => d.itemId === deltas[0].itemId).map((d) => d.delta).join("");
      expect(first).toBe(firstText);
    }
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
    const { adapter, driveIdle } = await make();
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: contractCwd });
    await adapter.sendTurn({ sessionId, text: turnText });
    await adapter.sendTurn({ sessionId, text: secondText });
    await driveIdle();
    const seqs = col.chat(sessionId).map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    col.off();
  });

  it("不变量 4：readHistory 快照与实时流同键同 seq，快照后增量无缝拼接（无重复无丢失）", async () => {
    const { adapter, driveIdle } = await make();
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: contractCwd });
    await adapter.sendTurn({ sessionId, text: turnText });
    // 半途取快照（流式中）——由 driveIdle 的部分推进模拟：先完整跑完本 turn 前只推进一半事件不可行时，退化为「订阅中 readHistory」场景：
    // 在第二个 turn 进行前读取快照
    await driveIdle();
    const snapshot = await adapter.readHistory(sessionId);
    col.clear();
    await adapter.sendTurn({ sessionId, text: secondText });
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
    const { adapter, driveIdle } = await make();
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: contractCwd });
    await adapter.sendTurn({ sessionId, text: turnText });
    await adapter.sendTurn({ sessionId, text: secondText });
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
    const { adapter, driveIdle } = await make();
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: contractCwd });
    await adapter.sendTurn({ sessionId, text: turnText });
    await driveIdle();
    // 第二个 turn 进行中打断：为可控中断，发送后立即打断（真实 CLI 用长任务 prompt 保证 turn 在跑）
    col.clear();
    await adapter.sendTurn({ sessionId, text: interruptText });
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
    await adapter.sendTurn({ sessionId, text: "继续" });    await driveIdle();
    expect(col.chat(sessionId).some((e) => e.type === "turn_started")).toBe(true);
    expect(col.chat(sessionId).some((e) => e.type === "message_delta")).toBe(true);
    col.off();
  });

  it("审批：请求携带命令与 suggestions；deny → 工具被拒且不出现放行分支输出", async () => {
    const { adapter, driveIdle } = await make();
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: contractCwd, permMode: opts?.approvalPermMode });
    await adapter.sendTurn({ sessionId, text: approvalText });
    await driveIdle();
    const req = col.chat(sessionId).find(
      (e): e is Extract<ChatEvent, { type: "approval_requested" }> => e.type === "approval_requested",
    );
    expect(req).toBeDefined();
    expect(req!.command.length).toBeGreaterThan(0);
    if (suggestionsRequired) expect(req!.suggestions.length).toBeGreaterThan(0);
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
    for (const c of opts?.deny?.contains ?? ["好的，我不改这个文件"]) expect(joined).toContain(c);
    for (const nc of opts?.deny?.notContains ?? ["已写入"]) expect(joined).not.toContain(nc);
    await opts?.deny?.verify?.(); // 真实 CLI：deny 后命令确未执行的文件系统副作用断言
    col.off();
  });

  it("审批：allow-once → 工具完成（仅本次允许）且后续同类审批仍会询问", async () => {
    const { adapter, driveIdle } = await make();
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: contractCwd, permMode: opts?.approvalPermMode });
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
    for (const c of opts?.once?.outputContains ?? ["仅本次允许"]) expect(completed!.output).toContain(c);
    await opts?.once?.verify?.(); // 真实 CLI：accept 后命令真执行的文件系统副作用断言
    // 演示脚本第二个审批仍然询问（once 不记住规则）；真实 CLI 用双命令 prompt 触发第二问
    if (opts?.once?.expectSecondAsk !== false) {
      const secondAsk = chat.find((e) => e.type === "approval_requested");
      expect(secondAsk).toBeDefined();
    }
    col.off();
  });

  it("审批：allow-always → 后续同类审批被跳过（记住规则）", async () => {
    const { adapter, driveIdle } = await make();
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: contractCwd, permMode: opts?.approvalPermMode });
    await adapter.sendTurn({ sessionId, text: approvalText });
    await driveIdle();
    const first = col
      .chat(sessionId)
      .find((e): e is Extract<ChatEvent, { type: "approval_requested" }> => e.type === "approval_requested")!;
    col.clear();
    await adapter.resolveApproval({ sessionId, requestId: first.requestId, decision: "allow-always" });
    await driveIdle();
    const chat = col.chat(sessionId);
    const doneTool = chat.find(
      (e): e is Extract<ChatEvent, { type: "tool_completed" }> => e.type === "tool_completed" && e.status === "completed",
    );
    expect(doneTool).toBeDefined();
    for (const c of opts?.always?.outputContains ?? ["记住规则"]) expect(doneTool!.output).toContain(c);
    // 第二个审批不再询问，工具直接完成，turn 走到终文
    if (opts?.always?.expectNoSecondAsk !== false) {
      expect(chat.some((e) => e.type === "approval_requested")).toBe(false);
    }
    const joined = chat
      .filter((e): e is Extract<ChatEvent, { type: "message_delta" }> => e.type === "message_delta")
      .map((e) => e.delta)
      .join("");
    for (const c of opts?.always?.finalContains ?? ["拆分完成"]) expect(joined).toContain(c);
    await opts?.always?.verify?.();
    // turn 终态断言：第二个审批被跳过时 turn 应完成；真实 CLI 若同类仍问（会话级放行范围由 CLI 解释），turn 停在第二个审批等待——不强求
    if (opts?.always?.expectNoSecondAsk !== false) {
      expect(chat.some((e) => e.type === "turn_completed")).toBe(true);
    }
    col.off();
  });

  it("非法时序：对已决/过期审批响应 → E_APPROVAL_EXPIRED；未知会话 → E_SESSION_NOT_FOUND", async () => {
    const { adapter, driveIdle } = await make();
    const col = createCollector(adapter);
    const { sessionId } = await adapter.createSession({ cwd: contractCwd, permMode: opts?.approvalPermMode });
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
