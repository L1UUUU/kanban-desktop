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

/** tracker CLI 名 → 显示名（未知名原样返回；卡片依据行与详情面板共用） */
export function cliLabel(cli: string): string {
  return TRACKER_CLI_LABELS[cli] ?? cli;
}

/** 依据时间 → MM-DD 或 MM-DD HH:mm（卡片行省略时间，详情面板含时间；不可解析原样返回） */
function formatBasisDate(iso: string, withTime = false): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (!withTime) return md;
  return `${md} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 卡片阶段依据行（原型一致项 3）：skill 依据「skill · CLI · MM-DD」；manual 依据「手动修正 · MM-DD」；无依据 null（不渲染） */
export function formatStageBasis(basis: StageBasisWire | null): string | null {
  if (!basis) return null;
  const date = formatBasisDate(basis.at);
  if (basis.kind === "skill") return `${basis.skill} · ${cliLabel(basis.cli)} · ${date}`;
  return `手动修正 · ${date}`;
}

/** 详情面板「当前依据」行（原型一致项 4）：skill 依据「skill · CLI · 证据等级 · MM-DD HH:mm」；manual 依据「手动修正 · MM-DD HH:mm」 */
export function formatDetailBasis(basis: StageBasisWire | null): string | null {
  if (!basis) return null;
  const ts = formatBasisDate(basis.at, true);
  if (basis.kind === "skill") return `${basis.skill} · ${cliLabel(basis.cli)} · ${basis.evidenceLevel} · ${ts}`;
  return `手动修正 · ${ts}`;
}
