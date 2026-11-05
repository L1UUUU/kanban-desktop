// 用途：renderer 根组件 —— 原型变体 A 三区布局：42px 顶栏（当前项目名）+ 退出提示条（生命周期序列 UI 提示，#13）+ 主区（240px 侧栏 + 中央聊天区）；transport 经 preload 桥接（不可用时聊天区降级占位）
import { useEffect, useMemo, useState } from "react";
import type { AppInfo } from "@kanban/ipc-schema";
import { AppInfoLine } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { ChatWorkspace } from "./features/chat/ChatWorkspace";
import { useProjects } from "./features/projects/use-projects";
import { createWindowTransport } from "./lib/kanban-api";

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  // 退出序列第 1 步的 UI 提示（spec H：停止接收新请求 → 主进程推送 app:shutdown）
  const [shutdownNotice, setShutdownNotice] = useState<string | null>(null);
  const transport = useMemo(() => createWindowTransport(), []);
  const projects = useProjects(transport);

  // IPC 冒烟：经 preload 桥接拉取运行信息（window.api 缺失时保持 null 降级）
  useEffect(() => {
    window.api
      ?.getAppInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
    return window.api?.onShutdownNotice((notice) => setShutdownNotice(notice.reason));
  }, []);

  return (
    <div className="grid h-screen grid-rows-[42px_auto_1fr] overflow-hidden bg-background text-foreground">
      <TopBar currentProject={projects.currentProject} />
      {shutdownNotice ? (
        <div data-testid="shutdown-banner" className="flex-none border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-xs text-warn">
          正在退出应用：已停止接收新请求，正在有序结束会话…
        </div>
      ) : null}
      <ChatWorkspace transport={transport} projects={projects} sidebarFooter={<AppInfoLine info={info} />} />
    </div>
  );
}
