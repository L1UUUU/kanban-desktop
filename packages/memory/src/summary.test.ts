// 用途：SummaryStore 密封测试 —— 总结内容 hash 基准、人工编辑后重提取走 proposed 暂存不覆盖、resolveSummary 二选一、新 proposed 替换旧未处置 proposed（spec #27 D/F 节 US14/US23，演进自 poc-5 store.writeSummary）
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as nodeSqlite from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { ensureMemoryTables, type SqliteDb } from "./ddl";
import { sha256Text } from "./markdown";
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

function mkStore(): { store: SummaryStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), "kb-memory-summary-"));
  roots.push(root);
  const db = new RawDb(":memory:");
  dbs.push(db);
  ensureMemoryTables(db);
  return { store: new SummaryStore(db, root, { now: () => NOW }), root };
}

/** 测试内已知必在的记录直取（空值视为测试自身失败，缩短诊断） */
function must<T>(v: T | null | undefined): T {
  if (v == null) throw new Error("记录应存在");
  return v;
}

describe("总结写入与防覆盖", () => {
  it("首次写入：summary.md 落盘于需求级目录 + 库行（hash 基准/路径），无 proposed", () => {
    const { store, root } = mkStore();
    const out = store.writeSummary({ requirementId: "REQ-001", projectId: "p1", batchId: "B1", content: "# 总结 v1" });
    expect(out.mode).toBe("written");
    const mdPath = join(root, "p1", "requirements", "REQ-001", "summary.md");
    expect(out.mdPath).toBe(mdPath);
    expect(readFileSync(mdPath, "utf8")).toBe("# 总结 v1");
    const row = store.getSummary("REQ-001");
    expect(row).toMatchObject({
      requirementId: "REQ-001", projectId: "p1",
      contentHash: sha256Text("# 总结 v1"), mdPath,
      proposedBatchId: null, proposedMdPath: null,
    });
  });

  it("未人工编辑时重新生成：直接覆盖 summary.md 并更新 hash 基准", () => {
    const { store } = mkStore();
    store.writeSummary({ requirementId: "REQ-001", projectId: "p1", batchId: "B1", content: "v1" });
    const out = store.writeSummary({ requirementId: "REQ-001", projectId: "p1", batchId: "B2", content: "v2（再生成）" });
    expect(out.mode).toBe("written");
    expect(readFileSync(out.mdPath, "utf8")).toBe("v2（再生成）");
    expect(must(store.getSummary("REQ-001")).contentHash).toBe(sha256Text("v2（再生成）"));
  });

  it("人工编辑后重提取：不覆盖磁盘，新版暂存为 proposed（批次指针落库），hash 基准保持人工版", () => {
    const { store } = mkStore();
    store.writeSummary({ requirementId: "REQ-001", projectId: "p1", batchId: "B1", content: "# 总结 v1" });
    // 模拟人工编辑（应用外/编辑器直接改文件）
    const file = must(store.getSummary("REQ-001")).mdPath;
    writeFileSync(file, "# 总结 v1\n人工补充：注意边界。", "utf8");
    const out = store.writeSummary({ requirementId: "REQ-001", projectId: "p1", batchId: "B2", content: "# 总结 v2（重新生成）" });
    expect(out.mode).toBe("proposed");
    // 磁盘仍是人工编辑版（不被静默覆盖）
    expect(readFileSync(file, "utf8")).toBe("# 总结 v1\n人工补充：注意边界。");
    // proposed 文件落盘 + 指针
    const proposed = join(dirname(file), "summary.proposed.B2.md");
    expect(out.proposedMdPath).toBe(proposed);
    expect(readFileSync(proposed, "utf8")).toBe("# 总结 v2（重新生成）");
    const row = must(store.getSummary("REQ-001"));
    expect(row.proposedBatchId).toBe("B2");
    expect(row.proposedMdPath).toBe(proposed);
    // proposed 路径不改 hash 基准：基准仍是上次应用写出版本（「# 总结 v1」）——
    // 人工版保护持续存在：只要磁盘人工版未被采纳处置，后续每次重提取都继续走 proposed，绝不静默覆盖
    expect(row.contentHash).toBe(sha256Text("# 总结 v1"));
  });

  it("新 proposed 替换旧未处置 proposed：旧文件删除、指针指向新批次（不堆积）", () => {
    const { store } = mkStore();
    store.writeSummary({ requirementId: "REQ-001", projectId: "p1", batchId: "B1", content: "v1" });
    const file = must(store.getSummary("REQ-001")).mdPath;
    writeFileSync(file, "v1 人工编辑", "utf8");
    const p2 = store.writeSummary({ requirementId: "REQ-001", projectId: "p1", batchId: "B2", content: "v2" });
    const p3 = store.writeSummary({ requirementId: "REQ-001", projectId: "p1", batchId: "B3", content: "v3" });
    expect(p3.mode).toBe("proposed");
    expect(existsSync(p2.proposedMdPath as string)).toBe(false); // 旧 proposed 已删
    expect(existsSync(p3.proposedMdPath as string)).toBe(true);
    expect(store.getSummary("REQ-001")).toMatchObject({ proposedBatchId: "B3", proposedMdPath: p3.proposedMdPath });
  });
});

describe("resolveSummary（二选一处置，处置后暂存清除）", () => {
  function mkProposed(): { store: SummaryStore; root: string; file: string; proposed: string } {
    const { store, root } = mkStore();
    store.writeSummary({ requirementId: "REQ-001", projectId: "p1", batchId: "B1", content: "v1" });
    const file = must(store.getSummary("REQ-001")).mdPath;
    writeFileSync(file, "v1 人工编辑", "utf8");
    const p = store.writeSummary({ requirementId: "REQ-001", projectId: "p1", batchId: "B2", content: "v2 新版" });
    return { store, root, file, proposed: p.proposedMdPath as string };
  }

  it("accept-new：采纳新版 → summary.md 写为 proposed 内容、hash 基准更新、proposed 清除", () => {
    const { store, file, proposed } = mkProposed();
    store.resolveSummary("REQ-001", "accept-new");
    expect(readFileSync(file, "utf8")).toBe("v2 新版");
    expect(existsSync(proposed)).toBe(false);
    expect(store.getSummary("REQ-001")).toMatchObject({
      contentHash: sha256Text("v2 新版"), proposedBatchId: null, proposedMdPath: null,
    });
  });

  it("keep-human：保留人工版 → 磁盘不动、hash 基准不变（保护持续）、proposed 清除", () => {
    const { store, file, proposed } = mkProposed();
    store.resolveSummary("REQ-001", "keep-human");
    expect(readFileSync(file, "utf8")).toBe("v1 人工编辑");
    expect(existsSync(proposed)).toBe(false);
    expect(store.getSummary("REQ-001")).toMatchObject({
      contentHash: sha256Text("v1"), proposedBatchId: null, proposedMdPath: null,
    });
  });

  it("keep-human 后再提取仍走 proposed（人工版保护持续）；accept-new 后基准收敛恢复直覆盖", () => {
    // keep-human 分支：人工版仍在磁盘、基准仍为旧生成版 → 再次重提取继续暂存不覆盖
    const kept = mkProposed();
    kept.store.resolveSummary("REQ-001", "keep-human");
    const again = kept.store.writeSummary({ requirementId: "REQ-001", projectId: "p1", batchId: "B3", content: "v3 再次生成" });
    expect(again.mode).toBe("proposed");
    expect(readFileSync(kept.file, "utf8")).toBe("v1 人工编辑");

    // accept-new 分支：新版被采纳为基准 → 后续再生成恢复直接覆盖
    const adopted = mkProposed();
    adopted.store.resolveSummary("REQ-001", "accept-new");
    const next = adopted.store.writeSummary({ requirementId: "REQ-001", projectId: "p1", batchId: "B3", content: "v3 覆盖" });
    expect(next.mode).toBe("written");
    expect(readFileSync(next.mdPath, "utf8")).toBe("v3 覆盖");
  });

  it("无未处置 proposed 时 resolveSummary 抛错", () => {
    const { store } = mkStore();
    store.writeSummary({ requirementId: "REQ-001", projectId: "p1", batchId: "B1", content: "v1" });
    expect(() => store.resolveSummary("REQ-001", "accept-new")).toThrow(/proposed/);
    expect(() => store.resolveSummary("REQ-999", "keep-human")).toThrow(/proposed/);
  });

  it("accept-new 但 proposed 文件缺失：抛明确错误（指针与文件不一致留给启动修复）", () => {
    const { store } = mkStore();
    store.writeSummary({ requirementId: "REQ-001", projectId: "p1", batchId: "B1", content: "v1" });
    const file = must(store.getSummary("REQ-001")).mdPath;
    writeFileSync(file, "v1 人工编辑", "utf8");
    const p = store.writeSummary({ requirementId: "REQ-001", projectId: "p1", batchId: "B2", content: "v2" });
    rmSync(p.proposedMdPath as string);
    expect(() => store.resolveSummary("REQ-001", "accept-new")).toThrow(/缺失/);
  });
});
