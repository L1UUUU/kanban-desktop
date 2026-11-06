// 用途：看板工作区（#18）—— 五列看板（列头计数、按当前项目过滤、未开始列「＋」手动建卡）+ 无项目空板引导文案；#19 起点击卡片开右侧详情滑出面板（activeRequirementId 驱动，原型一致项 1/2/3/4/5）；#20 起详情面板关联区由 related 注入（关联列表/关联已有/跳转/建会话）
import type { RequirementCardRow } from "@kanban/ipc-schema";
import type { ProjectsController } from "../projects/use-projects";
import { KANBAN_COLUMNS, stageToColumn } from "./columns";
import { DetailPanel } from "./DetailPanel";
import type { RelatedSessionsAreaProps } from "./RelatedSessionsArea";
import { RequirementCard } from "./RequirementCard";
import type { KanbanController } from "./use-kanban";

export function KanbanWorkspace({
  kanban,
  projects,
  onOpenRequirement,
  related,
}: {
  kanban: KanbanController | null;
  /** 项目控制器（App 层创建；看板按当前项目过滤，S2-08） */
  projects: ProjectsController;
  /** 卡片点击挂点（缺省 setActive 开详情面板；#20 跳转复用覆盖） */
  onOpenRequirement?: (card: RequirementCardRow) => void;
  /** #20：详情面板关联区数据与动作（缺省时关联区保持占位）；sessionToReq 由 kanban 控制器提供故不在此列 */
  related?: Omit<RelatedSessionsAreaProps, "card" | "sessionToReq">;
}) {
  const currentProjectId = projects.currentProjectId;
  // 按当前项目过滤后分列（stage=null → 未开始列）
  const cards = (kanban?.requirements ?? []).filter((r) => currentProjectId !== null && r.projectId === currentProjectId);
  const columns: RequirementCardRow[][] = KANBAN_COLUMNS.map(() => []);
  for (const card of cards) columns[stageToColumn(card.stage)].push(card);
  // 详情面板数据源：activeRequirementId 对应卡（行随 tracker 推送实时更新；删除/消失即卸载面板）
  const activeCard = kanban?.requirements.find((r) => r.id === kanban.activeRequirementId) ?? null;
  const openCard = onOpenRequirement ?? ((card: RequirementCardRow) => kanban?.setActive(card.id));

  return (
    <section data-testid="kanban-board" className="relative flex min-h-0 min-w-0 flex-col bg-background">
      {currentProjectId === null ? (
        // 无项目上下文空板引导（S2-18：未挂项目不建卡不可关联，看板为空板 + 引导文案）
        <p data-testid="kanban-empty-guide" className="flex-none border-b border-border px-6 py-2 text-xs text-muted-foreground">
          选择或注册项目后查看其需求
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 gap-2.5 overflow-x-auto p-4">
        {KANBAN_COLUMNS.map((col, ix) => (
          <div
            key={col.key}
            data-testid={`kanban-col-${col.key}`}
            className="flex min-h-0 min-w-[170px] flex-1 flex-col rounded-[10px] border border-border bg-card"
          >
            <div className="flex flex-none items-center gap-1.5 border-b border-border px-2.5 py-2 text-xs text-muted-foreground">
              <span className={`h-2 w-2 flex-none rounded-[3px] ${col.dot}`} aria-hidden />
              <span>{col.title}</span>
              <span data-testid="kanban-col-count" className="text-[11px] text-fg-faint">
                {columns[ix].length}
              </span>
              {col.key === "none" && currentProjectId !== null ? (
                // 未开始列「＋」手动建卡（S2-09；归属当前项目，标题缺省「待命名需求」）
                <button
                  type="button"
                  title="手动新建需求（归属当前项目）"
                  className="ml-auto flex h-5 w-5 items-center justify-center rounded text-fg-faint hover:text-primary"
                  onClick={() => void kanban?.create(currentProjectId)}
                >
                  ＋
                </button>
              ) : null}
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
              {columns[ix].map((card) => (
                <RequirementCard key={card.id} card={card} onOpen={openCard} active={activeCard?.id === card.id} />
              ))}
            </div>
          </div>
        ))}
      </div>
      {activeCard && kanban ? (
        <DetailPanel
          card={activeCard}
          actions={{
            onRename: (id, title) => void kanban.rename(id, title),
            onSetStage: (id, stage) => void kanban.setStage(id, stage),
            onDelete: (id) => void kanban.removeRequirement(id),
            onClose: () => kanban.setActive(null),
          }}
          related={{ ...related, sessionToReq: kanban.sessionToReq }}
        />
      ) : null}
    </section>
  );
}

/** 侧栏底部「看板」入口按钮（原型一致项 1）：▤ 看板 + 当前项目指示（active=看板视图态；点击在聊天/看板间切换） */
export function KanbanEntryButton({
  active,
  projectName,
  onToggle,
}: {
  active: boolean;
  projectName: string | null;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      data-testid="kanban-entry"
      title="进入当前项目的需求看板"
      className={`mb-1 flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[13px] ${
        active ? "border-primary bg-primary/10 text-accent2" : "border-transparent text-muted-foreground hover:border-border hover:bg-muted"
      }`}
      onClick={onToggle}
    >
      <span aria-hidden>▤</span>
      <span>看板</span>
      <span className="ml-auto truncate text-[11px] text-fg-faint">{projectName ?? "当前项目"} →</span>
    </button>
  );
}
