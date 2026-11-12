// 用途：需求卡片（#18）—— 标题/关联会话数/阶段依据行/uncertain「待确认」黄徽标/verified 绿徽标（原型一致项 3）；点击开详情面板（#19），选中卡高亮；#84 起悬浮编辑按钮 + 行内重命名（Enter/blur 提交、Esc 还原、失败回滚 + 行内提示）
import { useEffect, useRef, useState } from "react";
import type { RequirementCardRow } from "@kanban/ipc-schema";
import { formatStageBasis } from "./columns";

export function RequirementCard({
  card,
  onOpen,
  onRename,
  onStartEdit,
  onEndEdit,
  editing = false,
  active = false,
}: {
  card: RequirementCardRow;
  onOpen?: (card: RequirementCardRow) => void;
  /** 行内重命名提交（#84：与详情面板同一控制器动作 → kanban:rename 事件流）；返回 null=成功、错误文案=失败（标题回滚 + 行内提示） */
  onRename?: (requirementId: string, title: string) => Promise<string | null>;
  /** 进入行内编辑（悬浮编辑按钮点击；建卡即命名由父层 editing 驱动） */
  onStartEdit?: () => void;
  /** 退出行内编辑（提交/还原后由父层清编辑态） */
  onEndEdit?: () => void;
  /** 行内编辑态（#84：建卡即命名——create 透传新需求 id 后置位） */
  editing?: boolean;
  /** 详情面板选中态（原型 .card.on：主色描边） */
  active?: boolean;
}) {
  const basis = formatStageBasis(card.stageBasis);
  // verified 徽标判据：当前阶段依据为 skill 信号且证据等级 verified（uncertain 由 tracker 独立维护）
  const verified = card.stageBasis?.kind === "skill" && card.stageBasis.evidenceLevel === "verified";

  // 行内标题草稿：进入编辑的上升沿同步草稿与清错误（渲染期调整态模式，与 DetailPanel 同款）
  const [draft, setDraft] = useState(card.title);
  const [editingSeen, setEditingSeen] = useState(editing);
  const [renameError, setRenameError] = useState<string | null>(null);
  // 一次编辑会话只提交/还原一次（Enter 直接提交后残余 blur、unmount 前 blur 不再重复发 kanban:rename）；
  // 哨兵在 editing 上升沿的 effect 中重置（React 保证 passive effects 先于下一离散事件处理，渲染期不写 ref）
  const settledRef = useRef(false);
  useEffect(() => {
    if (editing) settledRef.current = false;
  }, [editing]);
  if (editingSeen !== editing) {
    setEditingSeen(editing);
    if (editing) {
      setDraft(card.title);
      setRenameError(null);
    }
  }

  /** 提交行内重命名（Enter/blur）：空白/未变不落（直接退出），否则 onRename——失败标题保持原值（store 未变）+ 行内错误提示 */
  const commitRename = (): void => {
    if (settledRef.current) return;
    settledRef.current = true;
    const next = draft.trim();
    if (!next || next === card.title || !onRename) {
      onEndEdit?.();
      return;
    }
    void onRename(card.id, next).then((err) => {
      if (err) setRenameError(err);
      onEndEdit?.();
    });
  };

  /** Esc 还原：放弃草稿直接退出编辑（不经 blur 提交，避免草稿被当作提交内容） */
  const cancelEdit = (): void => {
    if (settledRef.current) return;
    settledRef.current = true;
    setDraft(card.title);
    onEndEdit?.();
  };

  return (
    <div
      data-testid="requirement-card"
      data-active={active ? "true" : "false"}
      className={`group relative rounded-lg border bg-muted px-2.5 py-2 text-left hover:border-primary ${
        active ? "border-primary ring-1 ring-primary" : "border-border"
      }`}
    >
      {editing ? (
        <input
          data-testid="card-title-input"
          aria-label="卡片标题"
          title="重命名需求（Enter 提交，Esc 还原）"
          autoFocus
          // 聚焦全选：建卡即命名时输入即覆盖缺省标题「待命名需求」
          onFocus={(e) => e.target.select()}
          className="w-full rounded-md border border-border bg-background px-1.5 py-0.5 text-[13px] text-foreground outline-none focus:border-primary"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") cancelEdit();
          }}
        />
      ) : (
        <button
          type="button"
          className="w-full text-left"
          title={`${card.id}${onOpen ? "（点击查看详情）" : ""}`}
          onClick={() => onOpen?.(card)}
        >
          <p className="pr-6 text-[13px]">{card.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-fg-faint">
            <span>◍ {card.sessions.length} 会话</span>
            {card.uncertain ? (
              <span data-testid="uncertain-badge" title="self_reported/simulated 信号驱动，待确认" className="rounded-full border border-warn/55 bg-warn/10 px-1.5 text-warn">
                待确认
              </span>
            ) : null}
            {verified ? <span data-testid="verified-badge" className="rounded-full border border-ok/50 px-1.5 text-ok">verified</span> : null}
          </div>
          {basis ? <p className="mt-0.5 truncate text-[11px] text-fg-faint">{basis}</p> : null}
        </button>
      )}
      {onRename && onStartEdit && !editing ? (
        // 悬浮编辑按钮（#84）：悬浮卡片出现（Sidebar 同款 opacity-0 + group-hover 模式）
        <button
          type="button"
          data-testid="card-edit-button"
          aria-label="重命名需求"
          title="重命名需求"
          className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-md border border-border bg-card text-[11px] text-fg-faint opacity-0 transition-opacity hover:border-primary hover:text-primary group-hover:opacity-100"
          onClick={() => onStartEdit()}
        >
          ✎
        </button>
      ) : null}
      {renameError && !editing ? (
        // 重命名失败行内提示（#84：不再静默；再次进入编辑时清除）
        <p data-testid="card-rename-error" className="mt-1 text-[11px] text-destructive">
          {renameError}
        </p>
      ) : null}
    </div>
  );
}
