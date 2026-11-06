// 用途：看板五列定义与纯映射（#18）—— stage=null（未开始，wire 上 "none" → tracker 归一 null）→ 列 0；阶段依据行「skill · CLI · 日期」格式化（原型一致项 2/3）
import type { KanbanStage, StageBasisWire } from "@kanban/ipc-schema";

/** 五列（原型场景 2）：未开始（stage=null）/ Design / Implement / PR / Retro；dot = 列头色标类 */
export const KANBAN_COLUMNS = [
  { key: "none", title: "未开始", dot: "bg-fg-faint" },
  { key: "Design", title: "Design", dot: "bg-primary" },
  { key: "Implement", title: "Implement", dot: "bg-ok" },
  { key: "PR", title: "PR", dot: "bg-opencode" },
  { key: "Retro", title: "Retro", dot: "bg-pty" },
] as const;

/** 阶段 → 列下标（0..4）；stage=null（未开始）→ 0（易踩坑：wire "none" → tracker null → 列 0） */
export function stageToColumn(stage: KanbanStage | null): number {
  if (stage === null) return 0;
  const ix = KANBAN_COLUMNS.findIndex((c) => c.key === stage);
  return ix < 0 ? 0 : ix;
}

// tracker CLI 名 → 显示名（与侧栏 CLI 色点命名一致）
const TRACKER_CLI_LABELS: Record<string, string> = {
  "claude-code": "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  pty: "PTY",
};

/** 依据时间 → MM-DD（原型「design-feature · Claude · 11-06」形态；不可解析原样返回） */
function formatBasisDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 卡片阶段依据行（原型一致项 3）：skill 依据「skill · CLI · MM-DD」；manual 依据「手动修正 · MM-DD」；无依据 null（不渲染） */
export function formatStageBasis(basis: StageBasisWire | null): string | null {
  if (!basis) return null;
  const date = formatBasisDate(basis.at);
  if (basis.kind === "skill") return `${basis.skill} · ${TRACKER_CLI_LABELS[basis.cli] ?? basis.cli} · ${date}`;
  return `手动修正 · ${date}`;
}
