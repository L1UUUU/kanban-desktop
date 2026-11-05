// 审核层确定性单测：状态流转与终态保护、冲突检测（accepted 相似提示 / ignored 相似 note）、
// 早期错误被纠正场景（旧错误忽略后永不进入 accepted，纠正版可接受）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as store from "../lib/store.mjs";
import { detectConflicts, review } from "../lib/review.mjs";

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "poc5-review-"));
}

function seed(root, candidates, batchId = "B1") {
  return store.appendCandidates(root, "REQ-001", candidates, {
    batchId,
    now: () => "2026-01-01T00:00:00Z",
  });
}

test("accept/ignore/edit 三种流转写入正确状态；edit 使用编辑后文本", () => {
  const root = tempRoot();
  try {
    const [c1, c2, c3] = seed(root, [
      { claim: "所有计算函数都用 CommonJS 导出", sourceSessionIds: ["s1"], evidence: "e", scope: "calc.js" },
      { claim: "不要引入外部大依赖", sourceSessionIds: ["s1"], evidence: "e", scope: "项目" },
      { claim: "临时脚本放 scripts 下", sourceSessionIds: ["s2"], evidence: "e", scope: "项目" },
    ]);
    review(root, "REQ-001", c1.id, "accept");
    review(root, "REQ-001", c2.id, "ignore");
    review(root, "REQ-001", c3.id, "edit", { newClaim: "临时验证脚本统一放 scripts/ 目录且不提交" });
    const all = store.readCandidates(root, "REQ-001");
    assert.equal(all.find((r) => r.id === c1.id).status, "accepted");
    assert.equal(all.find((r) => r.id === c2.id).status, "ignored");
    const edited = all.find((r) => r.id === c3.id);
    assert.equal(edited.status, "edited");
    assert.match(edited.editedClaim, /scripts\/ 目录/);
    // accepted 与 edited 都写入 accepted/ 目录；ignored 不写
    const acceptedFiles = readdirSync(path.join(root, "REQ-001", "accepted"));
    assert.deepEqual(acceptedFiles.sort(), [`${c1.id}.md`, `${c3.id}.md`].sort());
    const md = readFileSync(path.join(root, "REQ-001", "accepted", `${c3.id}.md`), "utf8");
    assert.match(md, /review_status: edited/);
    assert.match(md, /edited: true/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("终态候选不可再次审核（防止重复提取后覆盖既有人工决定）", () => {
  const root = tempRoot();
  try {
    const [c1] = seed(root, [{ claim: "规则A", sourceSessionIds: ["s1"], evidence: "e", scope: "x" }]);
    review(root, "REQ-001", c1.id, "accept");
    assert.throws(() => review(root, "REQ-001", c1.id, "ignore"), /仅 pending 可审核/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("冲突检测：新候选与已接受知识相似 → 标记 conflicts 提示而非静默并入", () => {
  const root = tempRoot();
  try {
    const [c1] = seed(root, [
      { claim: "calc.js 除零必须抛出 Error 而不是返回 0", sourceSessionIds: ["s1"], evidence: "e", scope: "calc.js" },
    ]);
    review(root, "REQ-001", c1.id, "accept");
    const [n1] = seed(root, [
      { claim: "calc.js 除零时要抛出 Error，禁止返回 0", sourceSessionIds: ["s2"], evidence: "e", scope: "calc.js" },
    ], "B2");
    detectConflicts([n1], store.readCandidates(root, "REQ-001"));
    assert.equal(n1.status, "pending"); // 冲突不改状态，等用户裁决
    assert.ok(n1.conflicts.length >= 1, "应检测到与已接受知识的冲突");
    assert.equal(n1.conflicts[0].withId, c1.id);
    assert.ok(n1.conflicts[0].similarity > 0.5);
    // 无关新候选不带冲突
    const [n2] = seed(root, [
      { claim: "文档统一用 UTF-8 无 BOM 编码", sourceSessionIds: ["s2"], evidence: "e", scope: "项目" },
    ], "B2");
    detectConflicts([n2], store.readCandidates(root, "REQ-001"));
    assert.equal(n2.conflicts.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("早期错误纠正：batch-1 错误规则被忽略后永不进入 accepted；batch-2 纠正版带 note 且可被接受", () => {
  const root = tempRoot();
  try {
    // batch-1：早期错误规则（后来被证明是错的）
    const [wrong] = seed(root, [
      { claim: "divide 除零时返回 0 即可", sourceSessionIds: ["s1"], evidence: "早期实现如此", scope: "calc.js" },
    ], "B1");
    review(root, "REQ-001", wrong.id, "ignore"); // 用户忽略错误规则

    // batch-2：纠正版出现（复述旧规则关键词以表达纠正关系）
    const [fixed] = seed(root, [
      { claim: "divide 除零时不要返回 0，必须抛出 Error", sourceSessionIds: ["s1", "s2"], evidence: "自测失败后改为 throw", scope: "calc.js" },
    ], "B2");
    detectConflicts([fixed], store.readCandidates(root, "REQ-001"));
    // 与已忽略知识相似 → note 提示检查纠正关系，但不是 conflict、不阻止接受
    assert.equal(fixed.conflicts.length, 0);
    assert.ok(fixed.notes.some((n) => n.withId === wrong.id));
    review(root, "REQ-001", fixed.id, "accept");

    // 终态断言：accepted/ 只含纠正版，旧错误不在其中，且其状态永远 ignored
    const acceptedFiles = readdirSync(path.join(root, "REQ-001", "accepted"));
    assert.deepEqual(acceptedFiles, [`${fixed.id}.md`]);
    const all = store.readCandidates(root, "REQ-001");
    assert.equal(all.find((r) => r.id === wrong.id).status, "ignored");
    // 再次重复提取出现同错误候选：冲突检测对 ignored 只给 note，接受路径需用户显式操作，错误仍无法静默进入
    const [dup] = seed(root, [
      { claim: "divide 除零时返回 0 即可", sourceSessionIds: ["s3"], evidence: "旧记录", scope: "calc.js" },
    ], "B3");
    detectConflicts([dup], store.readCandidates(root, "REQ-001"));
    assert.ok(dup.notes.some((n) => n.withId === wrong.id), "重复错误应提示与已忽略知识相似");
    assert.equal(dup.status, "pending");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
