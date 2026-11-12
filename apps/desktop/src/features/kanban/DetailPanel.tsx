// 用途：需求详情滑出面板（#19，原型一致项 4/5）—— 看板右侧滑出：标题行内编辑（kanban:rename，事件流保证重启不回退）/ uncertain 提示条 +「确认当前阶段」（= setStage 当前阶段）/ 五段阶段修正条（含当前依据展示 skill·CLI·证据等级·时间；manual 显示手动修正）/ 删除需求 + 二次确认弹层；关联会话区为 RelatedSessionsArea 挂点（#20 填充）；需求经验区为 MemoryArea 挂点（#33 填充，挂关联会话区之后）
import { useRef, useState } from "react";
import type { KanbanStageInput, RequirementCardRow, StageBasisWire } from "@kanban/ipc-schema";
import { KANBAN_COLUMNS, cliLabel, formatDetailBasis } from "./columns";
import { MemoryArea } from "./MemoryArea";
import { RelatedSessionsArea, type RelatedSessionsAreaProps } from "./RelatedSessionsArea";
import type { RequirementMemoryController } from "./use-requirement-memory";

/** 面板动作面（use-kanban 控制器提供；全部经 kanban:* IPC 落事件流，变更经 tracker 推送回流） */
export interface DetailActions {
  /** 标题行内编辑提交（kanban:rename）；返回 null=成功、错误文案=失败（面板回滚原值 + 行内提示，#84 不再静默） */
  onRename(requirementId: string, title: string): Promise<string | null>;
  /** 阶段修正与 uncertain 确认共用（kanban:setStage；"none" = 未开始，tracker 归一 null） */
  onSetStage(requirementId: string, stage: KanbanStageInput): void;
  /** 删除需求（kanban:delete；二次确认弹层「确认删除」后调用） */
  onDelete(requirementId: string): void;
  /** 关闭面板（清 activeRequirementId） */
  onClose(): void;
}

/** uncertain 提示文案（原型：阶段由 self_reported 信号（implement-spec · Codex）驱动，尚未经独立验证） */
function uncertainText(basis: StageBasisWire | null): string {
  if (basis?.kind === "skill") {
    return `阶段由 ${basis.evidenceLevel} 信号（${basis.skill} · ${cliLabel(basis.cli)}）驱动，尚未经独立验证`;
  }
  return "阶段由 self_reported/simulated 信号驱动，尚未经独立验证";
}

/**
 * 详情滑出面板：透明遮罩（点击看板任意处关）+ 右侧 360px 面板 + 删除二次确认弹层（弹层遮罩覆盖整个看板区，原型场景 4）。
 * 挂载于看板容器（KanbanWorkspace 的 relative section）内，activeRequirementId 清空即卸载
 */
export function DetailPanel({
  card,
  actions,
  related,
  memory,
}: {
  card: RequirementCardRow;
  actions: DetailActions;
  /** #20：关联会话区数据与动作（会话列表/关联已有候选/跳转/建会话）；缺省时关联区保持占位形态 */
  related?: Omit<RelatedSessionsAreaProps, "card">;
  /** #33：需求记忆控制器（需求经验区数据源与动作；缺省时该区保持占位形态） */
  memory?: RequirementMemoryController | null;
}) {
  // 行内标题草稿：外部标题变化（rename 回流/再水化）在渲染期同步回输入框（React 调整态模式，不用 effect）
  const [title, setTitle] = useState(card.title);
  const [syncedTitle, setSyncedTitle] = useState(card.title);
  if (syncedTitle !== card.title) {
    setSyncedTitle(card.title);
    setTitle(card.title);
  }
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // 重命名失败行内提示（#84：失败回滚 + 提示，不再静默日志）；成功或重新编辑后清除
  const [renameError, setRenameError] = useState<string | null>(null);
  // Esc 还原哨兵：Escape 已恢复草稿后，随后的 blur 只收尾不提交（防陈旧草稿被提交，不依赖渲染时序）
  const escapeRef = useRef(false);

  /** 提交标题：空白不落（恢复原标题），否则 kanban:rename——失败回滚原值 + 行内错误提示 */
  const commitTitle = (): void => {
    if (escapeRef.current) {
      escapeRef.current = false;
      return;
    }
    const next = title.trim();
    if (!next || next === card.title) {
      setTitle(card.title);
      return;
    }
    void actions.onRename(card.id, next).then((err) => {
      if (err) {
        setTitle(card.title); // store 未变（rename 失败），显式回滚原值
        setRenameError(err);
      } else {
        setRenameError(null);
      }
    });
  };

  const basisText = formatDetailBasis(card.stageBasis);

  return (
    <>
      {/* 透明点击遮罩：不改变看板视觉（原型无遮罩样式），点看板区域即关面板 */}
      <button
        type="button"
        aria-label="关闭详情面板"
        data-testid="detail-backdrop"
        className="absolute inset-0 z-10 cursor-default bg-transparent"
        onClick={actions.onClose}
      />
      {/* 删除二次确认弹层（原型一致项 5）：遮罩覆盖整个看板区，点遮罩取消 */}
      {confirmingDelete ? (
        <div
          data-testid="delete-confirm-mask"
          className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setConfirmingDelete(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            data-testid="delete-confirm-dialog"
            className="w-[400px] max-w-full rounded-xl border border-border bg-card p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-2 text-sm font-semibold">删除需求「{card.title}」？</h3>
            <p className="mb-3.5 text-xs leading-relaxed text-muted-foreground">
              仅删除需求卡片与全部会话关联；会话本身、聊天历史与事件日志保留，不受影响。
              已接受/已编辑的项目知识保留；需求总结与待审候选一并删除。此操作不可撤销。
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                data-testid="cancel-delete-button"
                className="rounded-md border border-border bg-muted px-3 py-1 text-xs hover:border-primary"
                onClick={() => setConfirmingDelete(false)}
              >
                取消
              </button>
              <button
                type="button"
                data-testid="confirm-delete-button"
                className="rounded-md border border-destructive/50 px-3 py-1 text-xs text-destructive hover:bg-destructive/10"
                onClick={() => actions.onDelete(card.id)}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <aside
        data-testid="detail-panel"
        className="absolute bottom-0 right-0 top-0 z-20 flex w-[360px] flex-col border-l border-border bg-card shadow-[-12px_0_32px_rgba(0,0,0,0.45)]"
      >
        {/* 标题行：行内编辑 + 关闭钮；重命名失败行内提示（#84） */}
        <div className="flex flex-none flex-col border-b border-border">
          <div className="flex items-center gap-2 px-3.5 py-3">
            <input
              data-testid="detail-title-input"
              aria-label="需求标题"
              title="点击编辑标题（自动建卡的初始标题为「待命名需求」）"
              className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 font-semibold text-foreground hover:border-border focus:border-border focus:bg-muted focus:outline-none"
              value={title}
              onChange={(e) => {
                escapeRef.current = false; // 新输入即新意图，解除 Esc 哨兵
                setTitle(e.target.value);
              }}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  escapeRef.current = true;
                  setTitle(card.title);
                  e.currentTarget.blur();
                }
              }}
            />
            <button
              type="button"
              aria-label="关闭详情"
              data-testid="detail-close"
              title="关闭详情面板"
              className="flex h-6.5 w-6.5 flex-none items-center justify-center rounded-md border border-border text-muted-foreground hover:border-primary"
              onClick={actions.onClose}
            >
              ✕
            </button>
          </div>
          {renameError ? (
            <p data-testid="detail-rename-error" className="px-3.5 pb-2 text-[11px] text-destructive">
              重命名失败：{renameError}
            </p>
          ) : null}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-3.5 py-3">
          {/* uncertain 提示条 + 确认当前阶段（S2-04：确认 = setStage 当前阶段，manual verified 确认语义） */}
          {card.uncertain ? (
            <div
              data-testid="uncertain-note"
              className="flex flex-none items-center gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn"
            >
              <span className="min-w-0 flex-1">{uncertainText(card.stageBasis)}</span>
              <button
                type="button"
                data-testid="confirm-stage-button"
                className="flex-none rounded-md border border-warn/55 px-2.5 py-0.5 hover:bg-warn/10"
                onClick={() => actions.onSetStage(card.id, card.stage ?? "none")}
              >
                确认当前阶段
              </button>
            </div>
          ) : null}
          {/* 五段阶段修正条 + 当前依据（S2-05：立即生效不锁定；「未开始」wire 上为 "none"） */}
          <section className="flex flex-col gap-2">
            <h5 className="text-[11px] tracking-wide text-muted-foreground">阶段（点击修正；立即生效，可被后续有效事件覆盖）</h5>
            <div className="flex gap-1" role="group" aria-label="阶段修正">
              {KANBAN_COLUMNS.map((c) => {
                const on = c.key === "none" ? card.stage === null : card.stage === c.key;
                return (
                  <button
                    key={c.key}
                    type="button"
                    data-testid={`stage-seg-${c.key}`}
                    data-active={on ? "true" : "false"}
                    aria-pressed={on}
                    className={`flex-1 rounded-md border px-0 py-1 text-xs ${
                      on ? "border-primary bg-primary/10 text-foreground" : "border-border bg-muted text-muted-foreground hover:border-primary"
                    }`}
                    onClick={() => actions.onSetStage(card.id, c.key as KanbanStageInput)}
                  >
                    {c.title}
                  </button>
                );
              })}
            </div>
            {basisText ? <p className="text-[11px] text-fg-faint">当前依据：{basisText}</p> : null}
          </section>
          {/* 关联会话区（#20：列表/关联已有/新建会话由 related 注入 RelatedSessionsArea） */}
          <RelatedSessionsArea card={card} {...(related ?? {})} />
          {/* 需求经验区（#33：提取/批次卡/候选审核由 memory 注入 MemoryArea，挂关联会话区之后） */}
          <MemoryArea card={card} memory={memory} sessions={related?.sessions} />
          {/* 需求信息 + 删除 */}
          <section className="mt-auto flex flex-col gap-2">
            <h5 className="text-[11px] tracking-wide text-muted-foreground">需求</h5>
            <p className="text-[11px] text-fg-faint">
              {card.id} · 关联会话 {card.sessions.length}
            </p>
            <button
              type="button"
              data-testid="delete-requirement-button"
              className="self-start rounded-md border border-destructive/50 px-3 py-1 text-xs text-destructive hover:bg-destructive/10"
              onClick={() => setConfirmingDelete(true)}
            >
              删除需求
            </button>
          </section>
        </div>
      </aside>
    </>
  );
}
