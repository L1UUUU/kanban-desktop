// 用途：聊天工作区 —— useChatController + useTerminals + useProjects 接线侧栏与中央区（transport 可注入：生产 window.api，测试 FakeAdapter 直连；活跃会话为 PTY 时中央渲染终端面板；主仓库并行冲突判据驱动提示条）
import type { ReactNode } from "react";
import { Sidebar } from "../../components/Sidebar";
import type { ProjectsController } from "../projects/use-projects";
import type { ChatTransport } from "../../lib/kanban-api";
import { ChatPane } from "./ChatPane";
import { detectMainRepoConflict } from "./conflict";
import { resolveSessionCwd, useChatController, type ChatController } from "./use-chat";
import { TerminalWorkspace } from "../terminal/TerminalWorkspace";
import { useTerminals } from "../terminal/use-terminals";

export function ChatWorkspace({
  transport,
  projects,
  demoCwd,
  onController,
  sidebarFooter,
}: {
  transport: ChatTransport | null;
  /** 项目控制器（App 层创建，TopBar 与侧栏共享状态） */
  projects: ProjectsController;
  /** Fake 演示会话 cwd（App 经 AppInfo 注入：Main 读 KANBAN_FAKE_DEMO_CWD、缺省用户主目录；未取到为 null，boot 演示会话暂缓） */
  demoCwd?: string | null;
  /** 暴露 controller（测试驱动用；生产不传） */
  onController?: (controller: ChatController) => void;
  sidebarFooter?: ReactNode;
}) {
  const controller = useChatController(transport, demoCwd ?? null);
  const terminals = useTerminals(transport, controller);
  if (onController) onController(controller);

  // 活跃会话为 PTY 终端时中央渲染终端面板（与结构化聊天区并列切换，spec I）
  const active = controller.activeSession;
  // 主仓库并行冲突判据（spec I-4）：当前会话同目录 ≥2 活跃结构化会话 → 聊天区顶部提示条（仅提示不阻止，随快照动态更新）
  const conflictTitles = detectMainRepoConflict(controller.sessions, controller.activeId);

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
          // cwd 用项目 canonicalPath；项目查不到不回退任何路径——真实 CLI 拒绝新建并提示，Fake 回落注入的演示 cwd
          const cwd = resolveSessionCwd(projects.projects, projectId, cli, demoCwd ?? null);
          if (!cwd) {
            projects.setNotice("新建失败：项目不存在或已失效，请刷新项目列表后重试");
            return;
          }
          void controller.createSession(cli, { projectId, cwd });
        }}
        onCreatePtySession={(projectId) => {
          const cwd = resolveSessionCwd(projects.projects, projectId, "pty", demoCwd ?? null);
          if (!cwd) {
            projects.setNotice("新建失败：项目不存在或已失效，请刷新项目列表后重试");
            return;
          }
          void terminals.create({ projectId, cwd });
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
          conflictTitles={conflictTitles}
          actions={{
            onSend: controller.send,
            onInterrupt: controller.interrupt,
            onPermChange: controller.setPerm,
            onModelChange: controller.setModel,
            onResolveApproval: controller.resolveApproval,
            onResume: (sessionId) => void controller.resumeSession(sessionId),
            onDismissSkillConflict: controller.dismissSkillConflict,
          }}
        />
      )}
    </div>
  );
}
