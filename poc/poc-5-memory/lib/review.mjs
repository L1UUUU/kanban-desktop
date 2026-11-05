// 审核层：候选状态流转（pending → accepted/edited/ignored）与冲突检测（相似知识提示、不静默并入）。
import { diceSimilarity } from "./normalize.mjs";
import {
  ACCEPTED,
  EDITED,
  IGNORED,
  PENDING,
  readCandidates,
  writeAccepted,
  writeCandidates,
} from "./store.mjs";

// 冲突/重复检测：新候选与「已进入正式知识（accepted/edited）」的候选相似 → conflicts 提示（不静默并入）；
// 与「已忽略」候选相似 → notes 提示（可能是被纠正的旧知识，不阻止接受）。
// 阈值 0.5：冲突检测是提示性质（只标记 pending），宁多提示不静默；合并去重另用更保守阈值。
export function detectConflicts(newRecords, allRecords, { threshold = 0.5 } = {}) {
  const formal = allRecords.filter((r) => r.status === ACCEPTED || r.status === EDITED);
  const ignored = allRecords.filter((r) => r.status === IGNORED);
  for (const n of newRecords) {
    n.conflicts = [];
    n.notes = n.notes || [];
    for (const f of formal) {
      if (f.id === n.id) continue;
      const sim = diceSimilarity(n.claim, f.editedClaim || f.claim);
      if (sim >= threshold) {
        n.conflicts.push({ withId: f.id, similarity: +sim.toFixed(3), kind: "similar-to-accepted" });
      }
    }
    for (const ig of ignored) {
      if (ig.id === n.id) continue;
      const sim = diceSimilarity(n.claim, ig.claim);
      if (sim >= threshold) {
        n.notes.push({ withId: ig.id, similarity: +sim.toFixed(3), kind: "similar-to-ignored-check-correction" });
      }
    }
  }
  return newRecords;
}

// 审核动作：accept / ignore / edit（edit 附 newClaim，编辑后视为已进入正式知识）。
// 仅 pending 可流转；终态不可再改，防止重复审核覆盖既有决定。
export function review(dataRoot, reqId, candId, action, { newClaim } = {}) {
  const records = readCandidates(dataRoot, reqId);
  const rec = records.find((r) => r.id === candId);
  if (!rec) throw new Error(`候选不存在: ${candId}`);
  if (rec.status !== PENDING) {
    throw new Error(`候选 ${candId} 状态为 ${rec.status}，仅 pending 可审核（终态不可覆盖）`);
  }
  const reviewedAt = new Date().toISOString();
  if (action === "ignore") {
    rec.status = IGNORED;
    rec.reviewAction = "ignore";
    rec.reviewedAt = reviewedAt;
  } else if (action === "accept") {
    rec.status = ACCEPTED;
    rec.reviewAction = "accept";
    rec.reviewedAt = reviewedAt;
    writeAccepted(dataRoot, reqId, rec);
  } else if (action === "edit") {
    if (!newClaim || !newClaim.trim()) throw new Error("edit 需要 newClaim");
    rec.status = EDITED;
    rec.reviewAction = "edit";
    rec.reviewedAt = reviewedAt;
    rec.editedClaim = newClaim.trim();
    writeAccepted(dataRoot, reqId, rec);
  } else {
    throw new Error(`未知审核动作: ${action}`);
  }
  writeCandidates(dataRoot, reqId, records);
  return rec;
}

// 提取批次写入时的入口：追加候选后对「磁盘重读的本批记录」跑冲突检测并回写（conflicts 仅提示，status 仍 pending）
export function appendWithConflictCheck(dataRoot, reqId, store, candidates, opts) {
  store.appendCandidates(dataRoot, reqId, candidates, opts);
  const all = store.readCandidates(dataRoot, reqId);
  const batchRecords = all.filter((r) => r.batchId === opts.batchId);
  detectConflicts(batchRecords, all);
  store.writeCandidates(dataRoot, reqId, all);
  return batchRecords;
}
