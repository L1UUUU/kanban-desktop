// 用途：renderer 根组件 —— 原型变体 A 三区布局：42px 顶栏 + 主区（240px 侧栏 + 中央聊天区）；transport 经 preload 桥接（不可用时聊天区降级占位）
import { useEffect, useMemo, useState } from "react";
import type { AppInfo } from "@kanban/ipc-schema";
import { AppInfoLine } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { ChatWorkspace } from "./features/chat/ChatWorkspace";
import { createWindowTransport } from "./lib/kanban-api";

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const transport = useMemo(() => createWindowTransport(), []);

  // IPC 冒烟：经 preload 桥接拉取运行信息（window.api 缺失时保持 null 降级）
  useEffect(() => {
    window.api
      ?.getAppInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  return (
    <div className="grid h-screen grid-rows-[42px_1fr] overflow-hidden bg-background text-foreground">
      <TopBar />
      <ChatWorkspace transport={transport} sidebarFooter={<AppInfoLine info={info} />} />
    </div>
  );
}
