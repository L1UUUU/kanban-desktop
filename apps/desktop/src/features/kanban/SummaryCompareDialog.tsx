// 用途：总结对比弹层（#33，原型一致项 5 / 演示 ② 对比查看）—— 人工版 vs 新版两栏并排只读 + 二选一处置（采纳新版/保留人工版；同提示条动作）
import type { MemorySummaryChoice } from "@kanban/ipc-schema";

export interface SummaryCompareDialogProps {
  /** 暂存 proposed 的批次（标题展示） */
  batchLabel: string;
  /** 人工版正文（当前生效） */
  humanContent: string;
  /** 新版正文（待处置） */
  newContent: string;
  onClose(): void;
  /** 二选一处置（resolveSummary）；拒绝由调用方呈现 */
  onResolve(choice: MemorySummaryChoice): void;
}

/** 总结对比弹层：两栏并排只读（white-space:pre-wrap 展示 Markdown 正文） */
export function SummaryCompareDialog({ batchLabel, humanContent, newContent, onClose, onResolve }: SummaryCompareDialogProps) {
  return (
    <div
      data-testid="memory-compare-mask"
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        data-testid="memory-compare-dialog"
        className="flex w-[480px] max-w-full flex-col rounded-xl border border-border bg-card p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-sm font-semibold">总结对比 · 人工版 ↔ 新版（批次 {batchLabel}）</h3>
        <div className="flex gap-3 text-xs text-muted-foreground">
          <div
            data-testid="memory-compare-human"
            className="min-h-[160px] flex-1 whitespace-pre-wrap rounded-lg border border-dashed border-border p-2.5"
          >
            <span className="mb-1 block text-[11px] text-fg-faint">人工版（当前生效）</span>
            {humanContent}
          </div>
          <div
            data-testid="memory-compare-new"
            className="min-h-[160px] flex-1 whitespace-pre-wrap rounded-lg border border-primary/40 p-2.5"
          >
            <span className="mb-1 block text-[11px] text-fg-faint">新版（待处置）</span>
            {newContent}
          </div>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            data-testid="memory-compare-close"
            className="rounded-md border border-border px-3 py-1 text-xs text-muted-foreground hover:border-primary hover:text-foreground"
            onClick={onClose}
          >
            关闭
          </button>
          <button
            type="button"
            data-testid="memory-compare-accept"
            className="rounded-md border border-primary bg-primary/15 px-3 py-1 text-xs text-foreground hover:bg-primary/25"
            onClick={() => onResolve("accept-new")}
          >
            采纳新版
          </button>
          <button
            type="button"
            data-testid="memory-compare-keep"
            className="rounded-md border border-border px-3 py-1 text-xs text-muted-foreground hover:border-primary hover:text-foreground"
            onClick={() => onResolve("keep-human")}
          >
            保留人工版
          </button>
        </div>
      </div>
    </div>
  );
}
