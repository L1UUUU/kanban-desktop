// 裁剪自 PI-Desktop apps/desktop/src/lib/workspace-review.ts（commit 983f840，LGPL-3.0）。
// 上游 192 行含 ReviewChangesSummary 等聚合 API；此处仅保留
// reviewChangeFromMessage 所需的解析辅助与其本体，逻辑零改动。
// 改动：类型 import 从 "@pi-desktop/shared" 改为本地 "./types" stub。

import type { DiffHunk, ReviewChange, ReviewChangeState, ReviewChangeStatus, UiMessage } from "./types";

const REVIEW_CHANGE_TOOLS = new Set(["Write", "Edit"]);
const REVIEW_CHANGE_STATUSES = new Set<ReviewChangeStatus>([
  "added",
  "modified",
  "deleted",
]);
const REVIEW_CHANGE_OPERATIONS = new Set(["write", "edit", "delete"]);
const REVIEW_CHANGE_STATES = new Set<ReviewChangeState>([
  "active",
  "rolledBack",
]);

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function toolResultDetails(message: UiMessage): Record<string, unknown> | null {
  return recordValue(recordValue(message.toolResult)?.details);
}

function parseHunks(value: unknown): DiffHunk[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((hunk) => {
    const record = recordValue(hunk);
    const header = nonEmptyString(record?.header);
    if (!header || !Array.isArray(record?.lines)) return [];
    const lines: DiffHunk["lines"] = record.lines.flatMap((line) => {
      const lineRecord = recordValue(line);
      const type = lineRecord?.type;
      const text = typeof lineRecord?.text === "string" ? lineRecord.text : null;
      const lineType =
        type === "add" || type === "del" || type === "context" ? type : null;
      if (
        text === null ||
        lineType === null
      ) {
        return [];
      }
      return [{ type: lineType, text }];
    });
    return [{ header, lines }];
  });
}

/**
 * Read the durable change record embedded in one successful tool message.
 * The message owns this evidence; no current Git state is consulted.
 */
export function reviewChangeFromMessage(message: UiMessage): ReviewChange | null {
  if (
    message.role !== "tool" ||
    message.toolStatus !== "success" ||
    !REVIEW_CHANGE_TOOLS.has(message.toolName || "")
  ) {
    return null;
  }

  const details = toolResultDetails(message);
  if (!details || !["workspace", "scratch", "external", "visualization"].includes(String(details.root))) return null;
  const review = recordValue(details.review);
  if (!review || review.version !== 1) return null;

  const snapshotId = nonEmptyString(review.snapshotId);
  const messageId = nonEmptyString(review.messageId);
  const path = nonEmptyString(review.path);
  const operation = review.operation;
  const status = review.status;
  const state = review.state;
  const additions = nonNegativeInteger(review.additions);
  const deletions = nonNegativeInteger(review.deletions);
  if (
    !snapshotId ||
    !messageId ||
    !path ||
    typeof operation !== "string" ||
    !REVIEW_CHANGE_OPERATIONS.has(operation) ||
    typeof status !== "string" ||
    !REVIEW_CHANGE_STATUSES.has(status as ReviewChangeStatus) ||
    typeof state !== "string" ||
    !REVIEW_CHANGE_STATES.has(state as ReviewChangeState) ||
    additions === null ||
    deletions === null
  ) {
    return null;
  }

  return {
    version: 1,
    snapshotId,
    messageId,
    path,
    operation: operation as ReviewChange["operation"],
    status: status as ReviewChangeStatus,
    state: state as ReviewChangeState,
    additions,
    deletions,
    hunks: parseHunks(review.hunks),
    ...(review.binary === true ? { binary: true } : {}),
    ...(review.truncated === true ? { truncated: true } : {}),
    reversible: review.reversible === true,
    ...(typeof review.root === "string" ? { root: review.root } : {}),
  };
}

// reviewFilePathLabel 原样拷贝自 PI-Desktop apps/desktop/src/lib/review-history.ts（79 行文件中的单个函数）。
export function reviewFilePathLabel(path: string): string {
  const posix = path.replaceAll("\\", "/");
  let outside = posix.startsWith("/") || /^[a-z]:\//i.test(posix);
  let depth = 0;
  for (const segment of posix.split("/")) {
    if (segment === "..") { if (--depth < 0) outside = true; }
    else if (segment && segment !== ".") depth++;
  }
  return outside ? `.../${posix.split("/").filter(Boolean).at(-1) ?? path}` : path;
}
