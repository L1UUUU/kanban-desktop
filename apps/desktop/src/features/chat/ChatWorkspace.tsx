// 用途：聊天工作区 —— useChatController + useProjects 接线侧栏与中央区（transport 可注入：生产 window.api，测试 FakeAdapter 直连；活跃会话为 PTY 时中央渲染终端面板；#59/#60 起「＋」/卡片建会话只开草稿（结构化首条消息、PTY 首输入才创建）；#18 起中央区在聊天/看板视图间切换，本组件常挂 → 会话与 CLI 生命周期与视图切换无关；issue #71 起草稿互斥/cwd 解析/项目提示内聚于 openSessionDraft，终端草稿机制由会话控制器承载）
import { useCallback, useEffect, type ReactNode } from "react";
import type { CliKind, RequirementCardRow } from "@kanban/ipc-schema";
import { Sidebar } from "../../components/Sidebar";
import type { ProjectsController } from "../projects/use-projects";
import type { ChatTransport } from "../../lib/kanban-api";
import type { AppView } from "../../lib/app-view";
import { PANEL_SIZE_KEYS, SIDEBAR_DEFAULT_WIDTH, sidebarWidthBounds } from "../../lib/panel-resize";
import { usePanelSize, useViewportSize } from "../../lib/use-panel-size";
import { ChatPane } from "./ChatPane";
import { DraftPane } from "./components/DraftPane";
import { detectMainRepoConflict } from "./conflict";
import { resolveSessionCwd, useChatController, type ChatController } from "./use-chat";
import { KanbanWorkspace } from "../kanban/KanbanWorkspace";
import type { KanbanController } from "../kanban/use-kanban";
import { TerminalWorkspace } from "../terminal/TerminalWorkspace";

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
  view?: AppView;
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
  // cwd 解析与项目提示注入（issue #71 S4）：「＋」/卡片/认证卡统一经 openSessionDraft 内聚，
  // 本组件只提供「项目列表 + 演示目录」的解析实现与 setNotice 出口
  const projectList = projects.projects;
  const demoCwdValue = demoCwd ?? null;
  const resolveCwd = useCallback(
    (projectId: string | null, cli: CliKind | "pty") => resolveSessionCwd(projectList, projectId, cli, demoCwdValue),
    [projectList, demoCwdValue],
  );
  const setNotice = projects.setNotice;
  const onNotice = useCallback((message: string) => setNotice(message), [setNotice]);
  // #92 内置 /kanban 命令视图切换单源（App 层 setView 注入 ChatController，composer 派发直达；prop 形参直接透传）
  const controller = useChatController(transport, { demoCwd: demoCwdValue, resolveCwd, onNotice, onSetView });
  // 暴露 controller（App chatRef 写入/测试 holder）：effect 而非渲染期调用——废弃渲染不再触发回调（#67）
  useEffect(() => {
    onController?.(controller);
  }, [onController, controller]);

  // #59/#60：切项目丢弃两类草稿——聊天与 PTY（不弹确认、输入不保留）；单一 effect 统一覆盖所有切项目路径
  // （含 register() 成功后 Main 自动切项目——不经侧栏点击，命令式 discard 会漏，spec #57 Story 5）；
  // discardAllDrafts 引用随项目列表刷新重建时本 effect 亦重跑——丢弃幂等（无草稿时 no-op），无行为差异
  // #86 先手让位（项目维度）：注册/切换为用户先手——他项目的激活会话（含启动自动选中者）清除选中回落空态，不跨项目残留
  const currentProjectId = projects.currentProjectId;
  const discardAllDrafts = controller.discardAllDrafts;
  const clearActiveIfForeignProject = controller.clearActiveIfForeignProject;
  useEffect(() => {
    discardAllDrafts();
    clearActiveIfForeignProject(currentProjectId);
  }, [currentProjectId, discardAllDrafts, clearActiveIfForeignProject]);

  // 活跃会话为 PTY 终端时中央渲染终端面板（与结构化聊天区并列切换，spec I）
  const active = controller.activeSession;
  // 主仓库并行冲突判据（spec I-4）：当前会话同目录 ≥2 活跃结构化会话 → 聊天区顶部提示条（仅提示不阻止，随快照动态更新）
  const conflictTitles = detectMainRepoConflict(controller.sessions, controller.activeId);

  // #20/#59 卡片建会话：打开草稿（cwd 解析/互斥/提示内聚于 openSessionDraft；需求关联随首条消息落到新会话）
  const createSessionForCard = (cli: CliKind | "pty", card: RequirementCardRow): void => {
    if (!card.projectId) {
      projects.setNotice("新建失败：需求未归属项目");
      return;
    }
    const r = controller.openSessionDraft({ projectId: card.projectId, cli, requirementId: card.id });
    if (r.ok) onSetView?.("chat"); // 草稿在中央区：从看板/记忆等视图发起时带回
  };

  // #85 侧栏宽度拖拽：视口联动上限（min(固定上限, 视口宽 − 中央区最小宽)），偏好持久化到 renderer localStorage
  const viewport = useViewportSize();
  const sidebar = usePanelSize({
    storageKey: PANEL_SIZE_KEYS.sidebarWidth,
    axis: "x",
    sign: 1, // 向右拖加宽
    bounds: sidebarWidthBounds(viewport.width),
    defaultSize: SIDEBAR_DEFAULT_WIDTH,
    ariaLabel: "拖拽调整侧栏宽度",
  });

  return (
    <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: `${Math.round(sidebar.size)}px 6px 1fr` }}>
      <Sidebar
        projects={projects.projects}
        currentProjectId={projects.currentProjectId}
        sessions={controller.sessions}
        activeId={controller.activeId}
        onSelect={(sessionId) => {
          // #60：切换会话 = 离开草稿（未发送的草稿静默丢弃，不弹确认）——双丢弃内聚于 switchTo
          controller.switchTo(sessionId);
        }}
        onSelectProject={(id) => {
          // #59/#60：切项目丢弃两类草稿由上方统一 effect 负责（currentProjectId 变化即触发）
          void projects.switchTo(id);
        }}
        onRegisterProject={() => void projects.register()}
        onCreateSession={(projectId, cli) => {
          // #59：点「＋」只打开草稿（不 invoke、不落库、侧栏无新行）；cwd 解析/项目不存在提示/
          // 互斥替换内聚于 openSessionDraft（项目查不到不回退任何路径——真实 CLI 拒绝并提示，Fake 回落演示 cwd）
          void controller.openSessionDraft({ projectId, cli });
        }}
        onCreatePtySession={(projectId) => {
          // #60：点「＋」只开终端草稿——首输入才创建（不落库、不进侧栏、不起进程）
          void controller.openSessionDraft({ projectId, cli: "pty" });
        }}
        onKillTerminal={controller.terminals.kill}
        onArchiveSession={(sessionId) => void controller.archiveSession(sessionId)}
        onDeleteSession={(sessionId) => void controller.deleteSession(sessionId)}
        onRenameSession={(sessionId, title) => controller.renameSession(sessionId, title)}
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
      {/* #85 侧栏宽度拖拽把手（grid 中列，指针捕获/rAF/Esc 回滚/双击复位/键盘步进见 use-panel-size） */}
      <div
        data-testid="sidebar-resize-handle"
        className={`h-full w-1.5 cursor-col-resize select-none hover:bg-primary/25 focus-visible:bg-primary/40 ${
          sidebar.dragging ? "bg-primary/40" : ""
        }`}
        {...sidebar.handleProps}
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
        // 草稿优先于会话视图（占据中央区；切会话/项目即丢弃）——判别联合两分支并一支（issue #71 S4）
        controller.draft.kind === "pty" ? (
          // #60：PTY 终端草稿（点「＋」后、首输入前：提示 + 可交互面板）
          <TerminalWorkspace
            session={null}
            draft={controller.draft.data}
            manager={controller.terminals.manager}
            onKill={controller.terminals.kill}
          />
        ) : (
          // #59：结构化会话草稿面板
          <DraftPane
            draft={controller.draft.data}
            models={controller.models}
            commands={controller.commands}
            configPath={configPath}
            actions={{
              onSubmit: controller.submitDraft,
              onInput: (input) => controller.updateDraft({ input }),
              onPermChange: (mode) => controller.updateDraft({ permMode: mode }),
              onModelChange: (model) => controller.updateDraft({ model }),
              onDismissError: controller.clearDraftSubmitError,
            }}
          />
        )
      ) : active && active.cli === "pty" ? (
        <TerminalWorkspace session={active} manager={controller.terminals.manager} onKill={controller.terminals.kill} />
      ) : (
        <ChatPane
          session={controller.activeSession}
          models={controller.models}
          commands={controller.commands}
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
            onDismissError: controller.clearError,
            // 认证失效卡「打开 PTY 终端」：在会话 cwd 打开终端草稿（登录指引命令在终端内运行；#60 首输入才创建）
            onOpenPtyTerminal: (sessionId) => {
              void controller.openSessionDraft({ projectId: null, cli: "pty", fromSessionId: sessionId });
            },
          }}
        />
      )}
    </div>
  );
}
