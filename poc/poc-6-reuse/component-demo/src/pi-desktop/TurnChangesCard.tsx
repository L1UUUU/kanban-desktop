// 改造版抽离自 PI-Desktop apps/desktop/src/features/chat/transcript/TurnChangesCard.tsx
// （commit 983f840，LGPL-3.0，上游 144 行）。本文件用于 PoC 6 独立编译实测。
// JSX 结构与 summarization 逻辑保持原样；仅替换宿主耦合点。改造清单：
//  1. react-i18next useTranslation → 本地 t() 中文字典（上游 locales/*.json 的子集）
//  2. zustand useAppStore（openWorkPanelTabForSession/openWorkPanelTab）
//     + requestReviewFocus + toolWorkPanelTab → props 回调 onOpenReview(snapshotIds, expand)
//  3. useSlotSessionId（plugin renderer-slots）→ 删除，sessionId 不参与 demo
//  4. useAutomaticDisclosure/disclosureKey（244 行 disclosure.tsx，跨消息保留折叠状态）
//     → 本地 useState 折叠（语义降级：折叠选择不跨卸载保留）
//  5. ui.tsx Button/cx（855 行）→ 本地最小实现；icons.tsx lucide 图标 → 本地 SVG
//  6. reviewFilePathLabel 从上游 lib/review-history.ts 原样并入 ./workspace-review.ts
// 其余（summarizeTurnChanges、TURN_CHANGES_* 常量、ReviewFileIcon、turn-changes.css）零改动。

import { memo, useId, useMemo, useState } from "react";
import type { UiMessage } from "./types";
import { IconChevronDown, IconChevronRight } from "./icons";
import { Button, cx } from "./ui";
import { ReviewFileIcon } from "./review-file-icon";
import { reviewFilePathLabel } from "./workspace-review";
import {
  summarizeTurnChanges,
  TURN_CHANGES_RELAXED_LIMIT,
  TURN_CHANGES_VISIBLE_LIMIT,
  type TurnChangedFile,
} from "./turn-changed-files";
import "./turn-changes.css";

// 上游 i18n key（chat.* / panel.review.*）的中文等价物，取自 demo 需要的子集。
const STRINGS = {
  turnChangesTitle: "本轮更改",
  toolChipFiles: (count: number) => `${count} 个文件`,
  turnChangesDirs: (count: number) => `${count} 个目录`,
  rolledBack: "已回滚",
  statusLabel: { added: "新增", modified: "修改", deleted: "删除" } as const,
  turnChangesMore: (count: number) => `还有 ${count} 个文件`,
  turnChangesViewAll: (count: number) => `查看全部 ${count} 个`,
  turnChangesOpen: (file: TurnChangedFile) =>
    `${STRINGS.statusLabel[file.status]} ${file.path}，+${file.additions} -${file.deletions}`,
};

export type TurnChangesCardProps = {
  tools: readonly UiMessage[];
  /** 替换上游 openReview 的 work-panel 联动：宿主决定打开哪个 Diff 视图。 */
  onOpenReview?: (snapshotIds: readonly string[], expand: boolean) => void;
};

/** The read-only "what did this turn change" summary under a completed reply. */
export const TurnChangesCard = memo(function TurnChangesCard({
  tools,
  onOpenReview,
}: TurnChangesCardProps) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => summarizeTurnChanges(tools), [tools]);
  const bodyId = useId();
  const { files } = summary;
  if (files.length === 0) return null;

  const dense = files.length > TURN_CHANGES_RELAXED_LIMIT;
  const visible = files.slice(0, TURN_CHANGES_VISIBLE_LIMIT);
  const hidden = files.length - visible.length;

  const openReview = (snapshotIds: readonly string[], expand: boolean) => {
    onOpenReview?.(snapshotIds, expand);
  };

  const rowLabel = (file: TurnChangedFile) => {
    const label = STRINGS.turnChangesOpen(file);
    return file.rolledBack ? `${label} · ${STRINGS.rolledBack}` : label;
  };

  return (
    <section className="turn-changes-card" aria-label={STRINGS.turnChangesTitle}>
      <Button
        type="button"
        variant="ghost"
        className="turn-changes-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="turn-changes-chevron" aria-hidden>
          {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </span>
        <span className="turn-changes-title">{STRINGS.turnChangesTitle}</span>
        <span className="turn-changes-meta">
          {STRINGS.toolChipFiles(files.length)}
          {dense ? ` · ${STRINGS.turnChangesDirs(summary.directoryCount)}` : null}
        </span>
        <span className="turn-changes-total">
          <Counts additions={summary.additions} deletions={summary.deletions} />
        </span>
      </Button>
      <div id={bodyId} hidden={!open}>
        <ul className={cx("turn-changes-body", dense && "is-dense")}>
          {visible.map((file) => {
            const label = rowLabel(file);
            return (
              <li key={file.path}>
                <button
                  type="button"
                  className="turn-changes-row"
                  data-status={file.status}
                  data-rolled-back={file.rolledBack || undefined}
                  aria-label={label}
                  title={label}
                  onClick={() => openReview(file.snapshotIds, true)}
                >
                  <ReviewFileIcon path={file.path} />
                  <span className="turn-changes-path" data-outside-path={reviewFilePathLabel(file.path) !== file.path || undefined}>{reviewFilePathLabel(file.path)}</span>
                  <Counts additions={file.additions} deletions={file.deletions} />
                </button>
              </li>
            );
          })}
          {hidden > 0 ? (
            <li className="turn-changes-more">
              <span aria-hidden>···</span>
              {STRINGS.turnChangesMore(hidden)}
            </li>
          ) : null}
        </ul>
        {hidden > 0 ? (
          <div className="turn-changes-foot">
            <button
              type="button"
              className="turn-changes-view-all"
              onClick={() => openReview(files.flatMap((file) => file.snapshotIds), false)}
            >
              {STRINGS.turnChangesViewAll(files.length)}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
});

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="turn-changes-counts diff-counts" aria-hidden>
      {additions > 0 && <span className="diff-count-add">+{additions}</span>}
      {deletions > 0 && <span className="diff-count-del">−{deletions}</span>}
    </span>
  );
}
