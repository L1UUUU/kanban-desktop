// 用途：左侧项目+会话栏 —— 项目 / 结构化会话 / PTY 终端三分组骨架（原型一致项 1；空态占位，会话行与新建入口由 #6/#8 接入）
export function Sidebar() {
  return (
    <aside className="overflow-y-auto border-r border-border bg-card py-2.5">
      <h4 className="px-3.5 pb-0.5 pt-1.5 text-[11px] tracking-wide text-muted-foreground">项目</h4>
      {/* 项目行占位：选中态 bg3（项目注册/切换属 #8） */}
      <div className="flex items-center gap-2 bg-muted px-3.5 py-1.5">
        <span aria-hidden>📁</span>
        <span className="truncate text-[13px]">kanban-desktop</span>
      </div>

      <h4 className="px-3.5 pb-0.5 pt-3 text-[11px] tracking-wide text-muted-foreground">结构化会话</h4>
      {/* 空态占位：真实会话行（CLI 色点/目录徽标/状态徽标）与「＋」新建入口属 #6/#8 */}
      <p className="px-3.5 py-1 text-xs text-fg-faint">暂无会话（新建入口后续工单接入）</p>

      <h4 className="px-3.5 pb-0.5 pt-3 text-[11px] tracking-wide text-muted-foreground">PTY 终端</h4>
      <p className="px-3.5 py-1 text-xs text-fg-faint">暂无终端会话</p>
    </aside>
  );
}
