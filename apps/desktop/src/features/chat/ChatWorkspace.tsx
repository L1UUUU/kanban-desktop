// 用途：聊天工作区 —— useChatController + useTerminals + useProjects 接线侧栏与中央区（transport 可注入：生产 window.api，测试 FakeAdapter 直连；活跃会话为 PTY 时中央渲染终端面板；主仓库并行冲突判据驱动提示条；#18 起中央区在聊天/看板视图间切换，本组件常挂 → 会话与 CLI 生命周期与视图切换无关）
import type { ReactNode } from "react";
import type { CliKind, RequirementCardRow } from "@kanban/ipc-schema";
import { Sidebar } from "../../components/Sidebar";
import type { ProjectsController } from "../projects/use-projects";
import type { ChatTransport } from "../../lib/kanban-api";
import { ChatPane } from "./ChatPane";
import { CreateErrorCard } from "./components/CreateErrorCard";
import { detectMainRepoConflict } from "./conflict";
import { resolveSessionCwd, useChatController, type ChatController } from "./use-chat";
import { KanbanWorkspace } from "../kanban/KanbanWorkspace";
import type { KanbanController } from "../kanban/use-kanban";
import { TerminalWorkspace } from "../terminal/TerminalWorkspace";
import { useTerminals } from "../terminal/use-terminals";

export function ChatWorkspace({
  transport,
  projects,
  demoCwd,
  onController,
  sidebarFooter,
  configPath = null,
  view = "chat",
  kanban,
  onOpenRequirement,
  onSetView,
  memory,
  diff,
}: {
  transport: ChatTransport | null;
  /** 项目控制器（App 层创建，TopBar 与侧栏共享状态） */
  projects: ProjectsController;
  /** Fake 演示会话 cwd（App 经 AppInfo 注入：Main 读 KANBAN_FAKE_DEMO_CWD、缺省用户主目录；未取到为 null，boot 演示会话暂缓） */
  demoCwd?: string | null;
  /** 暴露 controller（测试驱动用；生产不传） */
  onController?: (controller: ChatController) => void;
  sidebarFooter?: ReactNode;
  /** #46：配置文件绝对路径（AppInfo 注入；spawn 失败卡「复制配置路径」数据源） */
  configPath?: string | null;
  /** 当前视图（#18：chat=聊天区，kanban=看板；#34 增 memory=记忆视图；#43 增 diff=Diff 视图；组件常挂，切换不卸载会话/终端控制器） */
  view?: "chat" | "kanban" | "memory" | "diff";
  /** 看板控制器（App 层创建常驻；view=kanban 时中央渲染看板） */
  kanban?: KanbanController | null;
  /** 卡片点击挂点（#19 详情滑出面板；本票不接） */
  onOpenRequirement?: (card: RequirementCardRow) => void;
  /** #20：跨视图跳转（面板「跳转」→ 聊天；侧栏 REQ 徽标 → 看板）；App 层 setView 注入 */
  onSetView?(v: "chat" | "kanban"): void;
  /** #34：记忆视图中央区节点（view=memory 时渲染；App 层注入，chat 模块不依赖 memory feature） */
  memory?: ReactNode;
  /** #43：Diff 视图中央区节点（view=diff 时渲染；App 层注入，chat 模块不依赖 diff feature） */
  diff?: ReactNode;
}) {
  const controller = useChatController(transport, demoCwd ?? null);
  const terminals = useTerminals(transport, controller);
  if (onController) onController(controller);

  // 活跃会话为 PTY 终端时中央渲染终端面板（与结构化聊天区并列切换，spec I）
  const active = controller.activeSession;
  // 主仓库并行冲突判据（spec I-4）：当前会话同目录 ≥2 活跃结构化会话 → 聊天区顶部提示条（仅提示不阻止，随快照动态更新）
  const conflictTitles = detectMainRepoConflict(controller.sessions, controller.activeId);

  // #20 卡片建会话：cwd 解析与侧栏「＋」同规则（项目查不到不回退任何路径）
  const createSessionForCard = (cli: CliKind | "pty", card: RequirementCardRow): void => {
    const projectId = card.projectId;
    if (!projectId) {
      projects.setNotice("新建失败：需求未归属项目");
      return;
    }
    const cwd = resolveSessionCwd(projects.projects, projectId, cli, demoCwd ?? null);
    if (!cwd) {
      projects.setNotice("新建失败：项目不存在或已失效，请刷新项目列表后重试");
      return;
    }
    if (cli === "pty") {
      void terminals.create({ projectId, cwd, requirementId: card.id });
      return;
    }
    void controller.createSession(cli, { projectId, cwd, requirementId: card.id });
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr]">
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
        onArchiveSession={(sessionId) => void controller.archiveSession(sessionId)}
        onDeleteSession={(sessionId) => void controller.deleteSession(sessionId)}
        sessionToReq={kanban?.sessionToReq ?? {}}
        onOpenRequirement={(requirementId) => {
          // #20 原型一致项 6：会话行 REQ 徽标点击 → 进入看板并选中该需求（详情面板打开）
          onSetView?.("kanban");
          kanban?.setActive(requirementId);
        }}
        info={
          <>
            {/* #46 会话创建失败卡（session:create 失败无会话视图可挂——创建入口/侧栏反馈，spec #40 F1） */}
            {controller.createFailure ? (
              <CreateErrorCard
                failure={controller.createFailure}
                configPath={configPath}
                onRetry={() => {
                  const f = controller.createFailure;
                  if (!f) return;
                  void controller.createSession(f.cli, {
                    cwd: f.cwd,
                    projectId: f.projectId ?? undefined,
                    title: f.title,
                    requirementId: f.requirementId,
                  });
                }}
                onDismiss={controller.dismissCreateFailure}
              />
            ) : null}
            {projects.notice ? <p className="mb-1 text-warn">{projects.notice}</p> : null}
            {sidebarFooter}
          </>
        }
      />
      {view === "kanban" ? (
        <KanbanWorkspace
          kanban={kanban ?? null}
          projects={projects}
          onOpenRequirement={onOpenRequirement}
          related={{
            sessions: controller.sessions,
            actions: {
              onUnlink: (sessionId) => void kanban?.unlink(sessionId),
              onLinkExisting: (sessionId, requirementId) =>
                kanban ? kanban.link(sessionId, requirementId) : Promise.resolve("看板不可用"),
              onJumpToSession: (sessionId) => {
                // #20：面板会话「跳转」→ 切回聊天视图并选中该会话
                onSetView?.("chat");
                controller.switchTo(sessionId);
              },
              onCreateSession: createSessionForCard,
            },
          }}
        />
      ) : view === "memory" ? (
        // #34：记忆视图中央区（节点由 App 层注入；本组件只负责槽位，控制器常挂不受切换影响）
        memory
      ) : view === "diff" ? (
        // #43：Diff 视图中央区（节点由 App 层注入；读取由视图挂载触发——进入视图自动读取一次）
        diff
      ) : active && active.cli === "pty" ? (
        <TerminalWorkspace session={active} manager={terminals.manager} onKill={terminals.kill} />
      ) : (
        <ChatPane
          session={controller.activeSession}
          version={controller.version}
          conflictTitles={conflictTitles}
          configPath={configPath}
          actions={{
            onSend: controller.send,
            onInterrupt: controller.interrupt,
            onPermChange: controller.setPerm,
            onModelChange: controller.setModel,
            onResolveApproval: controller.resolveApproval,
            onResume: (sessionId) => void controller.resumeSession(sessionId),
            onDismissSkillConflict: controller.dismissSkillConflict,
            onDismissError: (sessionId) => controller.store.clearError(sessionId),
            // 认证失效卡「打开 PTY 终端」：在会话 cwd 新建终端（登录指引命令在终端内运行）
            onOpenPtyTerminal: (sessionId) => {
              const s = controller.store.getSession(sessionId);
              if (!s?.cwd) return;
              void terminals.create({ projectId: s.projectId, cwd: s.cwd });
            },
          }}
        />
      )}
    </div>
  );
}
