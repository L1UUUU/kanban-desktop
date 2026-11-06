// 用途：renderer 根组件 —— 原型变体 A 三区布局：42px 顶栏（当前项目名）+ 退出提示条（生命周期序列 UI 提示，#13）+ 主区（240px 侧栏 + 中央聊天/看板视图切换，#18）；transport 经 preload 桥接（不可用时聊天区降级占位）；AppShell 为可注入骨架（组件测试直挂 Fake transport）
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppInfo } from "@kanban/ipc-schema";
import { AppInfoLine } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { ChatWorkspace } from "./features/chat/ChatWorkspace";
import type { ChatController } from "./features/chat/use-chat";
import { KanbanEntryButton } from "./features/kanban/KanbanWorkspace";
import { useKanban } from "./features/kanban/use-kanban";
import { MemoryEntryButton, MemoryWorkspace } from "./features/memory/MemoryWorkspace";
import { createWindowMemoryTransport, type MemoryTransport } from "./features/memory/memory-transport";
import { useMemory } from "./features/memory/use-memory";
import { useProjects } from "./features/projects/use-projects";
import { createWindowTransport, type ChatTransport } from "./lib/kanban-api";

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  // 退出序列第 1 步的 UI 提示（spec H：停止接收新请求 → 主进程推送 app:shutdown）
  const [shutdownNotice, setShutdownNotice] = useState<string | null>(null);
  const transport = useMemo(() => createWindowTransport(), []);

  // IPC 冒烟：经 preload 桥接拉取运行信息（window.api 缺失时保持 null 降级）
  useEffect(() => {
    window.api
      ?.getAppInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
    return window.api?.onShutdownNotice((notice) => setShutdownNotice(notice.reason));
  }, []);

  return (
    <AppShell
      transport={transport}
      demoCwd={info?.fakeDemoCwd ?? null}
      shutdownNotice={shutdownNotice}
      sidebarFooter={<AppInfoLine info={info} />}
    />
  );
}

/**
 * 应用骨架（App 的可注入部分，#18）：项目 + 看板/记忆控制器与视图状态在此常驻 —— 视图切换只换中央区
 * （ChatWorkspace 常挂不卸载；#34 起 chat|kanban|memory 三态），CLI 会话/终端生命周期与视图无关（spec D/G 节）
 */
export function AppShell({
  transport,
  demoCwd,
  shutdownNotice = null,
  sidebarFooter,
  onChatController,
  memoryTransport = null,
}: {
  transport: ChatTransport | null;
  demoCwd?: string | null;
  /** 退出序列提示文案（null=不渲染提示条） */
  shutdownNotice?: string | null;
  /** 侧栏底部附加槽（App 传运行信息行） */
  sidebarFooter?: ReactNode;
  /** 暴露 chat controller（测试驱动用；生产不传） */
  onChatController?: (controller: ChatController) => void;
  /** memory 传输 seam（#34；缺省经 window.api 桥接，测试注入 fake） */
  memoryTransport?: MemoryTransport | null;
}) {
  // 视图状态（#18 spec D 节 + #34 记忆视图）：chat|kanban|memory，三视图共享侧栏
  const [view, setView] = useState<"chat" | "kanban" | "memory">("chat");
  const projects = useProjects(transport);
  const kanban = useKanban(transport);
  // #34：memory transport 缺省走 preload 桥接（window.api 缺失时为 null → 视图降级）；useState 初始化器保证实例稳定
  const [memoryTransport_] = useState(() => memoryTransport ?? createWindowMemoryTransport());
  const memory = useMemory(memoryTransport_, projects.currentProjectId);

  return (
    <div className="grid h-screen grid-rows-[42px_auto_1fr] overflow-hidden bg-background text-foreground">
      <TopBar currentProject={projects.currentProject} />
      {shutdownNotice ? (
        <div data-testid="shutdown-banner" className="flex-none border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-xs text-warn">
          正在退出应用：已停止接收新请求，正在有序结束会话…
        </div>
      ) : null}
      <ChatWorkspace
        transport={transport}
        projects={projects}
        demoCwd={demoCwd}
        onController={onChatController}
        view={view}
        kanban={kanban}
        onSetView={setView}
        memory={
          memoryTransport_ ? (
            <MemoryWorkspace memory={memory} projectName={projects.currentProject?.name ?? null} />
          ) : (
            // 记忆服务不可用降级（window.api 未暴露，与聊天区降级同口径）
            <section data-testid="memory-unavailable" className="flex items-center justify-center bg-background p-6 text-xs text-fg-faint">
              记忆服务不可用（window.api 未暴露）
            </section>
          )
        }
        sidebarFooter={
          <>
            {/* 侧栏底部「看板」入口（原型一致项 1）：带当前项目指示，点击在看板/其余视图间切换 */}
            <KanbanEntryButton
              active={view === "kanban"}
              projectName={projects.currentProject?.name ?? null}
              onToggle={() => setView((v) => (v === "kanban" ? "chat" : "kanban"))}
            />
            {/* 侧栏底部「记忆」入口（#34 原型一致项 1）：看板入口之侧，点击在记忆/其余视图间切换 */}
            <MemoryEntryButton
              active={view === "memory"}
              projectName={projects.currentProject?.name ?? null}
              onToggle={() => setView((v) => (v === "memory" ? "chat" : "memory"))}
            />
            {sidebarFooter}
          </>
        }
      />
    </div>
  );
}
