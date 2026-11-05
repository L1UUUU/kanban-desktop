// 用途：顶栏 —— 应用名 + 当前项目名徽标 + 右侧设置入口（原型一致项 1：bg2 底、下边框）
export function TopBar() {
  return (
    <header className="flex items-center gap-3 border-b border-border bg-card px-3.5">
      <span className="text-[13px] font-bold">Kanban Desktop</span>
      {/* 当前项目名徽标（项目管理 UI 属 #8，先占位） */}
      <span className="rounded border border-border px-1.5 text-[11px] text-muted-foreground">kanban-desktop</span>
      <button type="button" className="ml-auto cursor-default text-xs text-muted-foreground">
        设置
      </button>
    </header>
  );
}
