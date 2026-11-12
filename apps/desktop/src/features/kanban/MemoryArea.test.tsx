// 用途：需求经验区组件测试（#33，spec #27 I 节原型一致项 3–8）—— fake memory transport 注入驱动真实组件：零 structured 会话禁用、四步进度与取消、批次卡元信息/缺失警示/failed 重试/cancelled 灰显、proposed 提示条与对比弹层二选一、候选三动作触发 IPC、终态拒绝呈现、冲突提示文案、编辑弹层可编辑字段与只读区、跨批次待审与已处置折叠、事件驱动局部刷新
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  IpcRequest,
  IpcResult,
  MemoryBatchRow,
  MemoryCandidateRow,
  MemoryEventWire,
  MemoryRequest,
  MemoryResult,
  MemorySummaryRow,
  RequirementCardRow,
} from "@kanban/ipc-schema";
import type { ChatTransport } from "../../lib/kanban-api";
import { DetailPanel, type DetailActions } from "./DetailPanel";
import { MemoryArea, type MemorySessionRef } from "./MemoryArea";
import { useRequirementMemory } from "./use-requirement-memory";

// ---------- fixtures ----------

const REQ_ID = "REQ-1";

const CARD: RequirementCardRow = {
  id: REQ_ID,
  title: "供应商列表分页",
  stage: "Implement",
  stageBasis: null,
  uncertain: false,
  projectId: "P1",
  sessions: ["s-struct-1", "s-struct-2"],
};

/** 批次行 fixture（缺省值对齐 wire memoryBatchRowSchema） */
function batch(over: Partial<MemoryBatchRow> & Pick<MemoryBatchRow, "id" | "status">): MemoryBatchRow {
  return {
    requirementId: REQ_ID,
    projectId: "P1",
    sourceSessionCount: 3,
    missingSessions: [],
    chunkCount: 4,
    modelCallCount: 4,
    error: null,
    createdAt: "2026-11-06T01:12:00.000Z",
    finishedAt: null,
    ...over,
  };
}

/** 候选行 fixture（缺省值对齐 wire memoryCandidateRowSchema） */
function cand(over: Partial<MemoryCandidateRow> & Pick<MemoryCandidateRow, "id" | "status">): MemoryCandidateRow {
  return {
    displayNo: `CAND-${over.id?.slice(-4) ?? "0001"}`,
    batchId: "B1",
    requirementId: REQ_ID,
    projectId: "P1",
    claim: "示例结论",
    scope: "packages/memory",
    evidence: "「示例证据摘录…」",
    sourceSessionIds: ["s-struct-1"],
    editedClaim: null,
    editedScope: null,
    reviewedAt: null,
    conflicts: [],
    notes: [],
    mdPath: null,
    createdAt: "2026-11-06T01:13:00.000Z",
    ...over,
  };
}

function summary(over: Partial<MemorySummaryRow> = {}): MemorySummaryRow {
  return {
    requirementId: REQ_ID,
    projectId: "P1",
    mdPath: "C:/data/memory/P1/requirements/REQ-1/summary.md",
    proposedBatchId: null,
    proposedMdPath: null,
    updatedAt: "2026-11-06T01:12:00.000Z",
    title: "供应商列表分页",
    content: "# 总结（人工版当前生效）",
    proposedContent: null,
    ...over,
  };
}

/** fake memory transport：invokeMemory 记录调用 + 可变 seed + 事件发射器（组件测试 seam，参考 DetailPanel.test.tsx transport 注入模式） */
function makeFake(seed?: { batches: MemoryBatchRow[]; candidates: MemoryCandidateRow[]; summary: MemorySummaryRow | null }) {
  const calls: MemoryRequest[] = [];
  const handlers = new Set<(event: MemoryEventWire) => void>();
  const state = seed ?? { batches: [] as MemoryBatchRow[], candidates: [] as MemoryCandidateRow[], summary: null as MemorySummaryRow | null };
  /** 可配置的拒绝（reviewCandidate 终态拒绝等用例） */
  const rejectWith: { review?: { reason: string; detail: string }; edit?: { reason: string; detail: string } } = {};
  const transport: ChatTransport = {
    invoke: async (_req: IpcRequest) => ({ ok: true }) as IpcResult,
    onEvent: () => () => undefined,
    onTerminalEvent: () => () => undefined,
    onTrackerEvent: () => () => undefined,
    invokeMemory: async (req: MemoryRequest): Promise<MemoryResult> => {
      calls.push(req);
      switch (req.channel) {
        case "memory:requirementMemory":
          return { ok: true, batches: state.batches, candidates: state.candidates, summary: state.summary };
        case "memory:extract":
          return { ok: true, started: true, batchId: "B-new" };
        case "memory:cancel":
          return { ok: true, cancelled: true };
        case "memory:reviewCandidate": {
          if (rejectWith.review) return { ok: false, ...rejectWith.review };
          // 成功后同步 seed（候选转终态），验证事件/动作后的局部刷新闭环
          state.candidates = state.candidates.map((c) =>
            c.id === req.candidateId
              ? { ...c, status: req.action === "ignore" ? "ignored" : req.action === "edit" ? "edited" : "accepted", editedClaim: req.edit?.claim ?? null, editedScope: req.edit?.scope ?? null }
              : c,
          );
          return { ok: true, candidate: state.candidates.find((c) => c.id === req.candidateId)! };
        }
        case "memory:resolveSummary":
          state.summary = null; // 处置后暂存清除（US14）→ 刷新后提示条消失
          return { ok: true };
        case "memory:projectMemory":
          return { ok: true, knowledge: [], summaries: [] };
        case "memory:editSummary":
          return { ok: true };
        case "memory:editAccepted": {
          if (rejectWith.edit) return { ok: false, ...rejectWith.edit };
          state.candidates = state.candidates.map((c) =>
            c.id === req.candidateId ? { ...c, status: "edited", editedClaim: req.claim ?? c.editedClaim, editedScope: req.scope ?? c.editedScope } : c,
          );
          return { ok: true, candidate: state.candidates.find((c) => c.id === req.candidateId)! };
        }
      }
    },
    onMemoryEvent: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
  return {
    transport,
    calls,
    rejectWith,
    setData: (next: Partial<typeof state>) => Object.assign(state, next),
    emit: (event: MemoryEventWire) =>
      act(async () => {
        for (const h of handlers) h(event);
      }),
  };
}

/** 挂载组合：hook（useRequirementMemory）+ MemoryArea（生产同构：useKanban 持 hook、面板消费 controller） */
function mountArea(fake: ReturnType<typeof makeFake>, opts?: { card?: RequirementCardRow; sessions?: MemorySessionRef[] }) {
  const card = opts?.card ?? CARD;
  function Harness() {
    const memory = useRequirementMemory(card.id, fake.transport);
    return <MemoryArea card={card} memory={memory} sessions={opts?.sessions ?? []} />;
  }
  render(<Harness />);
}

const DONE = "done";
const RUN = "run";
const TODO = "todo";
const stepState = (key: string): string | null => screen.getByTestId(`memory-step-${key}`).getAttribute("data-state");

afterEach(cleanup);

describe("需求经验区 · 提取按钮与进度（原型一致项 3）", () => {
  it("零 structured 关联会话：按钮禁用 + tooltip 说明，点击不触发 IPC；有 structured 会话时可点击并触发 memory:extract", async () => {
    const fake = makeFake();
    mountArea(fake, { sessions: [{ sessionId: "s-pty-1", cli: "pty", title: "pwsh" }], card: { ...CARD, sessions: ["s-pty-1"] } });
    await waitFor(() => expect(screen.getByTestId("memory-extract-button")).toBeTruthy());

    const btn = screen.getByTestId("memory-extract-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain("结构化会话");
    fireEvent.click(btn);
    expect(fake.calls.filter((c) => c.channel === "memory:extract")).toHaveLength(0);

    // 有 structured 会话（换需求卡片数据重挂）→ 可点击并触发 extract
    cleanup();
    const fake2 = makeFake();
    mountArea(fake2, { sessions: [{ sessionId: "s-struct-1", cli: "claude", title: "实现会话" }] });
    await waitFor(() => expect(screen.getByTestId("memory-extract-button")).toBeTruthy());
    expect((screen.getByTestId("memory-extract-button") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("memory-extract-button"));
    await waitFor(() =>
      expect(fake2.calls).toContainEqual({ channel: "memory:extract", requirementId: REQ_ID }),
    );
  });

  it("进行中替换为四步进度 + 段 i/n + 取消（事件驱动，不轮询）；进行中无提取按钮", async () => {
    const fake = makeFake({ batches: [batch({ id: "B1", status: "running", sourceSessionCount: 3, chunkCount: 0, modelCallCount: 0 })], candidates: [], summary: null });
    mountArea(fake);
    await waitFor(() => expect(screen.getByTestId("memory-extract-progress")).toBeTruthy());
    // running 批次存在 → 提取按钮被进度替换
    expect(screen.queryByTestId("memory-extract-button")).toBeNull();

    // 事件序列（memory.e2e 断言同序）：reading → chunking → extracting i/n
    await fake.emit({ type: "chunk-progress", batchId: "B1", requirementId: REQ_ID, step: "reading", chunkIndex: 0, chunkCount: 0 });
    expect(stepState("reading")).toBe(RUN);
    expect(stepState("merging")).toBe(TODO);

    await fake.emit({ type: "chunk-progress", batchId: "B1", requirementId: REQ_ID, step: "chunking", chunkIndex: 0, chunkCount: 0 });
    expect(stepState("reading")).toBe(DONE);
    expect(stepState("chunking")).toBe(RUN);

    await fake.emit({ type: "chunk-progress", batchId: "B1", requirementId: REQ_ID, step: "extracting", chunkIndex: 0, chunkCount: 4 });
    expect(screen.getByTestId("memory-step-extracting").textContent).toContain("逐段提取（1/4）");
    await fake.emit({ type: "chunk-progress", batchId: "B1", requirementId: REQ_ID, step: "extracting", chunkIndex: 1, chunkCount: 4 });
    expect(stepState("extracting")).toBe(RUN);
    expect(screen.getByTestId("memory-step-extracting").textContent).toContain("逐段提取（2/4）");
    // 段数已知后「分段（N 段）」补全计数
    expect(screen.getByTestId("memory-step-chunking").textContent).toContain("分段（4 段）");
    expect(screen.getByTestId("memory-step-reading").textContent).toContain("3 会话");

    // 取消 → memory:cancel
    fireEvent.click(screen.getByTestId("memory-cancel-button"));
    await waitFor(() => expect(fake.calls).toContainEqual({ channel: "memory:cancel", requirementId: REQ_ID }));
  });

  it("batch-status 终态事件 → 重新拉取 requirementMemory（事件驱动局部刷新），进度退场、按钮回归、新候选出现", async () => {
    const fake = makeFake({ batches: [batch({ id: "B1", status: "running" })], candidates: [], summary: null });
    mountArea(fake);
    await waitFor(() => expect(screen.getByTestId("memory-extract-progress")).toBeTruthy());

    fake.setData({
      batches: [batch({ id: "B1", status: "completed", finishedAt: "2026-11-06T01:15:00.000Z" })],
      candidates: [cand({ id: "c1", status: "pending", claim: "事件驱动刷新出的新候选" })],
      summary: summary(),
    });
    await fake.emit({ type: "batch-status", batchId: "B1", requirementId: REQ_ID, status: "completed" });

    await waitFor(() => expect(screen.getByText("事件驱动刷新出的新候选")).toBeTruthy());
    expect(screen.queryByTestId("memory-extract-progress")).toBeNull();
    expect(screen.getByTestId("memory-extract-button")).toBeTruthy();
    // 一次读 + 事件触发补读（无轮询：刷新只发生在挂载与事件/动作后）
    expect(fake.calls.filter((c) => c.channel === "memory:requirementMemory").length).toBeGreaterThanOrEqual(2);
  });
});

describe("需求经验区 · 批次卡（原型一致项 4）", () => {
  it("元信息 + 缺失会话警示条（列会话与原因、声明不覆盖）；failed 红边卡给失败原因与重试（新批次）；cancelled 灰显", async () => {
    const fake = makeFake({
      batches: [
        batch({ id: "B0", status: "cancelled", finishedAt: "2026-11-06T00:31:00.000Z", chunkCount: 0, modelCallCount: 0 }),
        batch({ id: "B1", status: "failed", error: "第 2 段输出未通过结构校验（重试 1 次后仍失败）", finishedAt: "2026-11-06T00:55:00.000Z", modelCallCount: 3 }),
        batch({
          id: "B2",
          status: "completed",
          finishedAt: "2026-11-06T01:15:00.000Z",
          missingSessions: [{ sessionId: "a3f9c2d11122", cli: "opencode", reason: "历史读取失败" }],
        }),
      ],
      candidates: [cand({ id: "c1", status: "pending", batchId: "B2" }), cand({ id: "c2", status: "accepted", batchId: "B2" })],
      summary: null,
    });
    mountArea(fake);
    const cards = await waitFor(() => screen.getAllByTestId("memory-batch-card"));

    // 最新批次在前（store 按创建序升序返回，展示倒序）；状态徽标与 data-status 可判定
    expect(cards.map((c) => c.getAttribute("data-batch-id"))).toEqual(["B2", "B1", "B0"]);
    expect(cards[0].getAttribute("data-status")).toBe("completed");
    expect(cards[1].getAttribute("data-status")).toBe("failed");
    expect(cards[2].getAttribute("data-status")).toBe("cancelled");

    // 元信息：来源/缺失/分段/模型调用次数 + 候选计数
    expect(cards[0].textContent).toContain("来源 3 会话");
    expect(cards[0].textContent).toContain("缺失 1");
    expect(cards[0].textContent).toContain("分段 4");
    expect(cards[0].textContent).toContain("模型调用 4 次");
    expect(cards[0].textContent).toContain("候选 2 条（待审 1）");

    // 缺失警示条：会话与原因 + 不覆盖声明
    const missing = within(cards[0]).getByTestId("memory-missing-sessions");
    expect(missing.textContent).toContain("a3f9c2d11122");
    expect(missing.textContent).toContain("OpenCode");
    expect(missing.textContent).toContain("历史读取失败");
    expect(missing.textContent).toContain("本次分析不覆盖其内容");

    // failed：失败原因 + 重试（新批次）触发 extract
    expect(within(cards[1]).getByTestId("memory-batch-error").textContent).toContain("未通过结构校验");
    fireEvent.click(within(cards[1]).getByTestId("memory-retry-button"));
    await waitFor(() => expect(fake.calls).toContainEqual({ channel: "memory:extract", requirementId: REQ_ID }));

    // cancelled：灰显无重试钮
    expect(within(cards[2]).queryByTestId("memory-retry-button")).toBeNull();
    expect(cards[2].className).toContain("opacity");
  });
});

describe("需求经验区 · proposed 提示条与对比弹层（原型一致项 5）", () => {
  it("提示条文案 + 对比弹层两栏并排只读 + 二选一触发 resolveSummary，处置后提示条消失", async () => {
    const fake = makeFake({
      batches: [batch({ id: "B3", status: "completed", finishedAt: "2026-11-06T02:00:00.000Z" })],
      candidates: [],
      summary: summary({
        proposedBatchId: "B3",
        proposedMdPath: "C:/data/.../summary.proposed.B3.md",
        content: "人工版正文：含人工补充的认证策略",
        proposedContent: "新版正文：B3 重新生成的分段小结",
      }),
    });
    mountArea(fake);
    const bar = await waitFor(() => screen.getByTestId("memory-proposed-bar"));
    expect(bar.textContent).toContain("检测到人工编辑过的总结");
    expect(bar.textContent).toContain("批次 B3");

    // 对比弹层：两栏并排只读（人工版当前生效 vs 新版待处置）
    fireEvent.click(screen.getByTestId("memory-compare-button"));
    const dialog = screen.getByTestId("memory-compare-dialog");
    expect(within(dialog).getByTestId("memory-compare-human").textContent).toContain("人工补充的认证策略");
    expect(within(dialog).getByTestId("memory-compare-new").textContent).toContain("重新生成的分段小结");
    expect(within(dialog).getByTestId("memory-compare-new").querySelectorAll("input,textarea,button").length).toBe(0);
    fireEvent.click(within(dialog).getByTestId("memory-compare-close"));

    // 采纳新版 → resolveSummary accept-new；处置后刷新，提示条消失
    fireEvent.click(screen.getByTestId("memory-accept-new"));
    await waitFor(() =>
      expect(fake.calls).toContainEqual({ channel: "memory:resolveSummary", requirementId: REQ_ID, choice: "accept-new" }),
    );
    await waitFor(() => expect(screen.queryByTestId("memory-proposed-bar")).toBeNull());

    // 保留人工版（再置 proposed 场景）→ keep-human
    fake.setData({ summary: summary({ proposedBatchId: "B4", proposedContent: "再出一版" }) });
    fireEvent.click(screen.getByTestId("memory-extract-button")); // 任意动作后刷新重取
    await waitFor(() => expect(screen.getByTestId("memory-proposed-bar")).toBeTruthy());
    fireEvent.click(screen.getByTestId("memory-keep-human"));
    await waitFor(() =>
      expect(fake.calls).toContainEqual({ channel: "memory:resolveSummary", requirementId: REQ_ID, choice: "keep-human" }),
    );
    await waitFor(() => expect(screen.queryByTestId("memory-proposed-bar")).toBeNull());
  });
});

describe("需求经验区 · 候选列表（原型一致项 6/7）", () => {
  const pendingSeed = () => ({
    batches: [batch({ id: "B1", status: "completed", finishedAt: "2026-11-06T01:15:00.000Z" })],
    candidates: [
      cand({ id: "c1", status: "pending", claim: "计算相似度前先对文本做 bigram 归一化", scope: "packages/memory" }),
      cand({ id: "c2", status: "accepted", batchId: "B1", claim: "已接受的旧结论", reviewedAt: "2026-11-06T01:20:00.000Z" }),
    ],
    summary: null,
  });

  it("三动作触发对应 IPC：接受（并存）/ 忽略；编辑后接受经弹层携带编辑载荷", async () => {
    const fake = makeFake(pendingSeed());
    mountArea(fake);
    const card = await waitFor(() => screen.getByTestId("memory-candidate"));

    fireEvent.click(within(card).getByTestId("memory-accept-candidate"));
    await waitFor(() =>
      expect(fake.calls).toContainEqual({ channel: "memory:reviewCandidate", candidateId: "c1", action: "accept" }),
    );

    // 忽略
    cleanup();
    const fake2 = makeFake(pendingSeed());
    mountArea(fake2);
    const card2 = await waitFor(() => screen.getByTestId("memory-candidate"));
    fireEvent.click(within(card2).getByTestId("memory-ignore-candidate"));
    await waitFor(() =>
      expect(fake2.calls).toContainEqual({ channel: "memory:reviewCandidate", candidateId: "c1", action: "ignore" }),
    );

    // 编辑后接受：弹层改 claim/scope → 保存携带 edit 载荷
    cleanup();
    const fake3 = makeFake(pendingSeed());
    mountArea(fake3);
    const card3 = await waitFor(() => screen.getByTestId("memory-candidate"));
    fireEvent.click(within(card3).getByTestId("memory-edit-candidate"));
    const dialog = screen.getByTestId("memory-edit-dialog");
    fireEvent.change(within(dialog).getByTestId("memory-edit-claim"), { target: { value: "改写后的结论（去歧义）" } });
    fireEvent.change(within(dialog).getByTestId("memory-edit-scope"), { target: { value: "packages/similarity" } });
    fireEvent.click(within(dialog).getByTestId("memory-edit-save"));
    await waitFor(() =>
      expect(fake3.calls).toContainEqual({
        channel: "memory:reviewCandidate",
        candidateId: "c1",
        action: "edit",
        edit: { claim: "改写后的结论（去歧义）", scope: "packages/similarity" },
      }),
    );
  });

  it("终态拒绝呈现：reviewCandidate 返回 ok:false（candidate-final）→ 错误文案直达", async () => {
    const fake = makeFake(pendingSeed());
    fake.rejectWith.review = { reason: "candidate-final", detail: "候选 CAND-0001 状态为 accepted，终态不可再流转" };
    mountArea(fake);
    const card = await waitFor(() => screen.getByTestId("memory-candidate"));
    fireEvent.click(within(card).getByTestId("memory-accept-candidate"));
    await waitFor(() => expect(screen.getByTestId("memory-action-error").textContent).toContain("终态不可再流转"));
  });

  it("冲突提示：相似度 + 对方编号 + 并存不替换声明；已忽略相似提示纠正语义", async () => {
    const fake = makeFake({
      ...pendingSeed(),
      candidates: [
        cand({
          id: "c9",
          status: "pending",
          conflicts: [{ displayNo: "CAND-0011", similarity: 0.61, kind: "similar-to-accepted" }],
          notes: [{ displayNo: "CAND-0002", similarity: 0.55, kind: "similar-to-ignored-check-correction" }],
        }),
      ],
    });
    mountArea(fake);
    const card = await waitFor(() => screen.getByTestId("memory-candidate"));
    const conflict = within(card).getAllByTestId("memory-conflict-note").at(-1)!;
    expect(conflict.textContent).toContain("CAND-0011");
    expect(conflict.textContent).toContain("0.61");
    expect(conflict.textContent).toContain("并存落库");
    expect(conflict.textContent).toContain("不会替换");
    const note = within(card).getAllByTestId("memory-note-ignored").at(-1)!;
    expect(note.textContent).toContain("CAND-0002");
    expect(note.textContent).toContain("被纠正的旧知识");
  });

  it("待审核跨批次累计（来源批次徽标）+ 已处置按批次折叠 + 终态「去编辑」走 editAccepted", async () => {
    const fake = makeFake({
      batches: [batch({ id: "B1", status: "completed", finishedAt: "2026-11-06T01:15:00.000Z" }), batch({ id: "B2", status: "completed", finishedAt: "2026-11-06T02:15:00.000Z" })],
      candidates: [
        cand({ id: "c1", status: "pending", batchId: "B1", claim: "旧批次遗留的待审候选" }),
        cand({ id: "c2", status: "pending", batchId: "B2", claim: "新批次的待审候选" }),
        cand({ id: "c3", status: "accepted", batchId: "B1", claim: "B1 已接受结论", reviewedAt: "2026-11-06T01:20:00.000Z" }),
        cand({ id: "c4", status: "edited", batchId: "B2", claim: "B2 原结论", editedClaim: "B2 已编辑结论（有效值）", editedScope: "packages/tracker", reviewedAt: "2026-11-06T02:20:00.000Z" }),
        cand({ id: "c5", status: "ignored", batchId: "B1", claim: "B1 已忽略结论", reviewedAt: "2026-11-06T01:21:00.000Z" }),
      ],
      summary: null,
    });
    mountArea(fake);
    await waitFor(() => expect(screen.getAllByTestId("memory-candidate").length).toBe(2));

    // 跨批次待审：两条 pending 都在列，带来源批次徽标
    const pendingCards = screen.getAllByTestId("memory-candidate");
    expect(within(pendingCards[0]).getByTestId("memory-candidate-batch").textContent).toContain("B1");
    expect(within(pendingCards[1]).getByTestId("memory-candidate-batch").textContent).toContain("B2");

    // 已处置按批次折叠：默认收起
    const groups = screen.getAllByTestId("memory-disposed-group");
    expect(groups.map((g) => g.getAttribute("data-batch-id"))).toEqual(["B1", "B2"]);
    expect(screen.queryByTestId("memory-disposed-candidate")).toBeNull();

    // 展开 B2 → 已编辑候选展示有效值 + 「去编辑」
    const g2 = groups.find((g) => g.getAttribute("data-batch-id") === "B2")!;
    fireEvent.click(within(g2).getByTestId("memory-disposed-toggle"));
    const edited = await waitFor(() => screen.getByTestId("memory-disposed-candidate"));
    expect(edited.textContent).toContain("B2 已编辑结论（有效值）");
    fireEvent.click(within(edited).getByTestId("memory-go-edit"));

    // 去编辑弹层：knowledge 模式（初值取有效值），保存走 editAccepted
    const dialog = screen.getByTestId("memory-edit-dialog");
    expect((within(dialog).getByTestId("memory-edit-claim") as HTMLTextAreaElement).value).toBe("B2 已编辑结论（有效值）");
    fireEvent.change(within(dialog).getByTestId("memory-edit-claim"), { target: { value: "再编辑后的知识" } });
    fireEvent.click(within(dialog).getByTestId("memory-edit-save"));
    await waitFor(() => {
      const call = fake.calls.find((c) => c.channel === "memory:editAccepted" && c.candidateId === "c4");
      expect(call).toMatchObject({ claim: "再编辑后的知识" });
    });
  });

  it("编辑弹层：claim/scope 可编辑、溯源区只读（来源会话/证据摘录/批次/编号），保存标注已编辑；取消关闭不落 IPC", async () => {
    const fake = makeFake(pendingSeed());
    mountArea(fake, { sessions: [{ sessionId: "s-struct-1", cli: "claude", title: "实现会话" }] });
    const card = await waitFor(() => screen.getByTestId("memory-candidate"));
    fireEvent.click(within(card).getByTestId("memory-edit-candidate"));
    const dialog = screen.getByTestId("memory-edit-dialog");

    // 可编辑字段初值 = 候选原值
    expect((within(dialog).getByTestId("memory-edit-claim") as HTMLTextAreaElement).value).toBe("计算相似度前先对文本做 bigram 归一化");
    expect((within(dialog).getByTestId("memory-edit-scope") as HTMLInputElement).value).toBe("packages/memory");

    // 溯源区只读：无输入控件，含来源会话/证据/批次/编号
    const source = within(dialog).getByTestId("memory-edit-source");
    expect(source.querySelectorAll("input,textarea").length).toBe(0);
    expect(source.textContent).toContain("Claude");
    expect(source.textContent).toContain("示例证据摘录");
    expect(source.textContent).toContain("批次：B1");
    expect(source.textContent).toContain("CAND-");
    expect(within(dialog).getByTestId("memory-edit-save").textContent).toContain("已编辑");

    // 取消 → 不发 IPC
    fireEvent.click(within(dialog).getByTestId("memory-edit-cancel"));
    expect(screen.queryByTestId("memory-edit-dialog")).toBeNull();
    expect(fake.calls.filter((c) => c.channel === "memory:reviewCandidate")).toHaveLength(0);
  });
});

describe("DetailPanel 挂点（#33：需求经验区挂关联会话区之后）", () => {
  const actions: DetailActions = { onRename: async () => null, onSetStage: () => undefined, onDelete: () => undefined, onClose: () => undefined };

  it("memory 缺省 → 需求经验占位形态；挂点位于关联会话区之后", () => {
    render(<DetailPanel card={CARD} actions={actions} related={{ sessions: [] }} />);
    const area = screen.getByTestId("memory-area");
    expect(area.textContent).toContain("需求经验");
    const sessions = screen.getByTestId("detail-sessions");
    // memory-area 在 detail-sessions 之后（DOM 顺序）
    expect(sessions.compareDocumentPosition(area) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("memory controller 注入 → 渲染完整需求经验区（提取按钮等）", async () => {
    const fake = makeFake({ batches: [], candidates: [], summary: null });
    function Harness() {
      const memory = useRequirementMemory(CARD.id, fake.transport);
      return <DetailPanel card={CARD} actions={actions} related={{ sessions: [] }} memory={memory} />;
    }
    render(<Harness />);
    await waitFor(() => expect(within(screen.getByTestId("detail-panel")).getByTestId("memory-extract-button")).toBeTruthy());
    // transport 未接 memory 通道 → controller 为 null → 占位（旧测试 fake 兼容）
    cleanup();
    const legacyFake: ChatTransport = {
      invoke: async () => ({ ok: true }) as IpcResult,
      onEvent: () => () => undefined,
      onTerminalEvent: () => () => undefined,
      onTrackerEvent: () => () => undefined,
    };
    function LegacyHarness() {
      const memory = useRequirementMemory(CARD.id, legacyFake);
      return <DetailPanel card={CARD} actions={actions} related={{ sessions: [] }} memory={memory} />;
    }
    render(<LegacyHarness />);
    expect(screen.getByTestId("memory-area").textContent).toContain("即将提供");
  });
});
