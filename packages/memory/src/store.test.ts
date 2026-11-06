// 用途：MemoryStore 密封测试 —— 批次生命周期、候选追加与 display_no 项目内递增、状态机（仅 pending 可流转、终态抛错、edit 仅 claim/scope、溯源不可变）、双写序（Markdown 先写 temp+rename → SQLite 事务后提交）、Dice 冲突/notes 标注（spec #27 D/F/G 节，演进自 poc-5 review/store）
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nodeSqlite from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { ensureMemoryTables, type SqliteDb } from "./ddl";
import { MemoryStore, type MemoryCandidateRecord, type ReviewAction } from "./store";

// 与 desktop db.ts 相同的 node:sqlite 入口回退
const exportsRecord = nodeSqlite as unknown as Record<string, unknown>;
const RawDb = (typeof exportsRecord.Database === "function"
  ? exportsRecord.Database
  : nodeSqlite.DatabaseSync) as new (path: string) => nodeSqlite.DatabaseSync;

const NOW = "2026-11-06T00:00:00.000Z";
const roots: string[] = [];
const dbs: SqliteDb[] = [];
afterAll(() => {
  for (const db of dbs) db.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** 建一个独立 store（:memory: 库 + 独立临时 dataRoot），注册全局清理 */
function mkStore(): { store: MemoryStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), "kb-memory-store-"));
  roots.push(root);
  const db = new RawDb(":memory:");
  dbs.push(db);
  ensureMemoryTables(db);
  const store = new MemoryStore(db, root, { now: () => NOW });
  return { store, root };
}

/** 快捷：建批次并追加一条候选，返回候选记录 */
function seedCandidate(store: MemoryStore, claim: string, over?: { projectId?: string; batchId?: string; scope?: string }): MemoryCandidateRecord {
  const batchId = over?.batchId ?? "B1";
  store.createBatch({ id: batchId, requirementId: "REQ-001", projectId: over?.projectId ?? "p1" });
  const [rec] = store.appendCandidates(batchId, [
    { claim, scope: over?.scope ?? "项目级", evidence: "e", sourceSessionIds: ["s1"] },
  ]);
  return rec;
}

/** 测试内已知必在的记录直取（空值视为测试自身失败，缩短诊断） */
function must<T>(v: T | null | undefined): T {
  if (v == null) throw new Error("记录应存在");
  return v;
}

describe("批次生命周期（memory_batches）", () => {
  it("createBatch 落 running 行，元数据默认值正确，getBatch 往返", () => {
    const { store } = mkStore();
    store.createBatch({ id: "B1", requirementId: "REQ-001", projectId: "p1", sourceSessionCount: 3 });
    const b = store.getBatch("B1");
    expect(b).toMatchObject({
      id: "B1", requirementId: "REQ-001", projectId: "p1", status: "running",
      sourceSessionCount: 3, missingSessions: [], chunkCount: 0, modelCallCount: 0,
      error: null, finishedAt: null, createdAt: NOW,
    });
  });

  it("updateBatch 补充过程元数据（缺失会话/分段数/模型调用次数）", () => {
    const { store } = mkStore();
    store.createBatch({ id: "B1", requirementId: "REQ-001", projectId: "p1" });
    store.updateBatch("B1", {
      missingSessions: [{ sessionId: "s9", cli: "codex", reason: "PTY 会话无原生历史" }],
      chunkCount: 4,
      modelCallCount: 5,
    });
    expect(store.getBatch("B1")).toMatchObject({
      chunkCount: 4, modelCallCount: 5,
      missingSessions: [{ sessionId: "s9", cli: "codex", reason: "PTY 会话无原生历史" }],
    });
  });

  it("finishBatch：completed 带 finishedAt；failed 带 error", () => {
    const { store } = mkStore();
    store.createBatch({ id: "B1", requirementId: "REQ-001", projectId: "p1" });
    store.finishBatch("B1", { status: "completed" });
    expect(store.getBatch("B1")).toMatchObject({ status: "completed", finishedAt: NOW, error: null });
    store.createBatch({ id: "B2", requirementId: "REQ-001", projectId: "p1" });
    store.finishBatch("B2", { status: "failed", error: "校验重试仍失败" });
    expect(store.getBatch("B2")).toMatchObject({ status: "failed", error: "校验重试仍失败", finishedAt: NOW });
  });

  it("finishBatch 未知批次抛错", () => {
    const { store } = mkStore();
    expect(() => store.finishBatch("nope", { status: "failed", error: "x" })).toThrow(/不存在/);
  });

  it("listBatches 按创建序返回该需求全部批次", () => {
    const { store } = mkStore();
    store.createBatch({ id: "B1", requirementId: "REQ-001", projectId: "p1" });
    store.createBatch({ id: "B2", requirementId: "REQ-001", projectId: "p1" });
    store.createBatch({ id: "B9", requirementId: "REQ-002", projectId: "p1" });
    expect(store.listBatches("REQ-001").map((b) => b.id)).toEqual(["B1", "B2"]);
  });
});

describe("候选追加与 display_no（memory_candidates）", () => {
  it("追加即 pending 初始态，display_no 项目内递增（跨批次连续），溯源字段完整落库", () => {
    const { store } = mkStore();
    store.createBatch({ id: "B1", requirementId: "REQ-001", projectId: "p1" });
    const recs = store.appendCandidates("B1", [
      { claim: "规则一", scope: "calc.js", evidence: "证据一", sourceSessionIds: ["s1", "s2"] },
      { claim: "规则二", scope: "项目级", evidence: "证据二", sourceSessionIds: ["s1"] },
    ]);
    expect(recs.map((r) => r.displayNo)).toEqual(["CAND-0001", "CAND-0002"]);
    for (const r of recs) {
      expect(r.status).toBe("pending");
      expect(r.batchId).toBe("B1");
      expect(r.requirementId).toBe("REQ-001");
      expect(r.projectId).toBe("p1");
      expect(r.createdAt).toBe(NOW);
      expect(r.mdPath).toBeNull();
      expect(r.reviewedAt).toBeNull();
    }
    expect(recs[0]).toMatchObject({ claim: "规则一", scope: "calc.js", evidence: "证据一", sourceSessionIds: ["s1", "s2"] });
    store.createBatch({ id: "B2", requirementId: "REQ-001", projectId: "p1" });
    const [third] = store.appendCandidates("B2", [{ claim: "规则三", scope: "", evidence: "", sourceSessionIds: [] }]);
    expect(third.displayNo).toBe("CAND-0003");
  });

  it("不同项目编号独立递增", () => {
    const { store } = mkStore();
    const a = seedCandidate(store, "项目一规则", { projectId: "pa" });
    const b = seedCandidate(store, "项目二规则", { projectId: "pb", batchId: "B2" });
    expect(a.displayNo).toBe("CAND-0001");
    expect(b.displayNo).toBe("CAND-0001");
  });

  it("appendCandidates 未知批次抛错", () => {
    const { store } = mkStore();
    expect(() => store.appendCandidates("nope", [{ claim: "x", scope: "", evidence: "", sourceSessionIds: [] }])).toThrow(/不存在/);
  });
});

describe("候选状态机（pending → accepted/edited/ignored；仅 pending 可流转）", () => {
  it("accept：状态流转 + accepted md 写入（元数据头：claim/来源/证据/范围/批次/状态）+ md_path 落库", () => {
    const { store, root } = mkStore();
    const rec = seedCandidate(store, "配置项统一放配置文件", { scope: "项目级" });
    const out = store.reviewCandidate(rec.id, "accept");
    expect(out.status).toBe("accepted");
    expect(out.reviewedAt).toBe(NOW);
    // 布局：项目级 accepted/CAND-xxxx.md，md_path 为绝对路径
    expect(out.mdPath).toBe(join(root, "p1", "accepted", "CAND-0001.md"));
    expect(existsSync(out.mdPath as string)).toBe(true);
    const md = readFileSync(out.mdPath as string, "utf8");
    expect(md).toContain("---");
    expect(md).toContain("claim:");
    expect(md).toContain("配置项统一放配置文件");
    expect(md).toContain("review_status: accepted");
    expect(md).toContain("generated_batch: B1");
    expect(md).toContain("适用范围：项目级");
    // 库行同步（经公开读路径复核）
    expect(store.getCandidate(rec.id)).toMatchObject({ status: "accepted", mdPath: out.mdPath });
  });

  it("edit 仅改 scope：edited_scope 落库、claim 保持原值、md 用编辑后值渲染、溯源不可变", () => {
    const { store } = mkStore();
    const rec = seedCandidate(store, "原始结论内容", { scope: "项目级" });
    const out = store.reviewCandidate(rec.id, "edit", { scope: "仅 calc.js" });
    expect(out).toMatchObject({
      status: "edited", editedScope: "仅 calc.js", editedClaim: null, claim: "原始结论内容",
      mdPath: expect.any(String),
    });
    const md = readFileSync(out.mdPath as string, "utf8");
    expect(md).toContain("review_status: edited");
    expect(md).toContain("适用范围：仅 calc.js");
    expect(md).toContain("# 原始结论内容");
    // 溯源不可变：证据/来源会话/批次/编号/创建时间与追加时一致
    const after = store.getCandidate(rec.id);
    expect(after).toMatchObject({
      evidence: rec.evidence, sourceSessionIds: rec.sourceSessionIds,
      batchId: rec.batchId, displayNo: rec.displayNo, createdAt: rec.createdAt,
    });
  });

  it("edit 同时改 claim 与 scope：两编辑值都落库、md 用 edited 值", () => {
    const { store } = mkStore();
    const rec = seedCandidate(store, "原标题");
    const out = store.reviewCandidate(rec.id, "edit", { claim: "改写后的结论", scope: "新的范围" });
    expect(out).toMatchObject({ status: "edited", editedClaim: "改写后的结论", editedScope: "新的范围" });
    const md = readFileSync(out.mdPath as string, "utf8");
    expect(md).toContain("# 改写后的结论");
    expect(md).toContain("适用范围：新的范围");
  });

  it("ignore：状态落库、不写 md", () => {
    const { store, root } = mkStore();
    const rec = seedCandidate(store, "不认可的经验");
    const out = store.reviewCandidate(rec.id, "ignore");
    expect(out.status).toBe("ignored");
    expect(out.mdPath).toBeNull();
    expect(existsSync(join(root, "p1", "accepted"))).toBe(false);
  });

  it("终态不可再流转：accepted/edited/ignored 再审均抛错且状态保持", () => {
    const { store } = mkStore();
    const acc = seedCandidate(store, "已接受经验");
    store.reviewCandidate(acc.id, "accept");
    for (const action of ["accept", "edit", "ignore"] as ReviewAction[]) {
      expect(() => store.reviewCandidate(acc.id, action, action === "edit" ? { claim: "改" } : undefined)).toThrow(/仅 pending 可审核/);
    }
    expect(must(store.getCandidate(acc.id)).status).toBe("accepted");

    const ed = seedCandidate(store, "已编辑经验", { batchId: "B2" });
    store.reviewCandidate(ed.id, "edit", { claim: "改后" });
    expect(() => store.reviewCandidate(ed.id, "ignore")).toThrow(/仅 pending 可审核/);
    expect(must(store.getCandidate(ed.id)).status).toBe("edited");

    const ig = seedCandidate(store, "已忽略经验", { batchId: "B3" });
    store.reviewCandidate(ig.id, "ignore");
    expect(() => store.reviewCandidate(ig.id, "accept")).toThrow(/仅 pending 可审核/);
    expect(must(store.getCandidate(ig.id)).status).toBe("ignored");
  });

  it("候选不存在抛错；未知审核动作抛错", () => {
    const { store } = mkStore();
    expect(() => store.reviewCandidate("nope", "accept")).toThrow(/不存在/);
    const rec = seedCandidate(store, "x");
    expect(() => store.reviewCandidate(rec.id, "weird" as ReviewAction)).toThrow(/未知审核动作/);
    expect(must(store.getCandidate(rec.id)).status).toBe("pending");
  });

  it("edit 不带任何修改抛错（claim/scope 至少一项）", () => {
    const { store } = mkStore();
    const rec = seedCandidate(store, "x");
    expect(() => store.reviewCandidate(rec.id, "edit", {})).toThrow(/至少一项/);
    expect(must(store.getCandidate(rec.id)).status).toBe("pending");
  });
});

describe("双写序（Markdown 先写 temp+rename → SQLite 事务后提交）", () => {
  it("Markdown 写失败：审核抛错、行保持 pending、不产生 md_path", () => {
    // dataRoot 被一个同名文件占用 → accepted 目录创建失败（Markdown 先写的故障注入）
    const root = mkdtempSync(join(tmpdir(), "kb-memory-store-"));
    roots.push(root);
    const blocker = join(root, "p1");
    writeFileSync(blocker, "不是目录", "utf8");
    const db = new RawDb(":memory:");
    dbs.push(db);
    ensureMemoryTables(db);
    const store = new MemoryStore(db, root, { now: () => NOW });
    store.createBatch({ id: "B1", requirementId: "REQ-001", projectId: "p1" });
    const [rec] = store.appendCandidates("B1", [{ claim: "x", scope: "", evidence: "", sourceSessionIds: [] }]);
    expect(() => store.reviewCandidate(rec.id, "accept")).toThrow();
    expect(store.getCandidate(rec.id)).toMatchObject({ status: "pending", mdPath: null });
  });

  it("SQLite 提交失败：md 已落盘（先写证明）、行保持 pending（回滚）", () => {
    const root = mkdtempSync(join(tmpdir(), "kb-memory-store-"));
    roots.push(root);
    const db = new RawDb(":memory:");
    dbs.push(db);
    const store = new MemoryStore(db, root, { now: () => NOW });
    store.createBatch({ id: "B1", requirementId: "REQ-001", projectId: "p1" });
    const [rec] = store.appendCandidates("B1", [{ claim: "双写序验证", scope: "", evidence: "", sourceSessionIds: [] }]);
    // 注入 db 代理：仅 COMMIT 抛错（db 句柄是依赖注入 seam，spec #27 A 节）
    const flaky = {
      exec: (sql: string) => {
        if (sql === "COMMIT") throw new Error("模拟提交失败");
        return db.exec(sql);
      },
      prepare: (...args: Parameters<SqliteDb["prepare"]>) => db.prepare(...args),
    } as unknown as SqliteDb;
    const flakyStore = new MemoryStore(flaky, root, { now: () => NOW });
    expect(() => flakyStore.reviewCandidate(rec.id, "accept")).toThrow(/模拟提交失败/);
    // md 已写（Markdown 先于事务）——崩溃窗口留给启动修复收敛
    const mdPath = join(root, "p1", "accepted", `${rec.displayNo}.md`);
    expect(existsSync(mdPath)).toBe(true);
    // 行仍 pending（事务回滚）
    expect(store.getCandidate(rec.id)).toMatchObject({ status: "pending", mdPath: null });
    // 无 temp 残留
    expect(readdirSync(join(root, "p1", "accepted")).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });
});

describe("Dice 判重标注（append 时对既有知识跑冲突检测，仅标注不阻断）", () => {
  it("对 accepted/edited 标 conflicts（含对方编号与相似度），对 ignored 标 notes", () => {
    const { store } = mkStore();
    const acc = seedCandidate(store, "alpha beta");
    store.reviewCandidate(acc.id, "accept");
    const ed = seedCandidate(store, "完全不同的一条已编辑经验", { batchId: "B2" });
    store.reviewCandidate(ed.id, "edit", { claim: "使用 vitest 做测试" });
    const ig = seedCandidate(store, "被纠正的旧知识 gamma delta", { batchId: "B3" });
    store.reviewCandidate(ig.id, "ignore");

    store.createBatch({ id: "B4", requirementId: "REQ-001", projectId: "p1" });
    const [new1] = store.appendCandidates("B4", [{ claim: "alpha beta（疑似重复）", scope: "", evidence: "", sourceSessionIds: [] }]);
    // 与 accepted 的 CAND-0001 相似 → conflicts（手工演算：A={alpha,beta,疑似,似重,重复} B={alpha,beta} → 4/7 ≈ 0.571）
    expect(new1.conflicts).toEqual([
      { displayNo: "CAND-0001", similarity: expect.closeTo(0.571, 2), kind: "similar-to-accepted" },
    ]);
    // 与 edited（editedClaim 基准）相似 → conflicts；与 ignored 不相似 → 无 notes
    const [new2] = store.appendCandidates("B4", [{ claim: "使用 vitest 测试", scope: "", evidence: "", sourceSessionIds: [] }]);
    expect(new2.conflicts.some((c) => c.displayNo === "CAND-0002")).toBe(true);
    expect(new2.notes).toEqual([]);

    const [new3] = store.appendCandidates("B4", [{ claim: "被纠正的旧知识 gamma delta epsilon", scope: "", evidence: "", sourceSessionIds: [] }]);
    expect(new3.notes.some((n) => n.displayNo === "CAND-0003" && n.kind === "similar-to-ignored-check-correction")).toBe(true);
    expect(new3.conflicts).toEqual([]);
  });

  it("阈值边界：相似度恰 0.5 标注、0.4 不标注（CONFLICT_THRESHOLD 含等号）", () => {
    const { store } = mkStore();
    const a = seedCandidate(store, "alpha beta");
    store.reviewCandidate(a.id, "accept");
    store.createBatch({ id: "B2", requirementId: "REQ-001", projectId: "p1" });
    const [hit] = store.appendCandidates("B2", [{ claim: "alpha gamma", scope: "", evidence: "", sourceSessionIds: [] }]);
    expect(hit.conflicts).toEqual([{ displayNo: "CAND-0001", similarity: 0.5, kind: "similar-to-accepted" }]);
    const [miss] = store.appendCandidates("B2", [{ claim: "alpha gamma delta", scope: "", evidence: "", sourceSessionIds: [] }]);
    expect(miss.conflicts).toEqual([]);
  });

  it("比较基准取 edited 值 ?? 原值：原 claim 不相似但 editedClaim 相似仍标注", () => {
    const { store } = mkStore();
    const rec = seedCandidate(store, "zzz yyy www 完全无关原句");
    store.reviewCandidate(rec.id, "edit", { claim: "node sqlite DatabaseSync 双入口兼容" });
    store.createBatch({ id: "B2", requirementId: "REQ-001", projectId: "p1" });
    const [n] = store.appendCandidates("B2", [{ claim: "node sqlite DatabaseSync 双入口兼容（新批次）", scope: "", evidence: "", sourceSessionIds: [] }]);
    expect(n.conflicts.some((c) => c.displayNo === rec.displayNo)).toBe(true);
  });

  it("项目隔离：其他项目的既有知识不参与标注", () => {
    const { store } = mkStore();
    const other = seedCandidate(store, "alpha beta", { projectId: "p-other", batchId: "B1" });
    store.reviewCandidate(other.id, "accept");
    store.createBatch({ id: "B2", requirementId: "REQ-001", projectId: "p1" });
    const [n] = store.appendCandidates("B2", [{ claim: "alpha beta", scope: "", evidence: "", sourceSessionIds: [] }]);
    expect(n.conflicts).toEqual([]);
  });

  it("listKnowledge 返回项目内 accepted/edited 知识（pending/ignored 不进）", () => {
    const { store } = mkStore();
    const acc = seedCandidate(store, "已接受");
    store.reviewCandidate(acc.id, "accept");
    const ed = seedCandidate(store, "已编辑", { batchId: "B2" });
    store.reviewCandidate(ed.id, "edit", { claim: "改" });
    const pend = seedCandidate(store, "待审", { batchId: "B3" });
    const ig = seedCandidate(store, "已忽略", { batchId: "B4" });
    store.reviewCandidate(ig.id, "ignore");
    expect(store.listKnowledge("p1").map((r) => r.id).sort()).toEqual([acc.id, ed.id].sort());
    expect(pend.status).toBe("pending");
  });
});

describe("需求候选一次读（issue #31 requirementMemory 的 store 支撑）", () => {
  it("listRequirementCandidates：跨批次全部候选按创建序返回（pending 累计 + 已处置均在），只含本需求", () => {
    const { store } = mkStore();
    store.createBatch({ id: "B1", requirementId: "REQ-001", projectId: "p1" });
    store.createBatch({ id: "B2", requirementId: "REQ-001", projectId: "p1" });
    store.createBatch({ id: "B9", requirementId: "REQ-002", projectId: "p1" });
    store.appendCandidates("B1", [{ claim: "第一批", scope: "", evidence: "", sourceSessionIds: [] }]);
    store.appendCandidates("B2", [
      { claim: "第二批 a", scope: "", evidence: "", sourceSessionIds: [] },
      { claim: "第二批 b", scope: "", evidence: "", sourceSessionIds: [] },
    ]);
    store.appendCandidates("B9", [{ claim: "别的需求", scope: "", evidence: "", sourceSessionIds: [] }]);
    const rows = store.listRequirementCandidates("REQ-001");
    expect(rows.map((r) => r.claim)).toEqual(["第一批", "第二批 a", "第二批 b"]);
    expect(rows.every((r) => r.requirementId === "REQ-001")).toBe(true);
  });
});

describe("已接受知识再编辑 editAccepted（issue #31，US21：claim/适用范围可再编辑、溯源不可变）", () => {
  it("更新 edited 值并重写 md 正文；未提供的字段保持既有 edited 值；溯源与状态不变", () => {
    const { store } = mkStore();
    const rec = seedCandidate(store, "原 claim");
    store.reviewCandidate(rec.id, "accept");
    const accepted = must(store.getCandidate(rec.id));
    const updated = store.editAccepted(rec.id, { claim: "修订 claim", scope: "修订范围" });
    expect(updated).toMatchObject({
      status: "accepted",
      editedClaim: "修订 claim",
      editedScope: "修订范围",
      batchId: rec.batchId,
      evidence: rec.evidence,
      sourceSessionIds: rec.sourceSessionIds,
      reviewedAt: accepted.reviewedAt, // 再编辑不是审核，保留原审核时间
    });
    expect(readFileSync(must(updated.mdPath), "utf8")).toContain("修订 claim");
    expect(readFileSync(must(updated.mdPath), "utf8")).toContain("修订范围");

    // 再次单项编辑：claim 的 edited 值保持，仅 scope 覆盖
    const again = store.editAccepted(rec.id, { scope: "再修订范围" });
    expect(again.editedClaim).toBe("修订 claim");
    expect(again.editedScope).toBe("再修订范围");
    expect(readFileSync(must(again.mdPath), "utf8")).toContain("再修订范围");
  });

  it("edited 终态知识同样可再编辑（US21 编辑后接受的知识是项目资产）", () => {
    const { store } = mkStore();
    const rec = seedCandidate(store, "待编辑");
    store.reviewCandidate(rec.id, "edit", { claim: "首次编辑" });
    const updated = store.editAccepted(rec.id, { claim: "二次编辑" });
    expect(updated.status).toBe("edited");
    expect(updated.editedClaim).toBe("二次编辑");
    expect(readFileSync(must(updated.mdPath), "utf8")).toContain("二次编辑");
  });

  it("仅 accepted/edited 可编辑：pending/ignored 拒绝；候选不存在与空编辑抛错", () => {
    const { store } = mkStore();
    const p = seedCandidate(store, "待审");
    expect(() => store.editAccepted(p.id, { claim: "x" })).toThrow(/pending/);
    store.reviewCandidate(p.id, "ignore");
    expect(() => store.editAccepted(p.id, { claim: "x" })).toThrow(/ignored/);

    const acc = seedCandidate(store, "已接受", { batchId: "B2" });
    store.reviewCandidate(acc.id, "accept");
    expect(() => store.editAccepted(acc.id, {})).toThrow(/至少一项/);
    expect(() => store.editAccepted("ghost", { claim: "x" })).toThrow(/不存在/);
  });
});
