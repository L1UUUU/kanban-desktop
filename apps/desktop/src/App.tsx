// 用途：renderer 根组件 —— 原型变体 A 三区布局骨架：42px 顶栏 + 主区（240px 侧栏 + 中央聊天区）
import { useEffect, useState } from "react";
import type { AppInfo } from "@kanban/ipc-schema";
import { ChatPane } from "./components/ChatPane";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);

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
      <div className="grid min-h-0 grid-cols-[240px_1fr]">
        <Sidebar />
        <ChatPane info={info} />
      </div>
    </div>
  );
}
