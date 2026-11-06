// 用途：memory B 类 e2e（issue #31 审核/检索/重启 + #35 删除级联 + #32 提取管线全流程）—— 经真实 handleIpc（kanban:ipc）与 handleMemoryIpc（memory:ipc）完成「提取（fake 桥经 runOnce seam 注入，含进度事件序列与取消/删除竞态）→ 审核 → 检索 → 重启保持」；fake/预置数据驱动部分默认跑；真实 Claude headless 一条用例 KANBAN_E2E=1 门控（#37 验收前预演）
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CliAdapter, FakeAdapter, resolveClaudeExe, RunOnceRunner, VirtualClock } from "@kanban/cli-host";
import type { MemoryEventWire, TranscriptEvent } from "@kanban/ipc-schema";
import type { MemoryBatchRecord } from "@kanban/memory";
import { TrackerEngine } from "@kanban/tracker";
import { openDatabase } from "../../electron/main/db";
import { handleIpc, handleMemoryIpc, TRACKER_CLI_BY_APP, type IpcDeps } from "../../electron/main/ipc";
import { openMemoryService } from "../../electron/main/memory-service";
import type { RunOnceCall, RunOnceOutcome } from "../../electron/main/memory-pipeline";
import { ProjectStore } from "../../electron/main/project-store";
import { SessionStore } from "../../electron/main/session-store";
import type { PtyHost } from "../../electron/main/pty-host";

let tmpRoot = "";

// Windows 下 SQLite 句柄释放有延迟：清理带短重试（失败可见）
afterEach(async () => {
  if (!tmpRoot) return;
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = "";
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  rmSync(tmpRoot, { recursive: true, force: true }); // 仍失败则抛出（不静默吞）
  tmpRoot = "";
});

/** 路由级 fake PTY 宿主（本 e2e 不触 PTY 通道，仅满足 IpcDeps 形状；模式同 ipc.test.ts） */
function makeFakePtyHost(): PtyHost {
  const running = new Set<string>();
  return {
    spawn: (terminalId) => {
      running.add(terminalId);
      return { ok: true, label: "pwsh", shell: "pwsh.exe", cwd: tmpRoot };
    },
    write: (terminalId) => (running.has(terminalId) ? { ok: true } : { ok: false, message: "终端未运行" }),
    resize: () => undefined,
    kill: (terminalId) => running.delete(terminalId),
    isRunning: (terminalId) => running.has(terminalId),
    killAll: () => running.clear(),
  };
}

/** 一台「应用实例」：文件库 + 独立 memory dataRoot + 真实 handleIpc/handleMemoryIpc 路由与 index.ts 同款 tracker 查询注入 */
function makeApp() {
  tmpRoot = mkdtempSync(join(tmpdir(), "kb-memory-e2e-"));
  const dbPath = join(tmpRoot, "kanban.db");
  const dataRoot = join(tmpRoot, "memory");
  const projectDir = join(tmpRoot, "proj");
  mkdirSync(projectDir);
  return assemble(dbPath, dataRoot, projectDir);
}

/** （重）装配：打开库 → 各 store/engine → memory 面（与 index.ts 生产装配同入口 openMemoryService 与同款 tracker 查询闭包 + 提取双桥 seam 注入，#32） */
function assemble(dbPath: string, dataRoot: string, projectDir: string, over?: {
  /** memory:event 捕获目标数组 */
  events?: MemoryEventWire[];
  /** readTranscript 桥覆盖（缺省：每个会话返回一段固定双视角历史） */
  readTranscript?: (sessionId: string) => Promise<TranscriptEvent[]>;
  /** runOnce 桥覆盖（缺省：记录调用并返回单段合法 JSON 输出） */
  runOnce?: (input: RunOnceCall) => Promise<RunOnceOutcome>;
  /** cancelRunOnce 桥覆盖 */
  cancelRunOnce?: (runId: string) => Promise<void>;
}) {
  const db = openDatabase(dbPath);
  const adapter: CliAdapter = new FakeAdapter({ clock: new VirtualClock() });
  const engine = new TrackerEngine(db);
  engine.restore();
  const sessions = new SessionStore(db);
  const projects = new ProjectStore(db);
  // 与 index.ts 生产装配一致的 tracker 查询闭包（memory 不依赖 tracker，由 Main 查询后传入）
  const listLinkedStructuredSessions = (requirementId: string): Array<{ sessionId: string; cli: string }> => {
    const out: Array<{ sessionId: string; cli: string }> = [];
    for (const [sessionId, reqId] of engine.tracker.sessionToReq) {
      if (reqId !== requirementId) continue;
      const s = sessions.get(sessionId);
      if (s && s.kind === "structured") out.push({ sessionId, cli: TRACKER_CLI_BY_APP[s.cli] ?? "claude-code" });
    }
    return out;
  };
  const listLinkedPtySessions = (requirementId: string): Array<{ sessionId: string }> => {
    const out: Array<{ sessionId: string }> = [];
    for (const [sessionId, reqId] of engine.tracker.sessionToReq) {
      if (reqId !== requirementId) continue;
      const s = sessions.get(sessionId);
      if (s && s.kind === "pty") out.push({ sessionId });
    }
    return out;
  };
    // fake 提取双桥（runOnce seam 注入点：无真实 CLI，缺省行为可覆盖；调用记录统一在装配层，覆盖亦可见）
    const runCalls: RunOnceCall[] = [];
    const cancelRunOnceCalls: string[] = [];
    const defaultReadTranscript = async (): Promise<TranscriptEvent[]> => [
      { role: "user", text: "e2e 历史：用户提出构建提速诉求" },
      { role: "assistant", text: "e2e 历史：完成了构建脚本改造" },
    ];
    const defaultRunOnce = async (): Promise<RunOnceOutcome> => ({
      status: "completed",
      exitCode: 0,
      stdout: JSON.stringify({
        summary: "e2e 段小结：完成构建脚本改造并验证。",
        candidates: [{ claim: "e2e 候选：构建必须走 pnpm filter", evidence: "e2e 历史实证", scope: "构建", sourceSessionIds: [] }],
      }),
      stderr: "",
      durationMs: 5,
    });
  const { service } = openMemoryService({
    db,
    dataRoot,
    listLinkedStructuredSessions,
    listLinkedPtySessions,
    getRequirementProjectId: (requirementId) => engine.tracker.req(requirementId)?.projectId ?? null,
    getRequirementTitle: (requirementId) => engine.tracker.req(requirementId)?.title ?? null,
    requirementExists: (requirementId) => engine.tracker.req(requirementId) != null,
    readTranscriptBridge: over?.readTranscript ?? defaultReadTranscript,
    runOnceBridge: async (input) => {
      runCalls.push(input);
      return (over?.runOnce ?? defaultRunOnce)(input);
    },
    cancelRunOnceBridge:
      over?.cancelRunOnce ??
      (async (runId) => {
        cancelRunOnceCalls.push(runId);
      }),
    emitMemoryEvent: (event) => over?.events?.push(event),
  });
  const deps: IpcDeps = {
    adapter,
    engine,
    projects,
    sessions,
    // #35：与 index.ts 生产装配一致注入 memory（kanban:delete 需求删除级联）
    memory: service,
    pty: makeFakePtyHost(),
    pickDirectory: async () => projectDir,
    getCurrentProjectId: () => null,
    setCurrentProjectId: () => undefined,
  };
  return {
    db,
    dbPath,
    dataRoot,
    projectDir,
    service,
    runCalls,
    cancelRunOnceCalls,
    handleKanban: (raw: unknown) => handleIpc(deps, raw),
    handleMemory: (raw: unknown) => handleMemoryIpc({ memory: service }, raw),
  };
}

/** 等待批次离开 running（管线异步落定；真实模型跑用大 timeoutMs） */
async function waitBatchTerminal(app: ReturnType<typeof assemble>, batchId: string, timeoutMs = 2000): Promise<MemoryBatchRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const b = app.service.store.getBatch(batchId);
    if (b && b.status !== "running") return b;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`批次 ${batchId} 未在时限内落定`);
}

/** 等待条件成立（轮询） */
async function waitUntilE2E(fn: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("条件未在时限内成立");
}

/** 预置一份「S3-05 提取完成」形态的产物：completed 批次 + 三条 pending 候选 + 总结 */
async function seedRequirement(app: ReturnType<typeof makeApp>) {
  // 真实 kanban:ipc 通道：注册项目 → 建需求 → 建 fake 会话并原子关联（spec #15 C 节）
  const reg = await app.handleKanban({ channel: "project:register" });
  expect(reg.ok).toBe(true);
  const projectId = reg.ok && reg.project ? reg.project.id : "";
  const created = await app.handleKanban({ channel: "kanban:create", projectId, title: "记忆提取需求" });
  const requirementId = created.ok ? created.requirementId! : "";
  expect(requirementId).toBeTruthy();
  const session = await app.handleKanban({
    channel: "session:create",
    cli: "fake",
    cwd: app.projectDir,
    projectId,
    requirementId,
  });
  expect(session.ok).toBe(true);
  // 关联成功（真实 kanban:ipc 原子关联路径）→ extract 不再 no-sessions（落到占位拒绝）
  const linked = session.ok ? session.linked : undefined;
  expect(linked).toBe(true);

  // 预置提取产物（模拟 S3-05 管线落库形态）
  app.service.store.createBatch({ id: "B1", requirementId, projectId, sourceSessionCount: 1 });
  const candidates = app.service.store.appendCandidates("B1", [
    { claim: "e2e 验证的结论甲", scope: "集成测试", evidence: "批次 B1", sourceSessionIds: ["s-e2e-1"] },
    { claim: "e2e 验证的结论乙", scope: "检索", evidence: "批次 B1", sourceSessionIds: ["s-e2e-1"] },
    { claim: "e2e 待忽略的结论", scope: "", evidence: "批次 B1", sourceSessionIds: ["s-e2e-1"] },
  ]);
  app.service.store.finishBatch("B1", { status: "completed" });
  app.service.summaries.writeSummary({
    requirementId,
    projectId,
    batchId: "B1",
    content: "# 需求开发总结（e2e）\n目标：验证 memory IPC 全链路。",
  });
  return { projectId, requirementId, candidates };
}

/** 预置「仅有活需求」形态：项目 + 需求 + 一个关联 fake 会话（无历史批次/候选/总结——提取/取消/删除竞态用例的干净基线） */
async function seedLiveRequirement(app: ReturnType<typeof makeApp>) {
  const reg = await app.handleKanban({ channel: "project:register" });
  expect(reg.ok).toBe(true);
  const projectId = reg.ok && reg.project ? reg.project.id : "";
  const created = await app.handleKanban({ channel: "kanban:create", projectId, title: "提取管线需求" });
  const requirementId = created.ok ? created.requirementId! : "";
  expect(requirementId).toBeTruthy();
  const session = await app.handleKanban({ channel: "session:create", cli: "fake", cwd: app.projectDir, projectId, requirementId });
  expect(session.ok ? session.linked : undefined).toBe(true);
  return { projectId, requirementId };
}

describe("memory:ipc B 类 e2e：审核 → 检索 → 重启保持（预置数据驱动，无门控）", () => {
  it("真实 IPC 通道走通三动作流转 / 终态拒绝 / 跨批次待审聚合 / 检索过滤与路径字段 / 重启保持", async () => {
    const app = makeApp();
    const { projectId, requirementId, candidates } = await seedRequirement(app);

    // ---- 审核 ----
    // 详情一次读：批次 + 跨批次候选 + 总结（标题来自真实 tracker 需求、正文可读、路径就绪）
    const detail = await app.handleMemory({ channel: "memory:requirementMemory", requirementId });
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.batches?.map((b) => [b.id, b.status])).toEqual([["B1", "completed"]]);
    expect(detail.candidates?.length).toBe(3);
    expect(detail.summary).toMatchObject({
      title: "记忆提取需求",
      mdPath: expect.stringContaining("summary.md"),
      content: expect.stringContaining("验证 memory IPC 全链路"),
    });

    // 第二批次遗留 pending → 跨批次待审聚合（US18）
    app.service.store.createBatch({ id: "B2", requirementId, projectId });
    app.service.store.appendCandidates("B2", [
      { claim: "第二批次遗留待审", scope: "", evidence: "批次 B2", sourceSessionIds: [] },
    ]);
    const withTwo = await app.handleMemory({ channel: "memory:requirementMemory", requirementId });
    expect(withTwo.ok).toBe(true);
    if (withTwo.ok) expect(withTwo.candidates?.length).toBe(4);

    // 三动作：accept / edit / ignore（accept 落 md 路径且文件真实存在——复制路径可用）
    const acc = await app.handleMemory({ channel: "memory:reviewCandidate", candidateId: candidates[0].id, action: "accept" });
    expect(acc.ok).toBe(true);
    if (acc.ok) expect(existsSync(acc.candidate?.mdPath ?? "")).toBe(true);
    const ed = await app.handleMemory({
      channel: "memory:reviewCandidate",
      candidateId: candidates[1].id,
      action: "edit",
      edit: { claim: "e2e 验证的结论乙（编辑后）" },
    });
    expect(ed.ok).toBe(true);
    const ig = await app.handleMemory({ channel: "memory:reviewCandidate", candidateId: candidates[2].id, action: "ignore" });
    expect(ig.ok).toBe(true);

    // 终态拒绝：对 accepted 再 ignore → 业务拒绝 reason（不走错误码）
    const final = await app.handleMemory({ channel: "memory:reviewCandidate", candidateId: candidates[0].id, action: "ignore" });
    expect(final).toMatchObject({ ok: false, reason: "candidate-final" });

    // ---- 检索 ----
    const all = await app.handleMemory({ channel: "memory:projectMemory", projectId });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.knowledge?.length).toBe(2); // accepted + edited；pending/ignored 不进
    expect(all.knowledge?.every((k) => k.mdPath && existsSync(k.mdPath))).toBe(true);
    expect(all.summaries?.length).toBe(1);

    // 大小写不敏感命中标题（claim 编辑后有效值）与总结标题
    const byKnowledge = await app.handleMemory({ channel: "memory:projectMemory", projectId, query: "E2E 验证" });
    expect(byKnowledge.ok).toBe(true);
    if (byKnowledge.ok) expect(byKnowledge.knowledge?.length).toBe(2);
    const bySummaryTitle = await app.handleMemory({ channel: "memory:projectMemory", projectId, query: "记忆提取" });
    expect(bySummaryTitle.ok).toBe(true);
    if (bySummaryTitle.ok) expect(bySummaryTitle.summaries?.length).toBe(1);

    // 知识再编辑（US21）
    const edited = await app.handleMemory({ channel: "memory:editAccepted", candidateId: candidates[0].id, scope: "e2e 修订范围" });
    expect(edited.ok).toBe(true);

    // ---- 重启保持（US25）：关库重开（同 index.ts 装配路径）→ 审核状态/知识/总结全部保持 ----
    app.db.close();
    const relaunched = assemble(app.dbPath, app.dataRoot, join(tmpRoot, "proj"));
    const kept = await relaunched.handleMemory({ channel: "memory:requirementMemory", requirementId });
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    const statuses = Object.fromEntries((kept.candidates ?? []).map((c) => [c.displayNo, c.status]));
    expect(Object.values(statuses).filter((s) => s === "accepted").length).toBe(1);
    expect(Object.values(statuses).filter((s) => s === "edited").length).toBe(1);
    expect(Object.values(statuses).filter((s) => s === "ignored").length).toBe(1);
    expect(Object.values(statuses).filter((s) => s === "pending").length).toBe(1); // 跨批次遗留 pending 也保持
    expect(kept.summary?.content).toContain("验证 memory IPC 全链路");

    const keptProject = await relaunched.handleMemory({ channel: "memory:projectMemory", projectId });
    expect(keptProject.ok).toBe(true);
    if (keptProject.ok) {
      expect(keptProject.knowledge?.length).toBe(2);
      const revised = keptProject.knowledge?.find((k) => k.editedScope === "e2e 修订范围");
      expect(revised).toBeTruthy();
    }

    // 业务拒绝与真实启动（#32）：重启后新需求无关联会话 → extract no-sessions；
    // 有会话需求 → 经 fake 桥真实启动并完成（占位拒绝已由真实现取代）
    const req2 = await relaunched.handleKanban({ channel: "kanban:create", projectId, title: "第二个需求" });
    const noSessions = await relaunched.handleMemory({
      channel: "memory:extract",
      requirementId: req2.ok ? req2.requirementId! : "",
    });
    expect(noSessions).toMatchObject({ ok: false, reason: "no-sessions" });
    const started = await relaunched.handleMemory({ channel: "memory:extract", requirementId });
    expect(started).toMatchObject({ ok: true, started: true });
    if (started.ok && started.batchId) {
      const batch = await waitBatchTerminal(relaunched, started.batchId);
      expect(batch.status).toBe("completed");
    }
    const noRunning = await relaunched.handleMemory({ channel: "memory:cancel", requirementId });
    expect(noRunning).toMatchObject({ ok: false, reason: "no-extraction-running" });
    relaunched.db.close();
  });

  it("伪造 running 批次（崩溃遗留）重启后对账为 failed，不锁死需求", async () => {
    const app = makeApp();
    const { projectId, requirementId } = await seedRequirement(app);
    // 模拟上次会话崩溃：库内遗留 running 批次
    app.service.store.createBatch({ id: "B-crash", requirementId, projectId, sourceSessionCount: 1 });

    app.db.close();
    const relaunched = assemble(app.dbPath, app.dataRoot, join(tmpRoot, "proj"));
    const detail = await relaunched.handleMemory({ channel: "memory:requirementMemory", requirementId });
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    const crashed = (detail.batches ?? []).find((b) => b.id === "B-crash");
    expect(crashed).toMatchObject({ status: "failed", error: "应用中断" });

    // 不锁死需求：无 running 残留 → extract 可真实再次发起（fake 桥完成，而非 extraction-running/占位拒绝）
    const extract = await relaunched.handleMemory({ channel: "memory:extract", requirementId });
    expect(extract).toMatchObject({ ok: true, started: true });
    if (extract.ok && extract.batchId) {
      expect((await waitBatchTerminal(relaunched, extract.batchId)).status).toBe("completed");
    }
    relaunched.db.close();
  });

  it("kanban:delete 级联（issue #35 spec #27 J 节 US22）：知识保留且可检索、总结与需求级记录清理、目录清除、重启不复活", async () => {
    const app = makeApp();
    const { projectId, requirementId, candidates } = await seedRequirement(app);
    // 审核出混合终态：accepted / edited / ignored；B2 的遗留 pending 保持待审（需求级清理对象）
    await app.handleMemory({ channel: "memory:reviewCandidate", candidateId: candidates[0].id, action: "accept" });
    await app.handleMemory({
      channel: "memory:reviewCandidate",
      candidateId: candidates[1].id,
      action: "edit",
      edit: { claim: "e2e 验证的结论乙（编辑后）" },
    });
    await app.handleMemory({ channel: "memory:reviewCandidate", candidateId: candidates[2].id, action: "ignore" });
    // 人工编辑总结后重提取 → proposed 暂存（US14；暂存文件随 requirements/<REQ>/ 目录一并清理）
    app.service.store.createBatch({ id: "B3", requirementId, projectId });
    app.service.store.finishBatch("B3", { status: "completed" });
    const summaryMd = app.service.summaries.getSummary(requirementId)?.mdPath ?? "";
    writeFileSync(summaryMd, "# 需求开发总结（e2e）\n人工编辑过的版本。", "utf8");
    app.service.summaries.writeSummary({ requirementId, projectId, batchId: "B3", content: "# 需求开发总结（e2e）\n重提取的新版。" });

    // 真实 kanban:delete 通道（级联经 Main 的 deps.memory 接线触发）
    const del = await app.handleKanban({ channel: "kanban:delete", requirementId });
    expect(del.ok).toBe(true);

    // 删除后检索（验收第 1 条）：已接受知识仍在且可检索，该需求总结行消失
    const searched = await app.handleMemory({ channel: "memory:projectMemory", projectId, query: "e2e 验证" });
    expect(searched.ok).toBe(true);
    if (!searched.ok) return;
    expect(searched.knowledge?.length).toBe(2);
    expect(searched.knowledge?.every((k) => k.mdPath && existsSync(k.mdPath))).toBe(true);
    expect(searched.summaries).toEqual([]);
    const all = await app.handleMemory({ channel: "memory:projectMemory", projectId });
    if (all.ok) expect(all.summaries).toEqual([]);

    // 详情一次读：批次清空、pending/ignored 候选清理（accepted/edited 行保留）、总结无
    const detail = await app.handleMemory({ channel: "memory:requirementMemory", requirementId });
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.batches).toEqual([]);
    expect(detail.candidates?.map((c) => c.status).sort()).toEqual(["accepted", "edited"]);
    expect(detail.summary).toBeNull();

    // 存储布局（验收第 2 条）：requirements/<REQ>/ 目录清除（summary.md 与 proposed 一并）；accepted/ 目录与文件完整
    expect(existsSync(join(app.dataRoot, projectId, "requirements", requirementId))).toBe(false);
    expect(existsSync(join(app.dataRoot, projectId, "accepted"))).toBe(true);

    // 重启保持：清理是持久性的——重开后知识仍在、被清理的总结与批次不复活
    app.db.close();
    const relaunched = assemble(app.dbPath, app.dataRoot, join(tmpRoot, "proj"));
    const kept = await relaunched.handleMemory({ channel: "memory:projectMemory", projectId });
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(kept.knowledge?.length).toBe(2);
    expect(kept.summaries).toEqual([]);
    const keptDetail = await relaunched.handleMemory({ channel: "memory:requirementMemory", requirementId });
    if (keptDetail.ok) expect(keptDetail.batches).toEqual([]);
    relaunched.db.close();
  });
});

describe("memory:ipc B 类 e2e：提取管线全流程（issue #32，fake 桥经 runOnce seam 注入）", () => {
  it("真实通道提取：双会话两段 → completed（元信息/候选/总结）+ 四步进度事件序列 + 临时执行隔离参数", async () => {
    const events: MemoryEventWire[] = [];
    const app = makeApp();
    const { projectId, requirementId } = await seedRequirement(app);
    // 第二个关联会话（真实 kanban:ipc 原子关联）→ 会话边界分段出两段
    const s2 = await app.handleKanban({
      channel: "session:create",
      cli: "fake",
      cwd: app.projectDir,
      projectId,
      requirementId,
    });
    expect(s2.ok).toBe(true);

    // 按会话区分的 transcript + 按调用序产出段小结的 runOnce（记录调用供隔离断言）
    const transcripts = new Map<string, TranscriptEvent[]>();
    const first = await app.handleKanban({ channel: "session:list", projectId });
    if (first.ok && first.sessions && first.sessions.length >= 2) {
      const linked = first.sessions.filter((s) => s.kind === "structured");
      transcripts.set(linked[0].id, [
        { role: "user", text: "e2e 历史甲：用户提出构建提速诉求" },
        { role: "assistant", text: "e2e 历史甲：完成构建脚本改造" },
      ]);
      transcripts.set(linked[1].id, [{ role: "assistant", text: "e2e 历史乙：验证构建命令可用" }]);
    }
    let callNo = 0;
    const app2 = assemble(app.dbPath, app.dataRoot, app.projectDir, {
      events,
      readTranscript: async (sessionId) => transcripts.get(sessionId) ?? [],
      runOnce: async () => {
        callNo += 1;
        return {
          status: "completed",
          exitCode: 0,
          stdout: JSON.stringify({
            summary: `e2e 段小结 ${callNo}：完成构建改造。`,
            candidates: [{ claim: `e2e 候选 ${callNo}：构建走 pnpm filter`, evidence: "e2e 实证", scope: "构建", sourceSessionIds: [] }],
          }),
          stderr: "",
          durationMs: 4,
        };
      },
    });
    app.db.close(); // seedRequirement 用库句柄关闭，后续走 app2（同库同 dataRoot）

    let batchId = "";
    try {
    const started = await app2.handleMemory({ channel: "memory:extract", requirementId });
    expect(started).toMatchObject({ ok: true, started: true });
    if (!started.ok || !started.batchId) return;
    batchId = started.batchId;
    const batch = await waitBatchTerminal(app2, batchId);
    expect(batch).toMatchObject({ status: "completed", sourceSessionCount: 2, missingSessions: [], chunkCount: 2, modelCallCount: 2 });

    // 产物经真实 requirementMemory 通道读回：新候选（跨段相似 claim 合并、来源覆盖两会话）+ 总结（两段小结合并、来源声明）
    const detail = await app2.handleMemory({ channel: "memory:requirementMemory", requirementId });
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    const extracted = detail.candidates?.filter((c) => c.batchId === batchId) ?? [];
    expect(extracted.length).toBe(1); // 「e2e 候选 1/2」相似 claim 跨段合并为一条
    expect(extracted[0].status).toBe("pending");
    expect(extracted[0].sourceSessionIds.length).toBe(2); // 来源并集覆盖两段会话
    expect(detail.summary?.content).toContain("e2e 段小结 1");
    expect(detail.summary?.content).toContain("e2e 段小结 2");
    expect(detail.summary?.content).toContain("来源 Session");

    // 三层隔离：临时执行 cwd 在应用数据目录（dataRoot/<projectId>/extract-tmp/<batchId>）
    expect(app2.runCalls.length).toBe(2);
    for (const call of app2.runCalls) {
      expect(call.cwd).toBe(join(app2.dataRoot, projectId, "extract-tmp", batchId));
      expect(existsSync(call.cwd)).toBe(true);
      expect(call.cli).toBe("claude");
      expect(call.args[0]).toBe("-p");
    }

    // 进度事件序列（US8 四步 + i/n 段进度 + 批次状态首尾）
    expect(events).toEqual([
      { type: "batch-status", batchId, requirementId, status: "running" },
      { type: "chunk-progress", batchId, requirementId, step: "reading", chunkIndex: 0, chunkCount: 0 },
      { type: "chunk-progress", batchId, requirementId, step: "chunking", chunkIndex: 0, chunkCount: 0 },
      { type: "chunk-progress", batchId, requirementId, step: "extracting", chunkIndex: 0, chunkCount: 2 },
      { type: "chunk-progress", batchId, requirementId, step: "extracting", chunkIndex: 1, chunkCount: 2 },
      { type: "chunk-progress", batchId, requirementId, step: "merging", chunkIndex: 0, chunkCount: 0 },
      { type: "batch-status", batchId, requirementId, status: "completed" },
    ]);
    } finally {
      app2.db.close();
    }
  }, 15_000);

  it("真实通道取消：进行中批次 memory:cancel → 终止当前段临时执行、整批丢弃无产物", async () => {
    const events: MemoryEventWire[] = [];
    const app = makeApp();
    const { requirementId } = await seedLiveRequirement(app);
    let resolveRun!: (r: RunOnceOutcome) => void;
    const app2 = assemble(app.dbPath, app.dataRoot, app.projectDir, {
      events,
      runOnce: () =>
        new Promise<RunOnceOutcome>((r) => {
          resolveRun = r;
        }),
    });
    app.db.close();
    try {
    const started = await app2.handleMemory({ channel: "memory:extract", requirementId });
    expect(started).toMatchObject({ ok: true, started: true });
    if (!started.ok || !started.batchId) return;
    await waitUntilE2E(() => app2.runCalls.length === 1);

    const cancelP = app2.handleMemory({ channel: "memory:cancel", requirementId });
    expect(app2.cancelRunOnceCalls).toEqual([app2.runCalls[0].runId]); // 终止当前段临时执行
    resolveRun({ status: "cancelled", exitCode: null, stdout: "", stderr: "", durationMs: 3 });
    expect(await cancelP).toMatchObject({ ok: true, cancelled: true });

    const batch = await waitBatchTerminal(app2, started.batchId);
    expect(batch.status).toBe("cancelled");
    const detail = await app2.handleMemory({ channel: "memory:requirementMemory", requirementId });
    if (detail.ok) {
      expect(detail.candidates).toEqual([]); // 整批丢弃：无候选落库（干净基线无历史批次）
      expect(detail.summary).toBeNull(); // 无总结
    }
    expect(events.at(-1)).toMatchObject({ type: "batch-status", status: "cancelled" });
    } finally {
      app2.db.close();
    }
  }, 15_000);

  it("提取中需求被删除（真实 kanban:delete 级联，#35 边界）：段完成后整批丢弃，不复活孤儿数据", async () => {
    const events: MemoryEventWire[] = [];
    const app = makeApp();
    const { projectId, requirementId } = await seedRequirement(app);
    let resolveRun!: (r: RunOnceOutcome) => void;
    const app2 = assemble(app.dbPath, app.dataRoot, app.projectDir, {
      events,
      runOnce: () =>
        new Promise<RunOnceOutcome>((r) => {
          resolveRun = r;
        }),
    });
    app.db.close();
    try {
    const started = await app2.handleMemory({ channel: "memory:extract", requirementId });
    expect(started).toMatchObject({ ok: true, started: true });
    if (!started.ok || !started.batchId) return;
    await waitUntilE2E(() => app2.runCalls.length === 1);

    // 真实删除通道：级联清 running 批次行 + requirements 目录，tracker 除名
    const del = await app2.handleKanban({ channel: "kanban:delete", requirementId });
    expect(del.ok).toBe(true);
    resolveRun({
      status: "completed",
      exitCode: 0,
      stdout: JSON.stringify({ summary: "迟到的总结。", candidates: [{ claim: "迟到的候选", evidence: "e", scope: "s", sourceSessionIds: [] }] }),
      stderr: "",
      durationMs: 3,
    });
    await new Promise((r) => setTimeout(r, 50));

    // 整批丢弃：批次/候选/总结均不复活（级联结果保持）
    expect(app2.service.store.listBatches(requirementId)).toEqual([]);
    expect(app2.service.store.listRequirementCandidates(requirementId)).toEqual([]);
    expect(app2.service.summaries.getSummary(requirementId)).toBeNull();
    expect(existsSync(join(app2.dataRoot, projectId, "requirements", requirementId))).toBe(false);
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "batch-status", status: "cancelled" });
    if (last?.type === "batch-status") expect(last.error).toContain("需求已删除");
    } finally {
      app2.db.close();
    }
  }, 15_000);
});

// 真实 Claude headless 提取预演（KANBAN_E2E=1 门控；spec Testing 验收票 #37 前的最小真跑；
// claude exe 不可解析时跳过并如实标注——不视为失败）
const E2E = process.env.KANBAN_E2E === "1";
let claudeExeOk = false;
if (E2E) {
  try {
    resolveClaudeExe();
    claudeExeOk = true;
  } catch {
    claudeExeOk = false;
  }
}

describe.skipIf(!E2E || !claudeExeOk)("真实 claude headless 提取（KANBAN_E2E=1 门控，模型调用预算 1 次）", () => {
  it("最小历史真实提取一次：completed、总结与候选落盘、modelCallCount 如实", async () => {
    const events: MemoryEventWire[] = [];
    const app = makeApp();
    const { requirementId } = await seedRequirement(app);
    const runner = new RunOnceRunner();
    const app2 = assemble(app.dbPath, app.dataRoot, app.projectDir, {
      events,
      readTranscript: async () => [
        { role: "user", text: "真实提取预演：请基于这句历史输出小结与一条候选。" },
        { role: "assistant", text: "好的，已收到最小历史。" },
      ],
      runOnce: (input) => runner.run(input),
    });
    app.db.close();
    const started = await app2.handleMemory({ channel: "memory:extract", requirementId });
    expect(started).toMatchObject({ ok: true, started: true });
    if (!started.ok || !started.batchId) return;
    const batch = await waitBatchTerminal(app2, started.batchId, 350_000); // 真实模型调用耗时放宽
    expect(batch.status).toBe("completed");
    expect(batch.modelCallCount).toBeGreaterThanOrEqual(1);
    const detail = await app2.handleMemory({ channel: "memory:requirementMemory", requirementId });
    if (detail.ok) {
      expect(detail.summary?.content).toBeTruthy();
      expect(detail.summary?.mdPath).toContain("summary.md");
    }
    app2.db.close();
  }, 360_000);
});
