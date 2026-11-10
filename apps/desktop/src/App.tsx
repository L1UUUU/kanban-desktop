// 用途：renderer 根组件 —— 原型变体 A 三区布局：42px 顶栏（当前项目名）+ 退出提示条（生命周期序列 UI 提示，#13）+ 残留通知条（#49 确认式清理，全局层、退出条之下）+ 主区（240px 侧栏 + 中央聊天/看板视图切换，#18）；transport 经 preload 桥接（不可用时聊天区降级占位）；AppShell 为可注入骨架（组件测试直挂 Fake transport）
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppInfo, ResidueKillResult, ResidueProcess } from "@kanban/ipc-schema";
import { AppInfoLine } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { ChatWorkspace } from "./features/chat/ChatWorkspace";
import type { ChatController } from "./features/chat/use-chat";
import { KanbanEntryButton } from "./features/kanban/KanbanWorkspace";
import { useKanban } from "./features/kanban/use-kanban";
import { MemoryEntryButton, MemoryWorkspace } from "./features/memory/MemoryWorkspace";
import { createWindowMemoryTransport, type MemoryTransport } from "./features/memory/memory-transport";
import { useMemory } from "./features/memory/use-memory";
import { DiffEntryButton, DiffWorkspace } from "./features/diff/DiffWorkspace";
import { createWindowDiffTransport, type DiffTransport } from "./features/diff/diff-transport";
import { useWorkspaceDiff } from "./features/diff/use-workspace-diff";
import { useProjects } from "./features/projects/use-projects";
import { ResidueBanner } from "./features/residue/ResidueBanner";
import { createWindowTransport, type ChatTransport } from "./lib/kanban-api";

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  // 退出序列第 1 步的 UI 提示（spec H：停止接收新请求 → 主进程推送 app:shutdown）
  const [shutdownNotice, setShutdownNotice] = useState<string | null>(null);
  // #49 残留检测结果（app:event 推送或挂载拉取；null=未检出/未拉取，不渲染）
  const [residue, setResidue] = useState<ResidueProcess[] | null>(null);
  const transport = useMemo(() => createWindowTransport(), []);

  // IPC 冒烟：经 preload 桥接拉取运行信息（window.api 缺失时保持 null 降级）
  useEffect(() => {
    window.api
      ?.getAppInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
    // #49：订阅残留检测一次性通知（app:event 推送）
    const offAppEvent = window.api?.onAppEvent((event) => {
      if (event.type === "residue-detected") setResidue(event.processes);
    });
    // #49：挂载时拉取检测清单（Main 缓存的启动一次性结果；覆盖推送早于订阅的时序，同源幂等）
    void window.api
      ?.invokeResidue({ channel: "residue:detect" })
      .then((r) => {
        if (r.ok && r.processes && r.processes.length > 0) setResidue(r.processes);
      })
      .catch(() => undefined);
    const offShutdown = window.api?.onShutdownNotice((notice) => setShutdownNotice(notice.reason));
    return () => {
      offAppEvent?.();
      offShutdown?.();
    };
  }, []);

  return (
    <AppShell
      transport={transport}
      demoCwd={info?.fakeDemoCwd ?? null}
      configPath={info?.configPath ?? null}
      shutdownNotice={shutdownNotice}
      residue={residue}
      onKillResidue={async (pids) => {
        const r = await window.api!.invokeResidue({ channel: "residue:kill", pids });
        return r.ok && r.results ? r.results : pids.map((pid) => ({ pid, status: "failed", error: "清理请求失败" }) as ResidueKillResult);
      }}
      onDismissResidue={() => setResidue(null)}
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
  configPath = null,
  shutdownNotice = null,
  residue = null,
  onKillResidue,
  onDismissResidue,
  sidebarFooter,
  onChatController,
  memoryTransport = null,
  diffTransport = null,
}: {
  transport: ChatTransport | null;
  demoCwd?: string | null;
  /** #46：配置文件绝对路径（AppInfo 注入；spawn 失败卡「复制配置路径」数据源） */
  configPath?: string | null;
  /** 退出序列提示文案（null=不渲染提示条） */
  shutdownNotice?: string | null;
  /** #49：残留检测结果（null=不渲染通知条） */
  residue?: ResidueProcess[] | null;
  /** #49：确认式清理（默认经 App 注入 window.api.invokeResidue；测试注入 fake） */
  onKillResidue?: (pids: number[]) => Promise<ResidueKillResult[]>;
  /** #49：忽略本次（条消失，下次启动重新检测） */
  onDismissResidue?: () => void;
  /** 侧栏底部附加槽（App 传运行信息行） */
  sidebarFooter?: ReactNode;
  /** 暴露 chat controller（测试驱动用；生产不传） */
  onChatController?: (controller: ChatController) => void;
  /** memory 传输 seam（#34；缺省经 window.api 桥接，测试注入 fake） */
  memoryTransport?: MemoryTransport | null;
  /** diff 传输 seam（#43；缺省经 window.api 桥接，测试注入 fake） */
  diffTransport?: DiffTransport | null;
}) {
  // 视图状态（#18 spec D 节 + #34 记忆视图 + #43 Diff 视图）：chat|kanban|memory|diff，四视图共享侧栏
  const [view, setView] = useState<"chat" | "kanban" | "memory" | "diff">("chat");
  const projects = useProjects(transport);
  const kanban = useKanban(transport);
  // #34：memory transport 缺省走 preload 桥接（window.api 缺失时为 null → 视图降级）；useState 初始化器保证实例稳定
  const [memoryTransport_] = useState(() => memoryTransport ?? createWindowMemoryTransport());
  const memory = useMemory(memoryTransport_, projects.currentProjectId);
  // #43：diff transport 同款缺省桥接；控制器常挂（视图切换不卸载），读取由视图挂载触发
  const [diffTransport_] = useState(() => diffTransport ?? createWindowDiffTransport());
  const diff = useWorkspaceDiff(diffTransport_, projects.currentProjectId);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TopBar currentProject={projects.currentProject} />
      {shutdownNotice ? (
        <div data-testid="shutdown-banner" className="flex-none border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-xs text-warn">
          正在退出应用：已停止接收新请求，正在有序结束会话…
        </div>
      ) : null}
      {/* #49 残留通知条（spec #40 F18 叠加顺序：全局条在上——退出条最上、残留条其下；会话级条（冲突/同名 skill/恢复）在 ChatWorkspace 内、物理位于其下） */}
      {residue && residue.length > 0 && onKillResidue && onDismissResidue ? (
        <ResidueBanner processes={residue} onKill={onKillResidue} onDismiss={onDismissResidue} />
      ) : null}
      <ChatWorkspace
        transport={transport}
        projects={projects}
        demoCwd={demoCwd}
        configPath={configPath}
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
        diff={<DiffWorkspace controller={diff} />}
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
            {/* 侧栏底部「Diff」入口（#43 第四态，原型 d1 一致项 5）：无当前项目禁用（US7/F9） */}
            <DiffEntryButton
              active={view === "diff"}
              disabled={projects.currentProjectId == null}
              projectName={projects.currentProject?.name ?? null}
              onToggle={() => setView((v) => (v === "diff" ? "chat" : "diff"))}
            />
            {sidebarFooter}
          </>
        }
      />
    </div>
  );
}
