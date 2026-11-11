// 用途：聊天工作区 —— useChatController + useTerminals + useProjects 接线侧栏与中央区（transport 可注入：生产 window.api，测试 FakeAdapter 直连；活跃会话为 PTY 时中央渲染终端面板；#59/#60 起「＋」/卡片建会话只开草稿（结构化首条消息、PTY 首输入才创建）；#18 起中央区在聊天/看板视图间切换，本组件常挂 → 会话与 CLI 生命周期与视图切换无关）
import { useEffect, type ReactNode } from "react";
import type { CliKind, RequirementCardRow, TerminalCommand } from "@kanban/ipc-schema";
import { Sidebar } from "../../components/Sidebar";
import type { ProjectsController } from "../projects/use-projects";
import type { ChatTransport } from "../../lib/kanban-api";
import { ChatPane } from "./ChatPane";
import { DraftPane } from "./components/DraftPane";
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
  /** Fake 演示草稿 cwd（App 经 AppInfo 注入：Main 读 KANBAN_FAKE_DEMO_CWD、缺省用户主目录；未取到为 null，boot 演示草稿暂缓） */
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

  // #59：切项目丢弃草稿（不弹确认、输入不保留；store 引用稳定，仅项目 id 变化触发）
  const currentProjectId = projects.currentProjectId;
  useEffect(() => {
    controller.store.discardDraft();
  }, [currentProjectId, controller.store]);

  // 活跃会话为 PTY 终端时中央渲染终端面板（与结构化聊天区并列切换，spec I）
  const active = controller.activeSession;
  // 主仓库并行冲突判据（spec I-4）：当前会话同目录 ≥2 活跃结构化会话 → 聊天区顶部提示条（仅提示不阻止，随快照动态更新）
  const conflictTitles = detectMainRepoConflict(controller.sessions, controller.activeId);

  // #20/#59 卡片建会话：改为打开草稿（cwd 解析与侧栏「＋」同规则；需求关联随首条消息落到新会话）
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
      // #60：卡片建终端走草稿（requirementId 随首输入触发的创建落关联）
      openPtyDraft({ projectId, cwd, requirementId: card.id });
      return;
    }
    // 结构化会话（#59）：打开草稿并切回聊天视图（草稿在中央区；需求关联随首条消息落到新会话）；
    // 切换焦点丢弃 PTY 草稿（全局单草稿，#60）
    terminals.discardDraft();
    controller.openDraft(cli, { projectId, cwd, requirementId: card.id });
    onSetView?.("chat");
  };

  // #60：打开 PTY 终端草稿并切回聊天视图（草稿须可见可交互——首输入才能触发创建；从看板/记忆等视图发起时带回）
  const openPtyDraft = (opts: { projectId: string | null; cwd: string; command?: TerminalCommand; requirementId?: string }): void => {
    onSetView?.("chat");
    terminals.openDraft(opts);
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr]">
      <Sidebar
        projects={projects.projects}
        currentProjectId={projects.currentProjectId}
        sessions={controller.sessions}
        activeId={controller.activeId}
        onSelect={(sessionId) => {
          // #60：切换会话 = 离开草稿（未发送的草稿静默丢弃，不弹确认）
          terminals.discardDraft();
          controller.switchTo(sessionId);
        }}
        onSelectProject={(id) => {
          terminals.discardDraft(); // #60：切换项目同样丢弃草稿
          void projects.switchTo(id);
        }}
        onRegisterProject={() => void projects.register()}
        onCreateSession={(projectId, cli) => {
          // #59：点「＋」只打开草稿（不 invoke、不落库、侧栏无新行）；cwd 用项目 canonicalPath，
          // 项目查不到不回退任何路径——真实 CLI 拒绝并提示，Fake 回落注入的演示 cwd
          const cwd = resolveSessionCwd(projects.projects, projectId, cli, demoCwd ?? null);
          if (!cwd) {
            projects.setNotice("新建失败：项目不存在或已失效，请刷新项目列表后重试");
            return;
          }
          terminals.discardDraft(); // #60：切换焦点到结构化草稿：PTY 草稿静默丢弃（全局单草稿）
          controller.openDraft(cli, { projectId, cwd });
        }}
        onCreatePtySession={(projectId) => {
          const cwd = resolveSessionCwd(projects.projects, projectId, "pty", demoCwd ?? null);
          if (!cwd) {
            projects.setNotice("新建失败：项目不存在或已失效，请刷新项目列表后重试");
            return;
          }
          // #60：点「＋」只开终端草稿——首输入才创建（不落库、不进侧栏、不起进程）
          openPtyDraft({ projectId, cwd });
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
      ) : controller.draft ? (
        // #59：结构化草稿优先于会话视图（草稿占据中央区；切会话/项目即丢弃）
        <DraftPane
          draft={controller.draft}
          configPath={configPath}
          actions={{
            onSubmit: controller.submitDraft,
            onInput: (input) => controller.store.updateDraft({ input }),
            onPermChange: (mode) => controller.store.updateDraft({ permMode: mode }),
            onModelChange: (model) => controller.store.updateDraft({ model }),
            onDismissError: () => controller.store.clearDraftSubmitError(),
          }}
        />
      ) : terminals.draft ? (
        // #60：PTY 终端草稿（点「＋」后、首输入前：提示 + 可交互面板，优先于会话视图渲染）
        <TerminalWorkspace session={null} draft={terminals.draft} manager={terminals.manager} onKill={terminals.kill} />
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
            // 认证失效卡「打开 PTY 终端」：在会话 cwd 打开终端草稿（登录指引命令在终端内运行；#60 首输入才创建）
            onOpenPtyTerminal: (sessionId) => {
              const s = controller.store.getSession(sessionId);
              if (!s?.cwd) return;
              openPtyDraft({ projectId: s.projectId, cwd: s.cwd });
            },
          }}
        />
      )}
    </div>
  );
}
