// 存储层确定性单测：候选追加与 id 递增、批次隔离、summary 人工编辑后不静默覆盖。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as store from "../lib/store.mjs";

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "poc5-store-"));
}

test("appendCandidates 分配递增 id 并保持 pending 初始态", () => {
  const root = tempRoot();
  try {
    const b1 = store.appendCandidates(root, "REQ-X", [
      { claim: "规则一", sourceSessionIds: ["s1"], evidence: "e", scope: "项目" },
      { claim: "规则二", sourceSessionIds: ["s1"], evidence: "e", scope: "项目" },
    ], { batchId: "B1", now: () => "2026-01-01T00:00:00Z" });
    assert.equal(b1[0].id, "CAND-0001");
    assert.equal(b1[1].id, "CAND-0002");
    assert.equal(b1[0].status, "pending");
    const b2 = store.appendCandidates(root, "REQ-X", [
      { claim: "规则三", sourceSessionIds: ["s2"], evidence: "e", scope: "项目" },
    ], { batchId: "B2", now: () => "2026-01-02T00:00:00Z" });
    assert.equal(b2[0].id, "CAND-0003");
    assert.equal(b2[0].batchId, "B2");
    const all = store.readCandidates(root, "REQ-X");
    assert.equal(all.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("summary 首次写入成功；人工编辑后再次生成不覆盖、改写 proposed 文件", () => {
  const root = tempRoot();
  try {
    const r1 = store.writeSummary(root, "REQ-Y", "# 总结 v1", { batchId: "B1", generatedAt: "t1" });
    assert.equal(r1.overwritten, true);
    // 模拟人工编辑
    const file = path.join(root, "REQ-Y", "summary.md");
    const edited = readFileSync(file, "utf8") + "\n人工补充：注意边界。";
    writeFileSync(file, edited, "utf8");
    // 第二批重新生成：hash 不匹配 → 不覆盖
    const r2 = store.writeSummary(root, "REQ-Y", "# 总结 v2（重新生成）", { batchId: "B2", generatedAt: "t2" });
    assert.equal(r2.overwritten, false);
    assert.equal(r2.reason, "human-edited");
    assert.ok(existsSync(r2.proposed));
    // 磁盘上仍是人工编辑版
    assert.match(readFileSync(file, "utf8"), /人工补充/);
    assert.doesNotMatch(readFileSync(file, "utf8"), /总结 v2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("未人工编辑时重新生成允许覆盖（正常再生成路径）", () => {
  const root = tempRoot();
  try {
    store.writeSummary(root, "REQ-Z", "v1", { batchId: "B1", generatedAt: "t1" });
    const r2 = store.writeSummary(root, "REQ-Z", "v2", { batchId: "B2", generatedAt: "t2" });
    assert.equal(r2.overwritten, true);
    assert.match(readFileSync(r2.file, "utf8"), /v2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function require_fs_write(file, content) {
  // 局部引入避免顶部混杂；等价 writeFileSync
  const { writeFileSync } = require("node:fs");
  writeFileSync(file, content, "utf8");
}
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
