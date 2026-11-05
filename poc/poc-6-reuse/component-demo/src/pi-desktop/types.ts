// 最小类型契约，保真拷贝自 PI-Desktop packages/shared/src/types/{messages,workpanel}.ts
// （commit 983f840，LGPL-3.0）。只保留 TurnChangesCard 链路用到的字段，
// 字段名与语义与上游一致，用于验证「类型层可裁剪抽离」。
// 上游 UiMessage 约 274 行、shared 包 32k 行；此处仅抽必需子集。

export type UiMessageRole = "user" | "assistant" | "system" | "tool";

export type UiMessage = {
  id: string;
  role: UiMessageRole;
  content: string;
  createdAt: string;
  toolName?: string;
  toolCallId?: string;
  toolStatus?: "running" | "success" | "error" | "denied";
  toolArgs?: unknown;
  toolResult?: unknown;
  toolDurationMs?: number;
};

export type DiffLineType = "add" | "del" | "context";

export type DiffLine = {
  type: DiffLineType;
  text: string;
};

export type DiffHunk = {
  /** Raw `@@ -a,b +c,d @@ …` header line. */
  header: string;
  lines: DiffLine[];
};

export type ReviewChangeOperation = "write" | "edit" | "delete";
export type ReviewChangeStatus = "added" | "modified" | "deleted";
export type ReviewChangeState = "active" | "rolledBack";

/** Durable, message-owned change evidence returned by a workspace mutation. */
export type ReviewChange = {
  version: 1;
  snapshotId: string;
  messageId: string;
  /** Relative inside the execution workspace; absolute for other approved roots. */
  path: string;
  operation: ReviewChangeOperation;
  status: ReviewChangeStatus;
  state: ReviewChangeState;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  binary?: boolean;
  truncated?: boolean;
  reversible: boolean;
  /** Host-resolved execution root; never a renderer authorization grant. */
  root?: string;
};
