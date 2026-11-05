// Memory 存储层：Kanban 管理的本地数据目录布局（data/<reqId>/...），summary 人工编辑检测与不静默覆盖，候选追加与批次 id。
// 布局：data/<reqId>/summary.md（当前生效总结）
//       data/<reqId>/summary.meta.json（生成批次与内容 hash，用于人工编辑检测）
//       data/<reqId>/summary.proposed.<batchId>.md（人工编辑后新批次的不覆盖暂存）
//       data/<reqId>/candidates.jsonl（候选状态机主记录）
//       data/<reqId>/accepted/<CAND-ID>.md（用户接受/编辑后写入的正式知识，带 review 元数据）
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PENDING = "pending";
export const ACCEPTED = "accepted";
export const EDITED = "edited"; // 用户编辑内容后接受（终态，属已进入正式知识）
export const IGNORED = "ignored";

export function reqDir(dataRoot, reqId) {
  return path.join(dataRoot, reqId);
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// 写入/更新需求开发总结。若磁盘上 summary.md 与上次生成的 hash 不一致（人工编辑过），
// 则不覆盖，改写 summary.proposed.<batchId>.md 并返回 { overwritten:false, reason:"human-edited", proposed }。
export function writeSummary(dataRoot, reqId, content, { batchId, generatedAt }) {
  const dir = reqDir(dataRoot, reqId);
  ensureDir(dir);
  const summaryFile = path.join(dir, "summary.md");
  const metaFile = path.join(dir, "summary.meta.json");
  if (existsSync(summaryFile)) {
    const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : {};
    const diskHash = sha256(readFileSync(summaryFile, "utf8"));
    if (meta.contentHash && meta.contentHash !== diskHash) {
      const proposed = path.join(dir, `summary.proposed.${batchId}.md`);
      writeFileSync(proposed, content, "utf8");
      return { overwritten: false, reason: "human-edited", proposed };
    }
  }
  writeFileSync(summaryFile, content, "utf8");
  writeFileSync(
    metaFile,
    JSON.stringify({ batchId, generatedAt, contentHash: sha256(content) }, null, 2),
    "utf8",
  );
  return { overwritten: true, file: summaryFile };
}

// 追加一批候选：分配全局递增 id（CAND-0001）、初始 pending、写入批次与冲突标记
export function appendCandidates(dataRoot, reqId, candidates, { batchId, now = () => new Date().toISOString() }) {
  const dir = reqDir(dataRoot, reqId);
  ensureDir(dir);
  const file = path.join(dir, "candidates.jsonl");
  const existing = readCandidates(dataRoot, reqId);
  let seq = existing.reduce((m, c) => Math.max(m, numOf(c.id)), 0);
  const records = candidates.map((c) => ({
    id: `CAND-${String(++seq).padStart(4, "0")}`,
    reqId,
    claim: c.claim,
    sourceSessionIds: c.sourceSessionIds || [],
    evidence: c.evidence || "",
    scope: c.scope || "",
    batchId,
    status: PENDING,
    conflicts: c.conflicts || [],
    notes: c.notes || [],
    segments: c.segments || [],
    createdAt: now(),
    reviewedAt: null,
    reviewAction: null,
    editedClaim: null,
  }));
  const lines = records.map((r) => JSON.stringify(r)).join("\n");
  if (existsSync(file)) {
    const prev = readFileSync(file, "utf8").replace(/\s*$/, "");
    writeFileSync(file, `${prev}\n${lines}\n`, "utf8");
  } else {
    writeFileSync(file, `${lines}\n`, "utf8");
  }
  return records;
}

function numOf(id) {
  const m = /CAND-(\d+)/.exec(id || "");
  return m ? Number(m[1]) : 0;
}

// 读取全部候选记录（按行 JSON）
export function readCandidates(dataRoot, reqId) {
  const file = path.join(reqDir(dataRoot, reqId), "candidates.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// 全量回写候选（review 状态流转后使用；仅本模块与 review 使用，保证 jsonl 一致性）
export function writeCandidates(dataRoot, reqId, records) {
  const dir = reqDir(dataRoot, reqId);
  ensureDir(dir);
  writeFileSync(
    path.join(dir, "candidates.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  );
}

// 接受/编辑后写入正式知识文件 accepted/<CAND-ID>.md，带完整 review 元数据头（参照 pi-sleep-agent T2）
export function writeAccepted(dataRoot, reqId, record) {
  const dir = path.join(reqDir(dataRoot, reqId), "accepted");
  ensureDir(dir);
  const claim = record.editedClaim || record.claim;
  const body = [
    "---",
    `id: ${record.id}`,
    `requirement: ${record.reqId}`,
    `claim: ${JSON.stringify(claim)}`,
    `source_sessions: ${JSON.stringify(record.sourceSessionIds)}`,
    `evidence: ${JSON.stringify(record.evidence)}`,
    `scope: ${JSON.stringify(record.scope)}`,
    `generated_batch: ${record.batchId}`,
    `review_status: ${record.status}`,
    `reviewed_at: ${record.reviewedAt}`,
    `edited: ${record.editedClaim ? "true" : "false"}`,
    "---",
    "",
    `# ${claim}`,
    "",
    `- 证据：${record.evidence}`,
    `- 适用范围：${record.scope}`,
    `- 来源 Session：${record.sourceSessionIds.join(", ")}`,
    `- 生成批次：${record.batchId}（提取于 ${(record.segments || []).join(", ") || "整段"}）`,
    "",
  ].join("\n");
  writeFileSync(path.join(dir, `${record.id}.md`), body, "utf8");
}
