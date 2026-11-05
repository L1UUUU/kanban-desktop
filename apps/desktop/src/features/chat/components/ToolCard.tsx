// 用途：工具卡片 —— 工具名/参数摘要/状态流转（运行中 spinner→✓/✕/⏹）/时长/输出区（原型一致项 5）
import type { ToolItem } from "../chat-store";

/** 终态时长显示：ms → 「完成 · 3.6s」（原型格式） */
function formatDuration(ms: number | null): string {
  return ms === null ? "" : `${(ms / 1000).toFixed(1)}s`;
}

function statusText(item: ToolItem): string {
  switch (item.status) {
    case "running":
      return "运行中";
    case "completed":
      return `完成 · ${formatDuration(item.durationMs)}`;
    case "denied":
      return "已拒绝";
    case "interrupted":
      return "已中断";
  }
}

function statusIcon(item: ToolItem): React.ReactNode {
  switch (item.status) {
    case "running":
      return <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-border border-t-ok" />;
    case "completed":
      return <span className="text-ok">✓</span>;
    case "denied":
      return <span className="text-destructive">✕</span>;
    case "interrupted":
      return <span className="text-muted-foreground">⏹</span>;
  }
}

export function ToolCard({ item }: { item: ToolItem }) {
  return (
    <div
      className={`mx-auto mb-3.5 max-w-[860px] overflow-hidden rounded-[10px] border bg-card ${
        item.status === "denied" ? "border-destructive" : "border-border"
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2 font-mono text-xs">
        {statusIcon(item)}
        <span className="font-semibold text-accent2">{item.tool}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{item.argsSummary}</span>
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{statusText(item)}</span>
      </div>
      {item.output ? (
        <div className="max-h-[140px] overflow-y-auto whitespace-pre-wrap border-t border-dashed border-border px-3 py-2 font-mono text-xs text-muted-foreground">
          {item.output}
        </div>
      ) : null}
    </div>
  );
}
