// 用途：Markdown 存储布局与原子写（spec #27 D/E 节）—— 项目级知识/需求级总结路径、temp+rename 原子写、accepted 知识元数据头渲染（演进自 poc-5 store.mjs，参照 pi-sleep-agent T2）
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemoryCandidateRecord } from "./store";

/** 项目级知识目录：<dataRoot>/<projectId>/accepted/（需求删除仍保留） */
export function acceptedDir(dataRoot: string, projectId: string): string {
  return join(dataRoot, projectId, "accepted");
}

/** 项目级知识文件：<dataRoot>/<projectId>/accepted/CAND-xxxx.md */
export function acceptedMdPath(dataRoot: string, projectId: string, displayNo: string): string {
  return join(acceptedDir(dataRoot, projectId), `${displayNo}.md`);
}

/** 需求级目录：<dataRoot>/<projectId>/requirements/<REQ>/（需求删除即清理） */
export function requirementDir(dataRoot: string, projectId: string, requirementId: string): string {
  return join(dataRoot, projectId, "requirements", requirementId);
}

/** 需求总结文件：summary.md */
export function summaryMdPath(dataRoot: string, projectId: string, requirementId: string): string {
  return join(requirementDir(dataRoot, projectId, requirementId), "summary.md");
}

/** 人工编辑后的不覆盖暂存文件：summary.proposed.<batchId>.md */
export function proposedMdPath(dataRoot: string, projectId: string, requirementId: string, batchId: string): string {
  return join(requirementDir(dataRoot, projectId, requirementId), `summary.proposed.${batchId}.md`);
}

/** 文本内容 SHA-256（人工编辑检测基准） */
export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// 原子写：先写同目录临时文件再 rename（rename 在两平台均原子替换既有文件），避免半截文件可见
export function writeAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
}

/** 正式知识正文取值：编辑值优先、缺省回原值（冲突比较与 md 渲染共用同一基准） */
export function effectiveValue(edited: string | null, original: string): string {
  return edited ?? original;
}

/** accepted/edited 知识 md（review 元数据头：id/项目/需求/claim/来源/证据/范围/批次/状态/审核时间 + 正文） */
export function renderAcceptedMd(rec: MemoryCandidateRecord): string {
  const claim = effectiveValue(rec.editedClaim, rec.claim);
  const scope = effectiveValue(rec.editedScope, rec.scope);
  return [
    "---",
    `id: ${rec.displayNo}`,
    `project: ${rec.projectId}`,
    `requirement: ${rec.requirementId}`,
    `claim: ${JSON.stringify(claim)}`,
    `source_sessions: ${JSON.stringify(rec.sourceSessionIds)}`,
    `evidence: ${JSON.stringify(rec.evidence)}`,
    `scope: ${JSON.stringify(scope)}`,
    `generated_batch: ${rec.batchId}`,
    `review_status: ${rec.status}`,
    `reviewed_at: ${rec.reviewedAt}`,
    `edited: ${rec.editedClaim != null || rec.editedScope != null ? "true" : "false"}`,
    "---",
    "",
    `# ${claim}`,
    "",
    `- 证据：${rec.evidence}`,
    `- 适用范围：${scope}`,
    `- 来源 Session：${rec.sourceSessionIds.join(", ")}`,
    `- 生成批次：${rec.batchId}`,
    "",
  ].join("\n");
}
