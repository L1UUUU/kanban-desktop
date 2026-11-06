// 用途：详情面板「关联会话」区挂点（#19 占位、#20 填充）—— #20 在本组件内渲染：关联会话列表（CLI 色点 + 状态徽标 + 跳转 + 解除）、「＋新建会话」四 CLI 菜单（PTY 项标注「无 skill 信号」）、关联已有会话选择器（仅当前项目未关联会话）；挂点 data-testid="detail-sessions" 保持稳定，#20 只改本文件主体不动 DetailPanel
import type { RequirementCardRow } from "@kanban/ipc-schema";

export interface RelatedSessionsAreaProps {
  /** 当前需求行（sessions = 已关联会话 id 列表；标题随面板实时更新） */
  card: RequirementCardRow;
}

/** #19 占位实现：仅渲染区块骨架与关联计数（原型一致项 4 的「关联会话」段落位置与标题形态） */
export function RelatedSessionsArea({ card }: RelatedSessionsAreaProps) {
  return (
    <section data-testid="detail-sessions" className="flex flex-col gap-2">
      <h5 className="text-[11px] tracking-wide text-muted-foreground">关联会话（{card.sessions.length}）</h5>
      <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-fg-faint">
        关联会话列表、关联已有会话与「＋新建会话」即将提供
      </p>
    </section>
  );
}
