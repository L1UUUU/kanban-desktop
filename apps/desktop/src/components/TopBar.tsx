// 用途：顶栏 —— 应用名 + 当前项目名徽标 + 右侧设置入口（#61：点击打开设置面板 modal，原 #55 浮层两项日志动作平移进面板「日志」区；原型一致项：bg-card 底、下边框、42px 高）；#63 透传项目列表与取消归档回调（已归档管理区分组/回列表接线）
import { useState } from "react";
import type { ProjectRow, SessionRow } from "@kanban/ipc-schema";
import { SettingsModal } from "./SettingsModal";

export function TopBar({
  currentProject,
  projects = [],
  onSessionRestored,
}: {
  currentProject: ProjectRow | null;
  /** #63：项目列表（设置面板已归档分组头名称数据源） */
  projects?: ProjectRow[];
  /** #63：取消归档成功回调（行回默认列表；AppShell 接 controller.store.registerRestored） */
  onSessionRestored?: (row: SessionRow) => void;
}) {
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
      {settingsOpen ? (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          projects={projects}
          currentProjectId={currentProject?.id ?? null}
          onSessionRestored={onSessionRestored}
        />
      ) : null}
    </header>
  );
}
