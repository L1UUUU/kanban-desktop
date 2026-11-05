// 审核流演示脚本（确定性，不调模型）：
// review-batch1：模拟用户对 batch-1 候选的 accept/edit/ignore 三种操作，并人工编辑 summary.md；
// verify-batch2：重复提取后验证 summary 未被静默覆盖（proposed 暂存）、新候选带冲突提示、
//                早期错误候选（若提取出「除零返回 0」类错误规则）仍处 pending/ignored、未进入 accepted/。
// 用法：node scripts/demo-review.mjs review-batch1 | verify-batch2
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "../lib/store.mjs";
import { review } from "../lib/review.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const ACTION = process.argv[2] || "review-batch1";

function reviewBatch1() {
  const all = store.readCandidates(DATA, "REQ-001");
  const pending = all.filter((c) => c.status === "pending");
  if (pending.length < 3) {
    console.log(`[demo-review] pending 候选仅 ${pending.length} 条，少于演示所需的 3 条`);
  }
  // 模拟用户：第 1 条接受、第 2 条编辑后接受、第 3 条忽略；其余保持 pending
  const acts = ["accept", "edit", "ignore"];
  const done = [];
  for (let i = 0; i < Math.min(3, pending.length); i++) {
    const c = pending[i];
    if (acts[i] === "edit") {
      const edited = review(DATA, "REQ-001", c.id, "edit", {
        newClaim: `${c.claim}（用户批注：以 calc.js 当前实现为准）`,
      });
      done.push({ id: c.id, action: "edit", status: edited.status, editedClaim: edited.editedClaim });
    } else {
      const r = review(DATA, "REQ-001", c.id, acts[i]);
      done.push({ id: c.id, action: acts[i], status: r.status });
    }
  }
  console.log("[demo-review] batch-1 审核动作：", JSON.stringify(done, null, 2));

  // 模拟人工编辑 summary（重复提取不覆盖的触发条件）
  const summaryFile = path.join(DATA, "REQ-001", "summary.md");
  const before = readFileSync(summaryFile, "utf8");
  writeFileSync(summaryFile, before + "\n> 人工补充：divide 的除零行为已包含在回归自测中，维护时保留断言。\n", "utf8");
  console.log("[demo-review] 已人工编辑 summary.md（追加人工补充行），等待重复提取验证不覆盖");
}

function verifyBatch2() {
  const all = store.readCandidates(DATA, "REQ-001");
  const accepted = all.filter((c) => c.status === "accepted" || c.status === "edited");
  const ignored = all.filter((c) => c.status === "ignored");
  const b2pending = all.filter((c) => c.batchId === "B2" && c.status === "pending");
  const conflicted = b2pending.filter((c) => c.conflicts.length > 0);

  // 1) summary 不覆盖：磁盘上仍是人工编辑版 + proposed 暂存存在
  const summaryFile = path.join(DATA, "REQ-001", "summary.md");
  const summary = readFileSync(summaryFile, "utf8");
  const humanMarkKept = summary.includes("人工补充");
  const dirFiles = readdirSync(path.join(DATA, "REQ-001"));
  const proposed = dirFiles.filter((f) => f.startsWith("summary.proposed."));
  const meta = JSON.parse(readFileSync(path.join(DATA, "REQ-001", "summary.meta.json"), "utf8"));

  // 2) 早期错误候选检查：claim 含「除零...返回 0」且不含抛错语义的候选必须不在 accepted
  const wrongPattern = /除零|除以 ?0|divide/;
  const wrongClaims = all.filter(
    (c) => wrongPattern.test(c.claim) && /返回 ?0/.test(c.claim) && !/抛出|throw/.test(c.claim),
  );
  const wrongInAccepted = wrongClaims.filter((c) => c.status === "accepted" || c.status === "edited");

  const report = {
    summaryHumanMarkKept: humanMarkKept,
    summaryMetaBatch: meta.batchId,
    proposedFiles: proposed,
    acceptedIds: accepted.map((c) => c.id),
    ignoredIds: ignored.map((c) => c.id),
    batch2Pending: b2pending.length,
    batch2Conflicted: conflicted.map((c) => ({ id: c.id, conflicts: c.conflicts })),
    wrongRuleCandidates: wrongClaims.map((c) => ({ id: c.id, status: c.status, claim: c.claim })),
    wrongInAccepted: wrongInAccepted.map((c) => c.id),
    acceptedDir: readdirSync(path.join(DATA, "REQ-001", "accepted")),
  };
  writeFileSync(path.join(ROOT, "logs", "verify-batch2.json"), JSON.stringify(report, null, 2), "utf8");
  console.log("[verify-batch2]", JSON.stringify(report, null, 2));
  const ok =
    humanMarkKept && proposed.length > 0 && wrongInAccepted.length === 0;
  console.log(`[verify-batch2] 判定：summary 未被覆盖=${humanMarkKept}，proposed 暂存=${proposed}，错误规则进入 accepted=${wrongInAccepted.length}，整体 ${ok ? "PASS" : "FAIL"}`);
}

if (ACTION === "review-batch1") reviewBatch1();
else if (ACTION === "verify-batch2") verifyBatch2();
else throw new Error(`未知动作: ${ACTION}`);
