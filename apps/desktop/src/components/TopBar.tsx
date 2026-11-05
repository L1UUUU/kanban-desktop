// 用途：顶栏 —— 应用名 + 当前项目名徽标 + 右侧设置入口（原型一致项 1：bg2 底、下边框）
import type { ProjectRow } from "@kanban/ipc-schema";

export function TopBar({ currentProject }: { currentProject: ProjectRow | null }) {
  return (
    <header className="flex items-center gap-3 border-b border-border bg-card px-3.5">
      <span className="text-[13px] font-bold">Kanban Desktop</span>
      {/* 当前项目名徽标（无项目=注册引导态提示） */}
      <span className="rounded border border-border px-1.5 text-[11px] text-muted-foreground">
        {currentProject ? currentProject.name : "未注册项目"}
      </span>
      <button type="button" className="ml-auto cursor-default text-xs text-muted-foreground">
        设置
      </button>
    </header>
  );
}
