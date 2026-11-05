// 用途：聊天工作区 —— useChatController + useTerminals + useProjects 接线侧栏与中央区（transport 可注入：生产 window.api，测试 FakeAdapter 直连；活跃会话为 PTY 时中央渲染终端面板）
import type { ReactNode } from "react";
import { Sidebar } from "../../components/Sidebar";
import type { ProjectsController } from "../projects/use-projects";
import type { ChatTransport } from "../../lib/kanban-api";
import { ChatPane } from "./ChatPane";
import { FAKE_DEMO_CWD, useChatController, type ChatController } from "./use-chat";
import { TerminalWorkspace } from "../terminal/TerminalWorkspace";
import { useTerminals } from "../terminal/use-terminals";

export function ChatWorkspace({
  transport,
  projects,
  onController,
  sidebarFooter,
}: {
  transport: ChatTransport | null;
  /** 项目控制器（App 层创建，TopBar 与侧栏共享状态） */
  projects: ProjectsController;
  /** 暴露 controller（测试驱动用；生产不传） */
  onController?: (controller: ChatController) => void;
  sidebarFooter?: ReactNode;
}) {
  const controller = useChatController(transport);
  const terminals = useTerminals(transport, controller);
  if (onController) onController(controller);

  // 项目行「＋」新建：cwd 用项目 canonicalPath（缺省回退演示目录）
  const projectCwd = (projectId: string): string => projects.projects.find((p) => p.id === projectId)?.canonicalPath ?? FAKE_DEMO_CWD;

  // 活跃会话为 PTY 终端时中央渲染终端面板（与结构化聊天区并列切换，spec I）
  const active = controller.activeSession;

  return (
    <div className="grid min-h-0 grid-cols-[240px_1fr]">
      <Sidebar
        projects={projects.projects}
        currentProjectId={projects.currentProjectId}
        sessions={controller.sessions}
        activeId={controller.activeId}
        onSelect={controller.switchTo}
        onSelectProject={(id) => void projects.switchTo(id)}
        onRegisterProject={() => void projects.register()}
        onCreateSession={(projectId, cli) => {
          void controller.createSession(cli, { projectId, cwd: projectCwd(projectId) });
        }}
        onCreatePtySession={(projectId) => {
          void terminals.create({ projectId, cwd: projectCwd(projectId) });
        }}
        onKillTerminal={terminals.kill}
        info={
          <>
            {projects.notice ? <p className="mb-1 text-warn">{projects.notice}</p> : null}
            {sidebarFooter}
          </>
        }
      />
      {active && active.cli === "pty" ? (
        <TerminalWorkspace session={active} manager={terminals.manager} onKill={terminals.kill} />
      ) : (
        <ChatPane
          session={controller.activeSession}
          version={controller.version}
          actions={{
            onSend: controller.send,
            onInterrupt: controller.interrupt,
            onPermChange: controller.setPerm,
            onModelChange: controller.setModel,
            onResolveApproval: controller.resolveApproval,
            onResume: (sessionId) => void controller.resumeSession(sessionId),
          }}
        />
      )}
    </div>
  );
}
