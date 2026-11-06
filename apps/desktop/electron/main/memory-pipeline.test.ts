// 用途：提取管线密封测试（issue #32 验收，spec #27 F/C 节）—— 经 MemoryService 公共 seam（extract/cancel/stop）对注入 fake 双桥（readTranscript / runOnce）覆盖：成功全产物与元信息、校验重试、失败路径四类、取消整批丢弃、缺失会话声明、防覆盖集成、同需求串行/跨需求并行、事件序列、shutdown 停止
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryEventWire, TranscriptEvent } from "@kanban/ipc-schema";
import type { MemoryBatchRecord } from "@kanban/memory";
import { openDatabase, type SqliteDb } from "./db";
import { openMemoryService, type MemoryService } from "./memory-service";
import type { RunOnceCall, RunOnceOutcome } from "./memory-pipeline";

let tmpRoot = "";

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

/** 可控 runOnce 结果（fake 桥统一形状） */
function outcome(partial: Partial<RunOnceOutcome>): RunOnceOutcome {
  return { status: "completed", exitCode: 0, stdout: "", stderr: "", durationMs: 10, ...partial };
}

/** 段输出 JSON 文本（stdout 载荷） */
function segmentJson(summary: string, candidates: unknown[]): string {
  return JSON.stringify({ summary, candidates });
}

/**
 * 装配被测件：:memory: 库 + 临时 dataRoot + fake 双桥（transcript 按会话预置/可抛错；
 * runOnce 行为队列可控，记录全部调用与 cancelRunOnce 请求），事件捕获到数组。
 */
function makePipelineService(opts?: { stopSettleMs?: number }) {
  tmpRoot = mkdtempSync(join(tmpdir(), "kb-mem-pipe-"));
  const db: SqliteDb = openDatabase(":memory:");
  const transcripts = new Map<string, TranscriptEvent[] | Error>();
  const runCalls: RunOnceCall[] = [];
  const cancelRunOnceCalls: string[] = [];
  const events: MemoryEventWire[] = [];
  // 会话关联预置（sessionId → 所属需求与 cli；需求 → projectId/标题/关联 PTY）
  const transcriptKeysByReq = new Map<string, string[]>();
  const cliOfSession = new Map<string, string>();
  const projects = new Map<string, string>();
  const ptyLinked = new Map<string, Array<{ sessionId: string }>>();
  const titles = new Map<string, string>();
  const deletedReqs = new Set<string>(); // tracker 除名模拟（requirementExists 返回 false）
  /** runOnce 行为队列：每次调用弹出下一个；队列为空时用 fallback；元素可为「待 resolve 的手动控制器」 */
  const runQueue: Array<
    ((call: RunOnceCall) => Promise<RunOnceOutcome>) | { pending: Promise<RunOnceOutcome>; resolve: (r: RunOnceOutcome) => void }
  > = [];
  let fallback: (call: RunOnceCall) => Promise<RunOnceOutcome> = async () => outcome({ stdout: segmentJson("空段小结", []) });

  const pendingRun = (): { pending: Promise<RunOnceOutcome>; resolve: (r: RunOnceOutcome) => void } => {
    let resolve!: (r: RunOnceOutcome) => void;
    const pending = new Promise<RunOnceOutcome>((r) => {
      resolve = r;
    });
    return { pending, resolve };
  };

  const { service } = openMemoryService({
    db,
    dataRoot: join(tmpRoot, "memory"),
    listLinkedStructuredSessions: (requirementId) =>
      (transcriptKeysByReq.get(requirementId) ?? []).map((sessionId) => ({
        sessionId,
        cli: cliOfSession.get(sessionId) ?? "claude-code",
      })),
    listLinkedPtySessions: (requirementId) => ptyLinked.get(requirementId) ?? [],
    getRequirementProjectId: (requirementId) => projects.get(requirementId) ?? null,
    getRequirementTitle: (requirementId) => titles.get(requirementId) ?? null,
    requirementExists: (requirementId) => !deletedReqs.has(requirementId),
    emitMemoryEvent: (event) => events.push(event),
    stopSettleMs: opts?.stopSettleMs,
    readTranscriptBridge: async (sessionId) => {
      const v = transcripts.get(sessionId);
      if (v instanceof Error) throw v;
      return v ?? [];
    },
    runOnceBridge: async (input) => {
      runCalls.push(input);
      const next = runQueue.shift();
      if (!next) return fallback(input);
      if ("pending" in next) return next.pending;
      return next(input);
    },
    cancelRunOnceBridge: async (runId) => {
      cancelRunOnceCalls.push(runId);
    },
  });

  return {
    service,
    db,
    dataRoot: join(tmpRoot, "memory"),
    events,
    runCalls,
    cancelRunOnceCalls,
    runQueue,
    pendingRun,
    setFallback: (fn: (call: RunOnceCall) => Promise<RunOnceOutcome>) => {
      fallback = fn;
    },
    seedSession(requirementId: string, sessionId: string, cli: string, events: TranscriptEvent[]) {
      transcripts.set(sessionId, events);
      cliOfSession.set(sessionId, cli);
      const arr = transcriptKeysByReq.get(requirementId) ?? [];
      arr.push(sessionId);
      transcriptKeysByReq.set(requirementId, arr);
    },
    seedReadFailure(requirementId: string, sessionId: string, cli: string, err: Error) {
      transcripts.set(sessionId, err);
      cliOfSession.set(sessionId, cli);
      const arr = transcriptKeysByReq.get(requirementId) ?? [];
      arr.push(sessionId);
      transcriptKeysByReq.set(requirementId, arr);
    },
    ptyLinked,
    projects,
    titles,
    deletedReqs,
  };
}

type Ctx = ReturnType<typeof makePipelineService>;

/** 等待批次离开 running（管线异步落定；轮询上限 2s） */
async function waitTerminal(service: MemoryService, batchId: string): Promise<MemoryBatchRecord> {
  for (let i = 0; i < 400; i++) {
    const b = service.store.getBatch(batchId);
    if (b && b.status !== "running") return b;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`批次 ${batchId} 未在时限内落定`);
}

/** 等待条件成立（轮询） */
async function waitUntil(fn: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("条件未在时限内成立");
}

const ev = (role: "user" | "assistant", text: string): TranscriptEvent => ({ role, text });

describe("提取管线：成功路径", () => {
  it("双会话两段提取 → completed：批次元信息如实、候选（clamp+跨段合并+编号）、总结（来源+段小结合并）、事件序列、临时执行三层隔离参数", async () => {
    const ctx = makePipelineService();
    ctx.projects.set("REQ-001", "p1");
    ctx.titles.set("REQ-001", "构建提速需求");
    ctx.seedSession("REQ-001", "s1", "claude-code", [ev("user", "请优化构建脚本"), ev("assistant", "已改为 pnpm --filter 构建")]);
    ctx.seedSession("REQ-001", "s2", "codex", [ev("assistant", "验证了构建命令可用")]);

    // 两段输出：段一带 bogus 来源与空 claim 候选（clamp/丢弃）；段二 claim 与段一相似（跨段 0.75 合并）
    ctx.runQueue.push(
      async () =>
        outcome({
          stdout: segmentJson("段一小结：完成构建脚本改造。", [
            { claim: "构建脚本必须走 pnpm filter", evidence: "历史中多次执行 pnpm --filter", scope: "构建", sourceSessionIds: ["s1"] },
            { claim: "来源会话错误的候选", evidence: "e", scope: "s", sourceSessionIds: ["bogus-session"] },
            { claim: "   ", evidence: "空 claim 应被丢弃", scope: "", sourceSessionIds: ["s1"] },
          ]),
        }),
    );
    ctx.runQueue.push(
      async () =>
        outcome({
          stdout: segmentJson("段二小结：验证构建流程。", [
            { claim: "构建脚本必须走 pnpm 的 filter 过滤", evidence: "第二次实证", scope: "构建v2", sourceSessionIds: ["s2"] },
          ]),
        }),
    );

    const started = ctx.service.extract("REQ-001");
    expect(started).toMatchObject({ ok: true, started: true });
    if (!started.ok) return;
    const batchId = started.batchId;
    const batch = await waitTerminal(ctx.service, batchId);

    // 批次元信息如实（来源/缺失/分段/模型调用次数）
    expect(batch).toMatchObject({
      status: "completed",
      requirementId: "REQ-001",
      projectId: "p1",
      sourceSessionCount: 2,
      missingSessions: [],
      chunkCount: 2,
      modelCallCount: 2,
      error: null,
    });

    // 候选：空 claim 丢弃、bogus 来源 clamp 到段内会话、相似 claim 跨段合并（来源并集）
    const cands = ctx.service.store.listRequirementCandidates("REQ-001");
    expect(cands.length).toBe(2);
    expect(cands.map((c) => c.displayNo)).toEqual(["CAND-0001", "CAND-0002"]);
    expect(cands.every((c) => c.batchId === batchId && c.status === "pending")).toBe(true);
    const merged = cands.find((c) => c.claim === "构建脚本必须走 pnpm filter");
    expect(merged).toBeTruthy();
    expect(merged?.sourceSessionIds.sort()).toEqual(["s1", "s2"]);
    expect(merged?.evidence).toContain("第二次实证"); // 合并拼接证据
    expect(merged?.evidence).toContain("pnpm --filter");

    // 总结：来源声明 + 分段小结合并；hash 基准建档
    const summaryRow = ctx.service.summaries.getSummary("REQ-001");
    expect(summaryRow).toBeTruthy();
    const content = readFileSync(summaryRow!.mdPath, "utf8");
    expect(content).toContain("构建提速需求");
    expect(content).toContain("段一小结：完成构建脚本改造。");
    expect(content).toContain("段二小结：验证构建流程。");
    expect(content).toContain("s1");
    expect(content).toContain("s2");

    // 三层隔离：cwd = dataRoot/<projectId>/extract-tmp/<batchId>（应用数据目录，不进项目仓库）；全新 session id
    expect(ctx.runCalls.length).toBe(2);
    for (const call of ctx.runCalls) {
      expect(call.cwd).toBe(join(ctx.dataRoot, "p1", "extract-tmp", batchId));
      expect(existsSync(call.cwd)).toBe(true);
      expect(call.cli).toBe("claude");
      expect(call.timeoutMs).toBe(300_000);
      expect(call.args[0]).toBe("-p");
      expect(call.args[1]).toBe("--session-id");
      expect(call.args[2]).toMatch(/^[0-9a-f-]{36}$/);
      expect(call.stdin).toContain("----- 历史开始 -----");
      expect(call.stdin).toContain("固定术语");
      expect(call.stdin).toContain("禁止出现英文双引号");
    }
    expect(ctx.runCalls[0].args[2]).not.toBe(ctx.runCalls[1].args[2]); // 每段全新 session id
    // prompt 携带本段历史文本与来源
    expect(ctx.runCalls[0].stdin).toContain("请优化构建脚本");
    expect(ctx.runCalls[1].stdin).toContain("验证了构建命令可用");

    // 事件序列（US8 四步 + i/n 段进度 + 批次状态）
    expect(ctx.events).toEqual([
      { type: "batch-status", batchId, requirementId: "REQ-001", status: "running" },
      { type: "chunk-progress", batchId, requirementId: "REQ-001", step: "reading", chunkIndex: 0, chunkCount: 0 },
      { type: "chunk-progress", batchId, requirementId: "REQ-001", step: "chunking", chunkIndex: 0, chunkCount: 0 },
      { type: "chunk-progress", batchId, requirementId: "REQ-001", step: "extracting", chunkIndex: 0, chunkCount: 2 },
      { type: "chunk-progress", batchId, requirementId: "REQ-001", step: "extracting", chunkIndex: 1, chunkCount: 2 },
      { type: "chunk-progress", batchId, requirementId: "REQ-001", step: "merging", chunkIndex: 0, chunkCount: 0 },
      { type: "batch-status", batchId, requirementId: "REQ-001", status: "completed" },
    ]);
  });

  it("零事件会话（空 transcript）→ 零段零调用仍 completed，总结声明来源", async () => {
    const ctx = makePipelineService();
    ctx.projects.set("REQ-E", "p1");
    ctx.seedSession("REQ-E", "s-empty", "claude-code", []);
    const started = ctx.service.extract("REQ-E");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const batch = await waitTerminal(ctx.service, started.batchId);
    expect(batch).toMatchObject({ status: "completed", chunkCount: 0, modelCallCount: 0, sourceSessionCount: 1 });
    expect(ctx.runCalls.length).toBe(0);
    const row = ctx.service.summaries.getSummary("REQ-E");
    expect(row).toBeTruthy();
  });
});

describe("提取管线：校验重试", () => {
  it("首次输出非法 JSON → 重试一次成功：modelCallCount 含重试，重试 prompt 带修正提示，产物取第二次输出", async () => {
    const ctx = makePipelineService();
    ctx.projects.set("REQ-001", "p1");
    ctx.seedSession("REQ-001", "s1", "claude-code", [ev("user", "做了甲事"), ev("assistant", "验证通过")]);
    ctx.runQueue.push(async () => outcome({ stdout: "抱歉，这不是 JSON" }));
    ctx.runQueue.push(async () => outcome({ stdout: segmentJson("重试后的小结。", [{ claim: "重试产出的候选", evidence: "e", scope: "s", sourceSessionIds: ["s1"] }]) }));

    const started = ctx.service.extract("REQ-001");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const batch = await waitTerminal(ctx.service, started.batchId);
    expect(batch).toMatchObject({ status: "completed", modelCallCount: 2, chunkCount: 1 });
    expect(ctx.runCalls.length).toBe(2);
    expect(ctx.runCalls[1].stdin).toContain("上一次输出未通过校验");
    const cands = ctx.service.store.listRequirementCandidates("REQ-001");
    expect(cands.map((c) => c.claim)).toEqual(["重试产出的候选"]);
  });

  it("两次输出 schema 均不合法 → failed 附原因，无候选与总结残留", async () => {
    const ctx = makePipelineService();
    ctx.projects.set("REQ-001", "p1");
    ctx.seedSession("REQ-001", "s1", "claude-code", [ev("user", "x"), ev("assistant", "y")]);
    ctx.setFallback(async () => outcome({ stdout: JSON.stringify({ summary: "小结", candidates: "不是数组" }) }));

    const started = ctx.service.extract("REQ-001");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const batch = await waitTerminal(ctx.service, started.batchId);
    expect(batch.status).toBe("failed");
    expect(batch.error).toContain("校验重试仍失败");
    expect(batch.modelCallCount).toBe(2);
    expect(ctx.service.store.listRequirementCandidates("REQ-001")).toEqual([]);
    expect(ctx.service.summaries.getSummary("REQ-001")).toBeNull();
    const lastFail = ctx.events.at(-1);
    expect(lastFail).toMatchObject({ type: "batch-status", status: "failed" });
    if (lastFail?.type === "batch-status") expect(lastFail.error).toContain("校验重试仍失败");
  });
});

describe("提取管线：失败路径", () => {
  function oneChunkCtx(partial: { runOnce: (call: RunOnceCall) => Promise<RunOnceOutcome> }): Ctx {
    const ctx = makePipelineService();
    ctx.projects.set("REQ-001", "p1");
    ctx.seedSession("REQ-001", "s1", "claude-code", [ev("user", "x"), ev("assistant", "y")]);
    ctx.setFallback(partial.runOnce);
    return ctx;
  }

  it("进程非零退出（进程崩）→ failed 附退出码与 stderr，无产物", async () => {
    const ctx = oneChunkCtx({ runOnce: async () => outcome({ status: "failed", exitCode: 1, stderr: "claude 崩溃输出" }) });
    const started = ctx.service.extract("REQ-001");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const batch = await waitTerminal(ctx.service, started.batchId);
    expect(batch.status).toBe("failed");
    expect(batch.error).toContain("退出码 1");
    expect(batch.error).toContain("claude 崩溃输出");
    expect(ctx.service.store.listRequirementCandidates("REQ-001")).toEqual([]);
  });

  it("单段超时 → failed 附超时原因", async () => {
    const ctx = oneChunkCtx({ runOnce: async () => outcome({ status: "timeout", exitCode: null }) });
    const started = ctx.service.extract("REQ-001");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const batch = await waitTerminal(ctx.service, started.batchId);
    expect(batch.status).toBe("failed");
    expect(batch.error).toContain("超时");
  });

  it("CLI 不可用（桥抛错：exe 解析失败）→ failed 附 CLI 不可用原因", async () => {
    const ctx = makePipelineService();
    ctx.projects.set("REQ-001", "p1");
    ctx.seedSession("REQ-001", "s1", "claude-code", [ev("user", "x")]);
    ctx.setFallback(async () => {
      throw new Error("run-once exe 解析失败（claude）：未找到可执行文件");
    });
    const started = ctx.service.extract("REQ-001");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const batch = await waitTerminal(ctx.service, started.batchId);
    expect(batch.status).toBe("failed");
    expect(batch.error).toContain("CLI 不可用");
    expect(batch.error).toContain("exe 解析失败");
    expect(batch.modelCallCount).toBe(0); // 未成功发起调用不计模型调用
  });
});

describe("提取管线：取消与整批丢弃", () => {
  it("取消进行中批次：终止当前段临时执行（cancelRunOnce 收到 runId）→ running→cancelled，无候选与总结，事件收尾 cancelled", async () => {
    const ctx = makePipelineService();
    ctx.projects.set("REQ-001", "p1");
    ctx.seedSession("REQ-001", "s1", "claude-code", [ev("user", "x"), ev("assistant", "y")]);
    const gate = ctx.pendingRun();
    ctx.runQueue.push(gate);

    const started = ctx.service.extract("REQ-001");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitUntil(() => ctx.runCalls.length === 1); // 段提取已发起

    const cancelP = ctx.service.cancel("REQ-001");
    expect(ctx.cancelRunOnceCalls).toEqual([ctx.runCalls[0].runId]); // 终止的是当前段的临时执行
    gate.resolve(outcome({ status: "cancelled", exitCode: null }));
    const r = await cancelP;
    expect(r).toMatchObject({ ok: true, cancelled: true });

    const batch = await waitTerminal(ctx.service, started.batchId);
    expect(batch.status).toBe("cancelled");
    expect(ctx.service.store.listRequirementCandidates("REQ-001")).toEqual([]);
    expect(ctx.service.summaries.getSummary("REQ-001")).toBeNull();
    expect(ctx.events.at(-1)).toMatchObject({ type: "batch-status", status: "cancelled" });
  });

  it("runOnce 返回 cancelled（外部终止）→ 批次收敛 cancelled 而非 failed", async () => {
    const ctx = makePipelineService();
    ctx.projects.set("REQ-001", "p1");
    ctx.seedSession("REQ-001", "s1", "claude-code", [ev("user", "x")]);
    ctx.setFallback(async () => outcome({ status: "cancelled", exitCode: null }));
    const started = ctx.service.extract("REQ-001");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const batch = await waitTerminal(ctx.service, started.batchId);
    expect(batch).toMatchObject({ status: "cancelled" });
  });

  it("孤儿 running 批次（库内有行、无进行中编排）cancel → 直接收敛 cancelled", async () => {
    const ctx = makePipelineService();
    ctx.service.store.createBatch({ id: "B-orphan", requirementId: "REQ-001", projectId: "p1" });
    const r = await ctx.service.cancel("REQ-001");
    expect(r).toMatchObject({ ok: true, cancelled: true });
    expect(ctx.service.store.getBatch("B-orphan")).toMatchObject({ status: "cancelled" });
  });
});

describe("提取管线：缺失会话声明（US3）", () => {
  it("读取失败会话与关联 PTY 会话列入 missingSessions 带原因，总结头部声明不覆盖，其余会话照常提取", async () => {
    const ctx = makePipelineService();
    ctx.projects.set("REQ-001", "p1");
    ctx.seedSession("REQ-001", "s-ok", "claude-code", [ev("user", "x"), ev("assistant", "y")]);
    ctx.seedReadFailure("REQ-001", "s-bad", "codex", new Error("会话不存在或已过期"));
    ctx.ptyLinked.set("REQ-001", [{ sessionId: "p-pty-1" }]);
    ctx.setFallback(async () => outcome({ stdout: segmentJson("可读部分的小结。", []) }));

    const started = ctx.service.extract("REQ-001");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const batch = await waitTerminal(ctx.service, started.batchId);

    expect(batch).toMatchObject({ status: "completed", sourceSessionCount: 2 });
    const missing = batch.missingSessions;
    expect(missing.length).toBe(2);
    expect(missing).toContainEqual(expect.objectContaining({ sessionId: "s-bad", cli: "codex", reason: expect.stringContaining("会话不存在或已过期") }));
    expect(missing).toContainEqual(expect.objectContaining({ sessionId: "p-pty-1", cli: "pty" }));

    const row = ctx.service.summaries.getSummary("REQ-001");
    const content = readFileSync(row!.mdPath, "utf8");
    expect(content).toContain("缺失");
    expect(content).toContain("s-bad");
    expect(content).toContain("p-pty-1");
    expect(content).toContain("不覆盖");
  });
});

describe("提取管线：总结防覆盖集成（US14）", () => {
  it("人工编辑过总结再提取 → 新版暂存 proposed 不覆盖人工版；未编辑过 → 直接覆盖", async () => {
    const ctx = makePipelineService();
    ctx.projects.set("REQ-001", "p1");
    ctx.seedSession("REQ-001", "s1", "claude-code", [ev("user", "x"), ev("assistant", "y")]);
    ctx.setFallback(async () => outcome({ stdout: segmentJson("第一版总结正文。", [{ claim: "首版候选", evidence: "e", scope: "s", sourceSessionIds: ["s1"] }]) }));

    const first = ctx.service.extract("REQ-001");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await waitTerminal(ctx.service, first.batchId);
    const row1 = ctx.service.summaries.getSummary("REQ-001")!;

    // 人工编辑磁盘总结（hash 偏离库基准）
    writeFileSync(row1.mdPath, "人工编辑过的总结正文。", "utf8");

    // 二次提取产出新版
    ctx.setFallback(async () => outcome({ stdout: segmentJson("第二版总结正文。", [{ claim: "再版候选", evidence: "e2", scope: "s2", sourceSessionIds: ["s1"] }]) }));
    const second = ctx.service.extract("REQ-001");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await waitTerminal(ctx.service, second.batchId);

    const row2 = ctx.service.summaries.getSummary("REQ-001")!;
    expect(readFileSync(row2.mdPath, "utf8")).toBe("人工编辑过的总结正文。"); // 人工版未被覆盖
    expect(row2.proposedBatchId).toBe(second.batchId);
    expect(row2.proposedMdPath).toBeTruthy();
    expect(readFileSync(row2.proposedMdPath!, "utf8")).toContain("第二版总结正文。"); // 新版暂存
    // 两批候选均在（首批 1 + 再批 1，跨批次累计待审）
    expect(ctx.service.store.listRequirementCandidates("REQ-001").map((c) => c.claim).sort()).toEqual(["再版候选", "首版候选"]);
  });
});

describe("提取管线：并发语义（US11）", () => {
  it("同需求 running 中二次触发拒绝 extraction-running；两需求并行提取互不影响", async () => {
    const ctx = makePipelineService();
    ctx.projects.set("REQ-A", "p1");
    ctx.projects.set("REQ-B", "p1");
    ctx.seedSession("REQ-A", "sa", "claude-code", [ev("user", "a"), ev("assistant", "a2")]);
    ctx.seedSession("REQ-B", "sb", "codex", [ev("user", "b"), ev("assistant", "b2")]);
    const gateA = ctx.pendingRun();
    const gateB = ctx.pendingRun();
    ctx.runQueue.push(gateA, gateB);

    const a = ctx.service.extract("REQ-A");
    const b = ctx.service.extract("REQ-B");
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    if (!a.ok || !b.ok) return;
    await waitUntil(() => ctx.runCalls.length === 2); // 两需求提取并行发起

    expect(ctx.service.extract("REQ-A")).toMatchObject({ ok: false, reason: "extraction-running" });
    expect(ctx.service.extract("REQ-B")).toMatchObject({ ok: false, reason: "extraction-running" });

    gateA.resolve(outcome({ stdout: segmentJson("A 需求小结。", [{ claim: "A 候选", evidence: "e", scope: "s", sourceSessionIds: ["sa"] }]) }));
    gateB.resolve(outcome({ stdout: segmentJson("B 需求小结。", [{ claim: "B 候选", evidence: "e", scope: "s", sourceSessionIds: ["sb"] }]) }));
    const batchA = await waitTerminal(ctx.service, a.batchId);
    const batchB = await waitTerminal(ctx.service, b.batchId);
    expect(batchA).toMatchObject({ status: "completed", requirementId: "REQ-A" });
    expect(batchB).toMatchObject({ status: "completed", requirementId: "REQ-B" });
    const cands = ctx.service.store.listRequirementCandidates("REQ-A").concat(ctx.service.store.listRequirementCandidates("REQ-B"));
    expect(cands.map((c) => c.claim).sort()).toEqual(["A 候选", "B 候选"]);
  });
});

describe("提取管线：shutdown 停止（spec #27 C 节）", () => {
  it("stop()：进行中批次终止（cancelRunOnce）→ cancelled，等待落定后返回", async () => {
    const ctx = makePipelineService();
    ctx.projects.set("REQ-001", "p1");
    ctx.seedSession("REQ-001", "s1", "claude-code", [ev("user", "x"), ev("assistant", "y")]);
    const gate = ctx.pendingRun();
    ctx.runQueue.push(gate);
    const started = ctx.service.extract("REQ-001");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitUntil(() => ctx.runCalls.length === 1);

    const stopP = ctx.service.stop();
    expect(ctx.cancelRunOnceCalls).toEqual([ctx.runCalls[0].runId]);
    gate.resolve(outcome({ status: "cancelled", exitCode: null }));
    await stopP;
    expect(ctx.service.store.getBatch(started.batchId)).toMatchObject({ status: "cancelled" });
  });

  it("临时执行迟迟不落定：stop() 有限等待后兜底收敛 cancelled（DB 关闭前保证终态）", async () => {
    const ctx = makePipelineService({ stopSettleMs: 60 });
    ctx.projects.set("REQ-001", "p1");
    ctx.seedSession("REQ-001", "s1", "claude-code", [ev("user", "x"), ev("assistant", "y")]);
    const gate = ctx.pendingRun();
    ctx.runQueue.push(gate);
    const started = ctx.service.extract("REQ-001");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitUntil(() => ctx.runCalls.length === 1);

    const t0 = Date.now();
    await ctx.service.stop(); // gate 永不 resolve
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(ctx.service.store.getBatch(started.batchId)).toMatchObject({ status: "cancelled" });
    // 兜底后管线迟来落定不得改写终态
    gate.resolve(outcome({ stdout: segmentJson("迟到的输出。", []) }));
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx.service.store.getBatch(started.batchId)).toMatchObject({ status: "cancelled" });
  });
});

describe("提取管线：需求删除竞态守卫（#35 边界，协调者指定）", () => {
  it("提取进行中需求被删除（级联清数据 + tracker 除名）→ 段完成后整批丢弃：不复活批次/候选/总结，事件 cancelled 附原因", async () => {
    const ctx = makePipelineService();
    ctx.projects.set("REQ-D", "p1");
    ctx.seedSession("REQ-D", "s1", "claude-code", [ev("user", "x"), ev("assistant", "y")]);
    const gate = ctx.pendingRun();
    ctx.runQueue.push(gate);
    const started = ctx.service.extract("REQ-D");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitUntil(() => ctx.runCalls.length === 1); // 段提取进行中

    // 模拟 #35 kanban:delete：tracker 除名 + 真实级联入口清理（清 running 批次行与需求目录）
    ctx.deletedReqs.add("REQ-D");
    ctx.service.deleteRequirementData("REQ-D", "p1");

    // 段完成后管线到达终局：守卫生效，整批丢弃
    gate.resolve(outcome({ stdout: segmentJson("迟到的总结。", [{ claim: "迟到的候选", evidence: "e", scope: "s", sourceSessionIds: ["s1"] }]) }));
    await new Promise((r) => setTimeout(r, 50));

    expect(ctx.service.store.listBatches("REQ-D")).toEqual([]); // 批次行不复活
    expect(ctx.service.store.listRequirementCandidates("REQ-D")).toEqual([]); // 候选不落库
    expect(ctx.service.summaries.getSummary("REQ-D")).toBeNull(); // 总结行不复活
    expect(existsSync(join(ctx.dataRoot, "p1", "requirements", "REQ-D"))).toBe(false); // summary.md 不复活
    const last = ctx.events.at(-1);
    expect(last).toMatchObject({ type: "batch-status", status: "cancelled" });
    if (last?.type === "batch-status") expect(last.error).toContain("需求已删除");
  });
});

describe("提取入口拒绝语义（桥接线前置检查）", () => {
  it("需求无项目归属（防御）→ requirement-not-found；批次不创建", () => {
    const ctx = makePipelineService();
    ctx.seedSession("REQ-GHOST", "s1", "claude-code", [ev("user", "x")]); // 无 projects 映射
    const r = ctx.service.extract("REQ-GHOST");
    expect(r).toMatchObject({ ok: false, reason: "requirement-not-found" });
    expect(ctx.service.store.listBatches("REQ-GHOST")).toEqual([]);
  });
});
