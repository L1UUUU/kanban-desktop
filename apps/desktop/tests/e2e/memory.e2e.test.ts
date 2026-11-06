// 用途：memory B 类 e2e（issue #31 验收 + #35 需求删除级联）—— 经真实 handleIpc（kanban:ipc：建项目/需求/会话关联/删除）与 handleMemoryIpc（memory:ipc）完成「审核 → 检索 → 重启保持」+ 伪造 running 批次重启对账 + kanban:delete 级联清理；fake/预置数据驱动、无真实 CLI 依赖，故不设 KANBAN_E2E 门控（全部断言默认跑；真实 Claude 提取属 S3-05 验收票）
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CliAdapter } from "@kanban/cli-host";
import { FakeAdapter, VirtualClock } from "@kanban/cli-host";
import { TrackerEngine } from "@kanban/tracker";
import { openDatabase } from "../../electron/main/db";
import { handleIpc, handleMemoryIpc, TRACKER_CLI_BY_APP, type IpcDeps } from "../../electron/main/ipc";
import { openMemoryService } from "../../electron/main/memory-service";
import { ProjectStore } from "../../electron/main/project-store";
import { SessionStore } from "../../electron/main/session-store";
import type { PtyHost } from "../../electron/main/pty-host";

let tmpRoot = "";

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
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

/** （重）装配：打开库 → 各 store/engine → memory 面（与 index.ts 生产装配同入口 openMemoryService 与同款 tracker 查询闭包） */
function assemble(dbPath: string, dataRoot: string, projectDir: string) {
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
  const { service } = openMemoryService({
    db,
    dataRoot,
    listLinkedStructuredSessions,
    getRequirementTitle: (requirementId) => engine.tracker.req(requirementId)?.title ?? null,
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
    handleKanban: (raw: unknown) => handleIpc(deps, raw),
    handleMemory: (raw: unknown) => handleMemoryIpc({ memory: service }, raw),
  };
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

    // 业务拒绝形状：重启后新需求无关联会话 → extract no-sessions；有会话需求 → 占位拒绝
    const req2 = await relaunched.handleKanban({ channel: "kanban:create", projectId, title: "第二个需求" });
    const noSessions = await relaunched.handleMemory({
      channel: "memory:extract",
      requirementId: req2.ok ? req2.requirementId! : "",
    });
    expect(noSessions).toMatchObject({ ok: false, reason: "no-sessions" });
    const placeholder = await relaunched.handleMemory({ channel: "memory:extract", requirementId });
    expect(placeholder).toMatchObject({ ok: false, reason: "cli-unavailable" });
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

    // 不锁死需求：无 running 残留 → extract 落到占位拒绝（而非 extraction-running）
    const extract = await relaunched.handleMemory({ channel: "memory:extract", requirementId });
    expect(extract).toMatchObject({ ok: false, reason: "cli-unavailable" });
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
