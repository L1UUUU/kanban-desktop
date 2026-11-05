// 用途：聊天工作区 —— useChatController + useProjects 接线侧栏与聊天区（transport 可注入：生产 window.api，测试 FakeAdapter 直连）
import type { ReactNode } from "react";
import { Sidebar } from "../../components/Sidebar";
import type { ProjectsController } from "../projects/use-projects";
import type { ChatTransport } from "../../lib/kanban-api";
import { ChatPane } from "./ChatPane";
import { FAKE_DEMO_CWD, useChatController, type ChatController } from "./use-chat";

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
  if (onController) onController(controller);

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
          // 新建会话挂该行项目：cwd 用项目 canonicalPath（缺省回退演示目录）
          const proj = projects.projects.find((p) => p.id === projectId);
          void controller.createSession(cli, { projectId, cwd: proj?.canonicalPath ?? FAKE_DEMO_CWD });
        }}
        info={
          <>
            {projects.notice ? <p className="mb-1 text-warn">{projects.notice}</p> : null}
            {sidebarFooter}
          </>
        }
      />
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
    </div>
  );
}
