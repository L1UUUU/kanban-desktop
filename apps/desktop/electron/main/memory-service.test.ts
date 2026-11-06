// 用途：MemoryService 密封测试 + handleMemoryIpc 入站校验与路由 + openMemoryService 启动对账（issue #31，spec #27 A/C/H 节；store 级动作全量、extract/cancel 业务拒绝占位、projectMemory 查询过滤、需求删除级联 #35）
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDb } from "./db";
import { handleMemoryIpc } from "./ipc";
import { openMemoryService } from "./memory-service";

let tmpRoot = "";

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

/**
 * 装配被测件：:memory: 库 + 独立临时 dataRoot + 可注入的 tracker 查询 fake（关联会话/需求标题），
 * 经 openMemoryService（与 index.ts 生产装配同入口）实例化。
 */
function makeService() {
  tmpRoot = mkdtempSync(join(tmpdir(), "kb-memory-svc-"));
  const db: SqliteDb = openDatabase(":memory:");
  const linkedSessions = new Map<string, Array<{ sessionId: string; cli: string }>>();
  const titles = new Map<string, string>();
  const { service } = openMemoryService({
    db,
    dataRoot: join(tmpRoot, "memory"),
    listLinkedStructuredSessions: (requirementId) => linkedSessions.get(requirementId) ?? [],
    getRequirementTitle: (requirementId) => titles.get(requirementId) ?? null,
  });
  return {
    service,
    handle: (raw: unknown) => handleMemoryIpc({ memory: service }, raw),
    linkedSessions,
    titles,
    db,
    dataRoot: join(tmpRoot, "memory"),
  };
}

/** 预置一个已完成的批次 + 若干候选 + 总结（模拟 S3-05 提取完成后的库内产物） */
function seedExtracted(ctx: ReturnType<typeof makeService>, over?: { requirementId?: string; projectId?: string }) {
  const requirementId = over?.requirementId ?? "REQ-001";
  const projectId = over?.projectId ?? "p1";
  ctx.titles.set(requirementId, "Windows 打包需求");
  ctx.linkedSessions.set(requirementId, [
    { sessionId: "s1", cli: "claude-code" },
    { sessionId: "s2", cli: "codex" },
  ]);
  ctx.service.store.createBatch({ id: "B1", requirementId, projectId, sourceSessionCount: 2 });
  const candidates = ctx.service.store.appendCandidates("B1", [
    { claim: "spawn 须直连 exe 不经 shell", scope: "CLI 集成", evidence: "PoC 2 实证", sourceSessionIds: ["s1"] },
    { claim: "总结分段按会话边界优先", scope: "记忆提取", evidence: "PoC 5 实证", sourceSessionIds: ["s2"] },
    { claim: "待审核的另一条", scope: "", evidence: "e", sourceSessionIds: ["s1"] },
  ]);
  ctx.service.store.finishBatch("B1", { status: "completed" });
  ctx.service.summaries.writeSummary({ requirementId, projectId, batchId: "B1", content: "# 需求开发总结\n目标：完成提取。" });
  return { batchId: "B1", requirementId, projectId, candidates };
}

describe("extract / cancel 业务拒绝占位（提取管线 S3-05 接线）", () => {
  it("零关联 structured 会话 → no-sessions（提取按钮禁用/拒绝的依据）", async () => {
    const { service } = makeService();
    const r = service.extract("REQ-001");
    expect(r).toMatchObject({ ok: false, reason: "no-sessions" });
  });

  it("有会话但无 running 批次 → cli-unavailable 占位（无法真实启动）", async () => {
    const ctx = makeService();
    ctx.linkedSessions.set("REQ-001", [{ sessionId: "s1", cli: "claude-code" }]);
    const r = ctx.service.extract("REQ-001");
    expect(r).toMatchObject({ ok: false, reason: "cli-unavailable" });
  });

  it("该需求已有 running 批次 → extraction-running（防重复触发，US11）", () => {
    const ctx = makeService();
    ctx.linkedSessions.set("REQ-001", [{ sessionId: "s1", cli: "claude-code" }]);
    ctx.service.store.createBatch({ id: "B-run", requirementId: "REQ-001", projectId: "p1" });
    expect(ctx.service.extract("REQ-001")).toMatchObject({ ok: false, reason: "extraction-running" });
  });

  it("cancel：无 running 批次 → no-extraction-running；有 running → 占位拒绝（取消管线随 S3-05）", () => {
    const ctx = makeService();
    expect(ctx.service.cancel("REQ-001")).toMatchObject({ ok: false, reason: "no-extraction-running" });
    ctx.service.store.createBatch({ id: "B-run", requirementId: "REQ-001", projectId: "p1" });
    expect(ctx.service.cancel("REQ-001")).toMatchObject({ ok: false, reason: "extraction-running" });
  });
});

describe("reviewCandidate 三动作与终态拒绝", () => {
  it("accept / edit / ignore 流转成功，accept/edit 落 md 路径", () => {
    const ctx = makeService();
    const { candidates } = seedExtracted(ctx);
    const [c1, c2, c3] = candidates;

    const acc = ctx.service.reviewCandidate(c1.id, "accept");
    expect(acc.ok).toBe(true);
    if (acc.ok) {
      expect(acc.candidate?.status).toBe("accepted");
      expect(acc.candidate?.mdPath).toBeTruthy();
      expect(existsSync(acc.candidate?.mdPath ?? "")).toBe(true);
    }

    const ed = ctx.service.reviewCandidate(c2.id, "edit", { claim: "编辑后的 claim", scope: "编辑后的范围" });
    expect(ed.ok).toBe(true);
    if (ed.ok) {
      expect(ed.candidate).toMatchObject({ status: "edited", editedClaim: "编辑后的 claim", editedScope: "编辑后的范围" });
    }

    const ig = ctx.service.reviewCandidate(c3.id, "ignore");
    expect(ig.ok).toBe(true);
    if (ig.ok) expect(ig.candidate?.status).toBe("ignored");
  });

  it("终态候选再审核 → candidate-final 业务拒绝（不抛错、带终态说明）", () => {
    const ctx = makeService();
    const { candidates } = seedExtracted(ctx);
    ctx.service.reviewCandidate(candidates[0].id, "accept");
    const r = ctx.service.reviewCandidate(candidates[0].id, "ignore");
    expect(r).toMatchObject({ ok: false, reason: "candidate-final" });
    if (!r.ok) expect(r.detail).toContain("accepted");
  });

  it("候选不存在 → candidate-not-found；edit 无修改项 → edit-empty", () => {
    const ctx = makeService();
    expect(ctx.service.reviewCandidate("ghost", "accept")).toMatchObject({ ok: false, reason: "candidate-not-found" });
    const { candidates } = seedExtracted(ctx);
    expect(ctx.service.reviewCandidate(candidates[0].id, "edit")).toMatchObject({ ok: false, reason: "edit-empty" });
  });
});

describe("resolveSummary 二选一处置", () => {
  it("无未处置 proposed → no-proposed", () => {
    const ctx = makeService();
    seedExtracted(ctx);
    expect(ctx.service.resolveSummary("REQ-001", "accept-new")).toMatchObject({ ok: false, reason: "no-proposed" });
  });

  it("有 proposed → keep-human 处置成功且指针清除（经 requirementMemory 验证）", () => {
    const ctx = makeService();
    seedExtracted(ctx);
    // 人工编辑磁盘总结 → 再写新版产生 proposed（复用 #30 防覆盖机制）
    const row = ctx.service.summaries.getSummary("REQ-001");
    expect(row).toBeTruthy();
    writeFileSync(row!.mdPath, "人工编辑过的总结", "utf8");
    ctx.service.store.createBatch({ id: "B2", requirementId: "REQ-001", projectId: "p1" });
    ctx.service.summaries.writeSummary({ requirementId: "REQ-001", projectId: "p1", batchId: "B2", content: "新版总结" });

    const r = ctx.service.resolveSummary("REQ-001", "keep-human");
    expect(r.ok).toBe(true);
    const after = ctx.service.requirementMemory("REQ-001");
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.summary?.proposedBatchId).toBeNull();
  });
});

describe("requirementMemory 一次读（批次 + 跨批次候选 + 总结）", () => {
  it("返回全部批次/候选（含跨批次 pending 累计）与总结（标题 + 正文 + 路径）", () => {
    const ctx = makeService();
    const { candidates } = seedExtracted(ctx);
    // 第二个批次再产一条 pending（跨批次累计，US18）
    ctx.service.store.createBatch({ id: "B2", requirementId: "REQ-001", projectId: "p1" });
    ctx.service.store.appendCandidates("B2", [
      { claim: "第二批新候选", scope: "", evidence: "", sourceSessionIds: ["s1"] },
    ]);

    const r = ctx.service.requirementMemory("REQ-001");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.batches?.map((b) => b.id)).toEqual(["B1", "B2"]);
    expect(r.candidates?.length).toBe(4); // 首批 3 + 次批 1（跨批次累计）
    expect(r.candidates?.every((c) => candidates.some((s) => s.id === c.id) || c.claim === "第二批新候选")).toBe(true);
    expect(r.summary).toMatchObject({
      requirementId: "REQ-001",
      title: "Windows 打包需求",
      content: expect.stringContaining("需求开发总结"),
      mdPath: expect.stringContaining("summary.md"),
    });
  });

  it("无数据需求返回空集与 null 总结（宽容形状）", () => {
    const ctx = makeService();
    const r = ctx.service.requirementMemory("REQ-404");
    expect(r).toMatchObject({ ok: true, batches: [], candidates: [], summary: null });
  });
});

describe("projectMemory（知识 + 总结一次读，含正文与查询过滤）", () => {
  it("无查询：返回 accepted/edited 知识（pending/ignored 不进）与总结行（含正文、标题、复制路径）", () => {
    const ctx = makeService();
    const { candidates } = seedExtracted(ctx);
    ctx.service.reviewCandidate(candidates[0].id, "accept");
    ctx.service.reviewCandidate(candidates[1].id, "edit", { claim: "分段策略（编辑后）" });
    // candidates[2] 保持 pending；另预置一条 ignored
    ctx.service.store.createBatch({ id: "B3", requirementId: "REQ-001", projectId: "p1" });
    const [ig] = ctx.service.store.appendCandidates("B3", [
      { claim: "被忽略的知识", scope: "", evidence: "", sourceSessionIds: [] },
    ]);
    ctx.service.reviewCandidate(ig.id, "ignore");

    const r = ctx.service.projectMemory("p1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.knowledge?.map((k) => k.status)).toEqual(["accepted", "edited"]);
    expect(r.knowledge?.every((k) => k.mdPath && existsSync(k.mdPath))).toBe(true);
    expect(r.summaries?.length).toBe(1);
    expect(r.summaries?.[0]).toMatchObject({
      title: "Windows 打包需求",
      content: expect.stringContaining("需求开发总结"),
      mdPath: expect.stringContaining("summary.md"),
    });
  });

  it("查询过滤：大小写不敏感命中知识标题（claim）与总结标题；正文命中（scope/evidence/content）；pending/ignored 不进结果", () => {
    const ctx = makeService();
    const { candidates } = seedExtracted(ctx);
    ctx.service.reviewCandidate(candidates[0].id, "accept"); // claim: spawn 须直连 exe 不经 shell
    ctx.service.reviewCandidate(candidates[2].id, "ignore"); // 待审核的另一条 → ignored

    // 大小写不敏感命中知识 claim（标题字段）
    const byClaim = ctx.service.projectMemory("p1", "SPAWN");
    expect(byClaim.ok).toBe(true);
    if (byClaim.ok) expect(byClaim.knowledge?.map((k) => k.claim)).toEqual(["spawn 须直连 exe 不经 shell"]);

    // 命中知识正文字段（scope/evidence）
    const byScope = ctx.service.projectMemory("p1", "CLI 集成");
    expect(byScope.ok).toBe(true);
    if (byScope.ok) expect(byScope.knowledge?.length).toBe(1);

    // 命中总结标题（需求标题）
    const byTitle = ctx.service.projectMemory("p1", "打包");
    expect(byTitle.ok).toBe(true);
    if (byTitle.ok) expect(byTitle.summaries?.length).toBe(1);

    // 命中总结正文
    const byContent = ctx.service.projectMemory("p1", "完成提取");
    expect(byContent.ok).toBe(true);
    if (byContent.ok) expect(byContent.summaries?.length).toBe(1);

    // 无匹配 → 双空
    const none = ctx.service.projectMemory("p1", "不存在的关键词 xyz");
    expect(none).toMatchObject({ ok: true, knowledge: [], summaries: [] });
  });

  it("项目隔离：其他项目的知识/总结不进", () => {
    const ctx = makeService();
    const { candidates } = seedExtracted(ctx);
    ctx.service.reviewCandidate(candidates[0].id, "accept");
    const r = ctx.service.projectMemory("p-other");
    expect(r).toMatchObject({ ok: true, knowledge: [], summaries: [] });
  });
});

describe("editAccepted 已接受知识再编辑", () => {
  it("更新 claim/scope 并重写 md；pending 知识拒绝（应走审核 edit）", () => {
    const ctx = makeService();
    const { candidates } = seedExtracted(ctx);
    ctx.service.reviewCandidate(candidates[0].id, "accept");
    const r = ctx.service.editAccepted(candidates[0].id, { claim: "修订后的知识" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.candidate?.editedClaim).toBe("修订后的知识");

    expect(ctx.service.editAccepted(candidates[1].id, { claim: "x" })).toMatchObject({ ok: false, reason: "candidate-not-editable" });
  });
});

describe("deleteRequirementData 需求删除级联（issue #35，spec #27 J 节 US22）", () => {
  it("删除后 projectMemory：已接受知识仍在且可检索、该需求总结行消失；requirements/<REQ>/ 清除、accepted/ 完整", () => {
    const ctx = makeService();
    const { requirementId, projectId, candidates } = seedExtracted(ctx);
    // 审核出混合终态：accepted / edited；candidates[2] 留 pending（待审，应随需求清理）
    ctx.service.reviewCandidate(candidates[0].id, "accept");
    ctx.service.reviewCandidate(candidates[1].id, "edit", { claim: "总结分段按会话边界优先（编辑后）" });

    const before = ctx.service.projectMemory(projectId);
    expect(before.ok && before.knowledge.length === 2 && before.summaries.length === 1).toBe(true);

    ctx.service.deleteRequirementData(requirementId, projectId);

    // projectMemory（issue #35 验收第 1 条）：已接受知识仍在且可检索，总结行消失
    const after = ctx.service.projectMemory(projectId);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.knowledge).toHaveLength(2);
    expect(after.knowledge.every((k) => k.mdPath && existsSync(k.mdPath))).toBe(true);
    expect(after.summaries).toEqual([]);
    const hit = ctx.service.projectMemory(projectId, "直连");
    expect(hit.ok && hit.knowledge.length === 1).toBe(true);

    // requirementMemory：批次清空、pending 清理、总结无；accepted/edited 行保留
    const detail = ctx.service.requirementMemory(requirementId);
    expect(detail.batches).toEqual([]);
    expect(detail.candidates.map((c) => c.status).sort()).toEqual(["accepted", "edited"]);
    expect(detail.summary).toBeNull();

    // 存储布局（验收第 2 条）：requirements/<REQ>/ 目录清除；accepted/ 目录与文件完整
    expect(existsSync(join(ctx.dataRoot, projectId, "requirements", requirementId))).toBe(false);
    expect(readdirSync(join(ctx.dataRoot, projectId, "accepted")).sort()).toEqual(
      after.knowledge.map((k) => `${k.displayNo}.md`).sort(),
    );
  });

  it("无 memory 数据的需求删除为幂等空操作", () => {
    const ctx = makeService();
    expect(() => ctx.service.deleteRequirementData("REQ-404", "p-none")).not.toThrow();
    const pm = ctx.service.projectMemory("p-none");
    expect(pm.ok && pm.knowledge.length === 0 && pm.summaries.length === 0).toBe(true);
  });
});

describe("handleMemoryIpc 入站校验与路由（memory:ipc 通道）", () => {
  it("非法消息 → ok:false + reason invalid-request + zod 摘要（Main 入站强制校验）", async () => {
    const ctx = makeService();
    for (const raw of [null, "memory:extract", { channel: "memory:nuke" }, { channel: "memory:extract", requirementId: "" }]) {
      const res = await ctx.handle(raw);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("invalid-request");
        expect(res.detail?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it("七通道真实路由：requirementMemory / reviewCandidate / projectMemory / editAccepted 往返 wire 形状", async () => {
    const ctx = makeService();
    const { candidates } = seedExtracted(ctx);

    const read = await ctx.handle({ channel: "memory:requirementMemory", requirementId: "REQ-001" });
    expect(read.ok).toBe(true);

    const review = await ctx.handle({ channel: "memory:reviewCandidate", candidateId: candidates[0].id, action: "accept" });
    expect(review.ok).toBe(true);

    const reject = await ctx.handle({ channel: "memory:reviewCandidate", candidateId: candidates[0].id, action: "ignore" });
    expect(reject).toMatchObject({ ok: false, reason: "candidate-final" });

    const edit = await ctx.handle({ channel: "memory:editAccepted", candidateId: candidates[0].id, scope: "IPC 层再编辑" });
    expect(edit.ok).toBe(true);

    const search = await ctx.handle({ channel: "memory:projectMemory", projectId: "p1", query: "IPC" });
    expect(search.ok).toBe(true);

    const extract = await ctx.handle({ channel: "memory:extract", requirementId: "REQ-002" });
    expect(extract).toMatchObject({ ok: false, reason: "no-sessions" });

    const cancel = await ctx.handle({ channel: "memory:cancel", requirementId: "REQ-002" });
    expect(cancel).toMatchObject({ ok: false, reason: "no-extraction-running" });
  });

  it("退出中拒新请求（reason shutting-down）", async () => {
    const ctx = makeService();
    const res = await handleMemoryIpc({ memory: ctx.service, isShuttingDown: () => true }, { channel: "memory:requirementMemory", requirementId: "REQ-001" });
    expect(res).toMatchObject({ ok: false, reason: "shutting-down" });
  });
});

describe("openMemoryService 启动对账（打开库时 running→failed，spec #27 C/E 节）", () => {
  it("伪造 running 批次（崩溃遗留）→ 对账为 failed 附「应用中断」，不锁死需求（extract 不再报 extraction-running）", () => {
    const ctx = makeService();
    ctx.linkedSessions.set("REQ-001", [{ sessionId: "s1", cli: "claude-code" }]);
    ctx.service.store.createBatch({ id: "B-crash", requirementId: "REQ-001", projectId: "p1" }); // 模拟崩溃时遗留 running

    // 重启：同一 db/dataRoot 再走 openMemoryService（生产路径 = index.ts 打开库后装配）
    const reopened = openMemoryService({
      db: ctx.db,
      dataRoot: ctx.dataRoot,
      listLinkedStructuredSessions: (id) => ctx.linkedSessions.get(id) ?? [],
      getRequirementTitle: (id) => ctx.titles.get(id) ?? null,
    });
    const batch = reopened.service.store.getBatch("B-crash");
    expect(batch).toMatchObject({ status: "failed", error: "应用中断" });

    // 不锁死需求：running 已清，extract 不再命中 extraction-running（落到占位拒绝）
    expect(reopened.service.extract("REQ-001")).toMatchObject({ ok: false, reason: "cli-unavailable" });
  });
});
