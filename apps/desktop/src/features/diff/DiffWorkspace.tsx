// 用途：Diff 视图（#43，spec #40 G 节，第四态）—— 头部统计（N 文件/+M/-L/HEAD 对比口径 + 刷新）+ 文件列表（展开箭头/类型徽标/等宽路径/每文件统计）+ 按文件展开折叠行级红绿 diff（新增绿/删除红/hunk 头/上下文灰，原型 d1 必须一致项）+ 非 git 项目居中空态；只读不回滚；含侧栏第四入口 DiffEntryButton（无当前项目禁用）
import { useState } from "react";
import type { DiffFileRow } from "@kanban/ipc-schema";
import type { WorkspaceDiffController } from "./use-workspace-diff";

/** 类型徽标（原型 d1 配色：M 蓝 primary / A 绿 ok / D 红 destructive / U 黄 warn；R 复用蓝） */
const BADGE_BY_TYPE: Record<DiffFileRow["changeType"], { letter: string; cls: string }> = {
  modified: { letter: "M", cls: "bg-primary/15 text-primary" },
  added: { letter: "A", cls: "bg-ok/15 text-ok" },
  deleted: { letter: "D", cls: "bg-destructive/15 text-destructive" },
  renamed: { letter: "R", cls: "bg-primary/15 text-primary" },
  untracked: { letter: "U", cls: "bg-warn/15 text-warn" },
};

/** 侧栏底部「Diff」入口按钮（原型 d1 第四入口，与看板/记忆入口同款整宽形态；无当前项目禁用） */
export function DiffEntryButton({
  active,
  disabled,
  projectName,
  onToggle,
}: {
  active: boolean;
  /** 无当前项目时禁用（spec US7/F9：未选项目 Diff 入口禁用，两先例入口无此态） */
  disabled: boolean;
  projectName: string | null;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      data-testid="diff-entry"
      title="查看当前项目工作区变更（未提交）"
      disabled={disabled}
      className={`mb-1 flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[13px] disabled:cursor-default disabled:opacity-50 ${
        active ? "border-primary bg-primary/10 text-accent2" : "border-transparent text-muted-foreground hover:border-border hover:bg-muted"
      }`}
      onClick={onToggle}
    >
      <span aria-hidden>🔀</span>
      <span>Diff</span>
      <span className="ml-auto truncate text-[11px] text-fg-faint">{projectName ?? "当前项目"} →</span>
    </button>
  );
}

/** Diff 视图：六态渲染（不可用/空闲/读取中/成功/非 git 空态/错误档） */
export function DiffWorkspace({ controller }: { controller: WorkspaceDiffController }) {
  const { state, refresh } = controller;
  if (state.status === "unavailable") {
    return (
      <section data-testid="diff-unavailable" className="flex items-center justify-center bg-background p-6 text-xs text-fg-faint">
        Diff 服务不可用（window.api 未暴露）
      </section>
    );
  }
  return (
    <section data-testid="diff-workspace" className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      {/* 头部：标题 + 统计（HEAD 对比口径）+ 手动刷新（原型 .diff-head） */}
      <header className="flex flex-none items-center gap-3 border-b border-border px-4 py-3">
        <h2 className="text-[15px] font-semibold">工作区变更</h2>
        {state.status === "ok" ? <DiffStat files={state.files} /> : null}
        <button
          type="button"
          data-testid="diff-refresh"
          disabled={state.status === "loading"}
          className="ml-auto rounded-lg border border-border px-2.5 py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-primary disabled:cursor-default disabled:opacity-50"
          onClick={() => void refresh()}
        >
          ↻ 刷新
        </button>
      </header>
      {/* 文件列表 / 空态 / 错误档 */}
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-4">
        {state.status === "loading" ? <p className="text-xs text-fg-faint">读取工作区变更中…</p> : null}
        {state.status === "idle" ? <p className="text-xs text-fg-faint">未选择项目</p> : null}
        {state.status === "empty" ? <DiffEmpty text="当前项目不是 git 仓库，无变更可展示" /> : null}
        {state.status === "error" ? (
          <div data-testid="diff-error" className="px-2 py-3 text-xs text-destructive">
            ⚠ 读取工作区变更失败：{state.message}
          </div>
        ) : null}
        {state.status === "ok" && state.files.length === 0 ? <DiffEmpty text="无未提交变更" /> : null}
        {state.status === "ok" && state.files.length > 0 ? state.files.map((f) => <DiffFileCard key={`${f.changeType}:${f.path}`} file={f} />) : null}
      </div>
    </section>
  );
}

/** 居中空态（非 git 项目不弹窗报错；干净工作区同位） */
function DiffEmpty({ text }: { text: string }) {
  return (
    <div data-testid="diff-empty" className="flex flex-1 flex-col items-center justify-center gap-2 text-fg-faint">
      <span aria-hidden>🔀</span>
      <p className="text-xs">{text}</p>
    </div>
  );
}

/** 头部统计（原型 .diff-stat：N 个文件 · +M -L · 未提交（HEAD 对比）） */
function DiffStat({ files }: { files: DiffFileRow[] }) {
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <span data-testid="diff-stat" className="text-xs text-muted-foreground">
      {files.length} 个文件 · <span className="text-ok">+{adds}</span> <span className="text-destructive">-{dels}</span> · 未提交（HEAD 对比）
    </span>
  );
}

/** 文件卡：头部行（箭头/徽标/等宽路径/统计）+ 展开行级 diff（默认收起） */
function DiffFileCard({ file }: { file: DiffFileRow }) {
  const [open, setOpen] = useState(false);
  const badge = BADGE_BY_TYPE[file.changeType];
  return (
    <div className="overflow-hidden rounded-[10px] border border-border bg-card">
      <button
        type="button"
        data-testid="diff-file-head"
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden className={`flex-none text-fg-faint transition-transform ${open ? "rotate-90" : ""}`}>
          ▶
        </span>
        <span data-testid={`diff-badge-${badge.letter}`} className={`flex-none rounded px-1.5 text-[11px] font-semibold ${badge.cls}`}>
          {badge.letter}
        </span>
        <span className="min-w-0 truncate font-mono text-xs" title={file.oldPath ?? file.path}>
          {file.path}
        </span>
        <span className="ml-auto flex-none text-[11px]">
          {file.changeType === "untracked" ? (
            "新文件（未跟踪）"
          ) : file.binary ? (
            "二进制文件"
          ) : (
            <>
              {file.additions > 0 ? <span className="text-ok">+{file.additions}</span> : null}
              {file.additions > 0 && file.deletions > 0 ? " " : null}
              {file.deletions > 0 ? <span className="text-destructive">-{file.deletions}</span> : null}
            </>
          )}
        </span>
      </button>
      {open && file.hunks != null && file.hunks.length > 0 ? (
        <div className="border-t border-border font-mono text-xs leading-[1.55]">
          {file.hunks.map((hunk, hi) => (
            <div key={`${hunk.header}:${hi}`}>
              <div data-testid="diff-line-hunk" className="whitespace-pre bg-diff-hunk px-3 text-fg-faint">
                {hunk.header}
              </div>
              {hunk.lines.map((line, li) => {
                if (line.kind === "add") {
                  return (
                    <div key={li} data-testid="diff-line-add" className="whitespace-pre bg-diff-add px-3 text-diff-add-fg">
                      +{line.text}
                    </div>
                  );
                }
                if (line.kind === "del") {
                  return (
                    <div key={li} data-testid="diff-line-del" className="whitespace-pre bg-diff-del px-3 text-diff-del-fg">
                      -{line.text}
                    </div>
                  );
                }
                return (
                  <div key={li} data-testid="diff-line-context" className="whitespace-pre px-3 text-muted-foreground">
                    {" " + line.text}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
