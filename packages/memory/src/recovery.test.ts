// 用途：recovery 密封测试 —— 启动对账与修复四规则（spec #27 E 节）：① running 批次→failed ② 孤儿 accepted md 清理 ③ summary.md 无库行按文件 hash 建档 ④ 非 completed 批次的 proposed 清理；崩溃窗口（文件已写事务未提交）按修复规则收敛
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nodeSqlite from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { ensureMemoryTables, type SqliteDb } from "./ddl";
import { sha256Text } from "./markdown";
import { reconcileMemory } from "./recovery";
import { MemoryStore } from "./store";
import { SummaryStore } from "./summary";

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

/** 测试内已知必在的记录直取（空值视为测试自身失败，缩短诊断） */
function must<T>(v: T | null | undefined): T {
  if (v == null) throw new Error("记录应存在");
  return v;
}

function mkEnv(): { root: string; db: SqliteDb; store: MemoryStore; summaries: SummaryStore } {
  const root = mkdtempSync(join(tmpdir(), "kb-memory-recovery-"));
  roots.push(root);
  const db = new RawDb(":memory:");
  dbs.push(db);
  ensureMemoryTables(db);
  return {
    root,
    db,
    store: new MemoryStore(db, root, { now: () => NOW }),
    summaries: new SummaryStore(db, root, { now: () => NOW }),
  };
}

describe("规则一：running 批次对账为 failed", () => {
  it("running → failed（error=应用中断、finished_at 落值）；其余状态不动", () => {
    const { root, db, store } = mkEnv();
    store.createBatch({ id: "B-run", requirementId: "REQ-001", projectId: "p1" });
    store.createBatch({ id: "B-done", requirementId: "REQ-001", projectId: "p1" });
    store.finishBatch("B-done", { status: "completed" });
    store.createBatch({ id: "B-cancel", requirementId: "REQ-001", projectId: "p1" });
    store.finishBatch("B-cancel", { status: "cancelled" });

    const report = reconcileMemory(db, root, { now: () => NOW });
    expect(report.failedBatches).toEqual(["B-run"]);
    expect(store.getBatch("B-run")).toMatchObject({ status: "failed", error: "应用中断", finishedAt: NOW });
    expect(must(store.getBatch("B-done")).status).toBe("completed");
    expect(must(store.getBatch("B-cancel")).status).toBe("cancelled");
    // 无 running 时幂等重跑为零修复
    expect(reconcileMemory(db, root, { now: () => NOW }).failedBatches).toEqual([]);
  });
});

describe("规则二：孤儿 accepted md 清理", () => {
  it("无库行引用的 accepted md 删除；被引用的保留（崩溃窗口：文件已写事务未提交 → 收敛）", () => {
    const { root, db, store } = mkEnv();
    // 正常路径：接受候选 → md + 行引用
    store.createBatch({ id: "B1", requirementId: "REQ-001", projectId: "p1" });
    const [rec] = store.appendCandidates("B1", [{ claim: "正常接受的知识", scope: "", evidence: "", sourceSessionIds: [] }]);
    const kept = store.reviewCandidate(rec.id, "accept").mdPath as string;
    // 崩溃窗口模拟：md 已写但事务未提交（行无 md_path 引用）
    const orphan = join(root, "p1", "accepted", "CAND-9999.md");
    mkdirSync(join(root, "p1", "accepted"), { recursive: true });
    writeFileSync(orphan, "# 孤儿", "utf8");

    const report = reconcileMemory(db, root, { now: () => NOW });
    expect(report.removedOrphanMds).toEqual([orphan]);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });
});

describe("规则三：summary.md 存在而无库行 → 以文件 hash 建档", () => {
  it("无行 summary.md 建档（hash=文件内容 hash、路径与项目正确）；已有行的 summary 不重建", () => {
    const { root, db, summaries } = mkEnv();
    // 崩溃窗口模拟：summary.md 已写、事务未提交（无库行）
    const mdPath = join(root, "p1", "requirements", "REQ-007", "summary.md");
    mkdirSync(join(root, "p1", "requirements", "REQ-007"), { recursive: true });
    writeFileSync(mdPath, "# 崩溃前写出的总结", "utf8");
    // 正常行（不该被动）
    summaries.writeSummary({ requirementId: "REQ-001", projectId: "p1", batchId: "B1", content: "正常总结" });

    const report = reconcileMemory(db, root, { now: () => NOW });
    expect(report.createdSummaryRows).toEqual(["REQ-007"]);
    const row = summaries.getSummary("REQ-007");
    expect(row).toMatchObject({
      requirementId: "REQ-007", projectId: "p1",
      contentHash: sha256Text("# 崩溃前写出的总结"), mdPath,
      proposedBatchId: null, proposedMdPath: null,
    });
    expect(must(summaries.getSummary("REQ-001")).mdPath).toBe(join(root, "p1", "requirements", "REQ-001", "summary.md"));
  });

  it("建档后人工编辑检测可用（建档 hash 即基准）", () => {
    const { root, db, summaries } = mkEnv();
    const mdPath = join(root, "p1", "requirements", "REQ-007", "summary.md");
    mkdirSync(join(root, "p1", "requirements", "REQ-007"), { recursive: true });
    writeFileSync(mdPath, "v1", "utf8");
    reconcileMemory(db, root, { now: () => NOW });
    // 建档后重提取：未被人工编辑 → 直接覆盖
    expect(summaries.writeSummary({ requirementId: "REQ-007", projectId: "p1", batchId: "B9", content: "v2" }).mode).toBe("written");
    // 人工编辑后再提取 → proposed 不覆盖
    writeFileSync(mdPath, "v2 人工版", "utf8");
    expect(summaries.writeSummary({ requirementId: "REQ-007", projectId: "p1", batchId: "B10", content: "v3" }).mode).toBe("proposed");
  });
});

describe("规则四：非 completed 批次的 proposed 清理", () => {
  function writeProposed(root: string, projectId: string, reqId: string, batchId: string): string {
    const dir = join(root, projectId, "requirements", reqId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `summary.proposed.${batchId}.md`);
    writeFileSync(file, "proposed 内容", "utf8");
    return file;
  }

  it("failed/running（先经规则一对账为 failed）批次的 proposed 文件删除且行指针清空；completed 批次的 proposed 保留", () => {
    const { root, db, store, summaries } = mkEnv();
    // 正常待处置 proposed（completed 批次）→ 保留
    summaries.writeSummary({ requirementId: "REQ-001", projectId: "p1", batchId: "B1", content: "v1" });
    const human = must(summaries.getSummary("REQ-001")).mdPath;
    writeFileSync(human, "v1 人工版", "utf8");
    const keptProposed = summaries.writeSummary({ requirementId: "REQ-001", projectId: "p1", batchId: "B2", content: "v2" }).proposedMdPath as string;
    store.createBatch({ id: "B2", requirementId: "REQ-001", projectId: "p1" });
    store.finishBatch("B2", { status: "completed" });

    // 崩溃窗口一：proposed 文件已写、批次事务未提交（批次仍是 running、无行指针）
    const orphanProposed = writeProposed(root, "p1", "REQ-002", "B-crash");
    // 行指针指向非 completed 批次（failed）的 proposed
    summaries.writeSummary({ requirementId: "REQ-003", projectId: "p1", batchId: "B3", content: "v1" });
    const human3 = must(summaries.getSummary("REQ-003")).mdPath;
    writeFileSync(human3, "v1 人工版 3", "utf8");
    const badProposed = summaries.writeSummary({ requirementId: "REQ-003", projectId: "p1", batchId: "B-failed", content: "v2" }).proposedMdPath as string;
    store.createBatch({ id: "B-failed", requirementId: "REQ-003", projectId: "p1" });
    store.finishBatch("B-failed", { status: "failed", error: "x" });

    const report = reconcileMemory(db, root, { now: () => NOW });
    expect(report.removedProposed.sort()).toEqual([badProposed, orphanProposed].sort());
    expect(existsSync(keptProposed)).toBe(true);
    expect(existsSync(badProposed)).toBe(false);
    expect(existsSync(orphanProposed)).toBe(false);
    // 行指针已清空（completed 的保留）
    expect(must(summaries.getSummary("REQ-001")).proposedMdPath).toBe(keptProposed);
    expect(summaries.getSummary("REQ-003")).toMatchObject({ proposedBatchId: null, proposedMdPath: null });
    // 人工版磁盘内容未被动过
    expect(readFileSync(human, "utf8")).toBe("v1 人工版");
    expect(readFileSync(human3, "utf8")).toBe("v1 人工版 3");
  });
});

describe("整体收敛与幂等", () => {
  it("干净环境零修复；重复执行幂等", () => {
    const { root, db } = mkEnv();
    const empty = reconcileMemory(db, root, { now: () => NOW });
    expect(empty).toEqual({ failedBatches: [], removedOrphanMds: [], createdSummaryRows: [], removedProposed: [] });
    const again = reconcileMemory(db, root, { now: () => NOW });
    expect(again).toEqual(empty);
  });
});
