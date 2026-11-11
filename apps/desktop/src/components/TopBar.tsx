// 用途：顶栏 —— 应用名 + 当前项目名徽标 + 右侧设置入口（#61：点击打开设置面板 modal，原 #55 浮层两项日志动作平移进面板「日志」区；原型一致项：bg-card 底、下边框、42px 高）
import { useState } from "react";
import type { ProjectRow } from "@kanban/ipc-schema";
import { SettingsModal } from "./SettingsModal";

export function TopBar({ currentProject }: { currentProject: ProjectRow | null }) {
  // #61：设置面板 modal 展开态（spec #57：设置从两项日志动作升级为面板，两项动作保留可用）
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <header className="flex h-[42px] shrink-0 items-center gap-3 border-b border-border bg-card px-3.5">
      <span className="text-[13px] font-bold">Kanban Desktop</span>
      {/* 当前项目名徽标（无项目=注册引导态提示） */}
      <span className="rounded border border-border px-1.5 text-[11px] text-muted-foreground">
        {currentProject ? currentProject.name : "未注册项目"}
      </span>
      <button type="button" className="ml-auto text-xs text-muted-foreground" onClick={() => setSettingsOpen(true)}>
        设置
      </button>
      {settingsOpen ? <SettingsModal onClose={() => setSettingsOpen(false)} /> : null}
    </header>
  );
}
