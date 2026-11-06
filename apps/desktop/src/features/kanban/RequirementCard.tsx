// 用途：需求卡片（#18）—— 标题/关联会话数/阶段依据行/uncertain「待确认」黄徽标/verified 绿徽标（原型一致项 3）；点击开详情面板（#19），选中卡高亮
import type { RequirementCardRow } from "@kanban/ipc-schema";
import { formatStageBasis } from "./columns";

export function RequirementCard({
  card,
  onOpen,
  active = false,
}: {
  card: RequirementCardRow;
  onOpen?: (card: RequirementCardRow) => void;
  /** 详情面板选中态（原型 .card.on：主色描边） */
  active?: boolean;
}) {
  const basis = formatStageBasis(card.stageBasis);
  // verified 徽标判据：当前阶段依据为 skill 信号且证据等级 verified（uncertain 由 tracker 独立维护）
  const verified = card.stageBasis?.kind === "skill" && card.stageBasis.evidenceLevel === "verified";
  return (
    <button
      type="button"
      data-testid="requirement-card"
      data-active={active ? "true" : "false"}
      title={`${card.id}${onOpen ? "（点击查看详情）" : ""}`}
      className={`cursor-pointer rounded-lg border bg-muted px-2.5 py-2 text-left hover:border-primary ${
        active ? "border-primary ring-1 ring-primary" : "border-border"
      }`}
      onClick={() => onOpen?.(card)}
    >
      <p className="pr-1 text-[13px]">{card.title}</p>
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
  );
}
