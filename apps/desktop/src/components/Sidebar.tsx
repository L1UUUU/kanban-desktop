// 用途：侧栏 —— 项目区（注册引导/项目行切换/悬浮「＋」CLI 新建菜单（NewSessionCliMenu 深组件，arch D9））+ 结构化会话与 PTY 终端两组会话行（CLI 色点/目录徽标/状态徽标/需求徽标/PTY 停止按钮，按当前项目过滤）+ 底部运行信息（原型一致项 1/2/3/6；PTY 实体 #12；REQ 徽标 #20；hover 归档 #58；hover 删除+二次确认 #62；分组标题语义澄清 #87；#94 结构化行 hover 铅笔行内重命名）
import { Fragment, useRef, useState, type ReactNode } from "react";
import type { AppInfo, CliKind, ProjectRow } from "@kanban/ipc-schema";
import type { ChatActionError, PtySessionView, SessionView, StructuredSessionView } from "../features/chat/chat-store";
import { StatusBadge } from "../features/chat/components/StatusBadge";
import { CLI_DOT_CLS } from "../lib/cli-catalog";
import type { CliStatusChannel } from "../lib/use-cli-status";
import { DeleteSessionDialog } from "./DeleteSessionDialog";
import { DirBadge } from "./DirBadge";
import { NewSessionCliMenu } from "./NewSessionCliMenu";

/** #94 会话行内重命名提交签名：返回 null=成功、统一错误形态=失败（#84 RequirementCard 同款交互；arch C7 错误通道统一，展示仍为行内 message） */
export type RenameSessionHandler = (sessionId: string, title: string) => Promise<ChatActionError | null>;

/** 会话行需求徽标（原型一致项 6，.req-badge）：REQ-id 文本 + 点击跳看板；span 避免 button 嵌套。
 *  可收缩截断（#65）：与状态徽标并存的 130px 行预算下 flex-none 徽标会把标题挤到 0 宽 */
function ReqBadge({ requirementId, onOpen }: { requirementId: string; onOpen?: (requirementId: string) => void }) {
  return (
    <span
      role="button"
      tabIndex={0}
      data-testid="req-badge"
      title={`${requirementId} · 点击进入看板`}
      className="ml-1 min-w-0 max-w-[5rem] shrink cursor-pointer truncate rounded border border-accent2/45 px-1 text-[11px] text-accent2 hover:bg-primary/15"
      onClick={(e) => {
        e.stopPropagation();
        onOpen?.(requirementId);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.stopPropagation();
          onOpen?.(requirementId);
        }
      }}
    >
      {requirementId}
    </span>
  );
}

export interface SidebarProps {
  projects: ProjectRow[];
  currentProjectId: string | null;
  sessions: SessionView[];
  activeId: string | null;
  onSelect(sessionId: string): void;
  onSelectProject(projectId: string): void;
  onRegisterProject(): void;
  onCreateSession(projectId: string, cli: CliKind): void;
  /** 「＋」菜单 PTY 项：在该项目目录新建终端会话（#12） */
  onCreatePtySession(projectId: string): void;
  /** cli:status 通道（arch D9：经 transport seam 拉「＋」菜单安装表；缺省不拦菜单） */
  transport?: CliStatusChannel | null;
  /** PTY 行停止按钮：显式终止终端进程（唯一停止入口） */
  onKillTerminal(terminalId: string): void;
  /** #58 会话行 hover「归档」（结构化与 PTY 同款）：Main 编排中断/终止+写归档标记，行移出默认列表 */
  onArchiveSession(sessionId: string): void;
  /** #62 会话行 hover「删除」（结构化与 PTY 同款）：经二次确认后由 Main 编排 unlink+终止+删记录，行移除 */
  onDeleteSession(sessionId: string): void;
  /** #94 / ADR 0003 结构化会话行 hover 铅笔行内重命名：session:rename → manual 终态；PTY 行不提供（豁免） */
  onRenameSession?: RenameSessionHandler;
  /** #20：会话→需求反查映射（kanban:list；会话行需求徽标数据源） */
  sessionToReq?: Record<string, string>;
  /** #20：会话行 REQ 徽标点击 → 进入看板并选中该需求（原型一致项 6） */
  onOpenRequirement?(requirementId: string): void;
  info?: ReactNode;
}

/**
 * #94 会话行内重命名输入（#84 RequirementCard 同款交互：Enter/blur 提交、Esc 还原、settledRef 防重复提交）。
 * 空白/未变直接退出不提交；提交回调由父层驱动 session:rename 并按结果清编辑态/显示错误。
 */
function SessionRenameInput({
  title,
  onCommit,
  onCancel,
}: {
  title: string;
  onCommit(next: string): void;
  onCancel(): void;
}) {
  const [draft, setDraft] = useState(title);
  // 一次编辑会话只提交/还原一次（Enter 直接提交后残余 blur、unmount 前 blur 不再重复发 session:rename）
  const settledRef = useRef(false);
  const commit = (): void => {
    if (settledRef.current) return;
    settledRef.current = true;
    const next = draft.trim();
    if (!next || next === title) {
      onCancel();
      return;
    }
    onCommit(next);
  };
  const cancel = (): void => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancel();
  };
  return (
    <input
      data-testid="session-rename-input"
      aria-label="会话标题"
      title="重命名会话（Enter 提交，Esc 还原）"
      autoFocus
      onFocus={(e) => e.target.select()}
      className="min-w-0 grow rounded-md border border-border bg-background px-1.5 text-[13px] text-foreground outline-none focus:border-primary"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") cancel();
      }}
    />
  );
}

export function Sidebar({
  projects,
  currentProjectId,
  sessions,
  activeId,
  onSelect,
  onSelectProject,
  onRegisterProject,
  onCreateSession,
  onCreatePtySession,
  transport = null,
  onKillTerminal,
  onArchiveSession,
  onDeleteSession,
  onRenameSession,
  sessionToReq = {},
  onOpenRequirement,
  info,
}: SidebarProps) {
  // 「＋」菜单开在哪个项目行上（一次只开一个）
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null);
  // #62 待二次确认删除的会话行（null=确认弹窗关闭）
  const [deleteTarget, setDeleteTarget] = useState<SessionView | null>(null);
  // #94 行内重命名编辑态（结构化行独有；editingId=null=无）与失败提示（再次进入编辑时清除）
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<{ id: string; message: string } | null>(null);

  // 会话按作用域过滤：有当前项目=该项目会话；无=无项目会话（boot 演示链路可见）
  const scopedSessions = sessions.filter((s) =>
    currentProjectId ? s.projectId === currentProjectId : s.projectId === null,
  );
  // 两组并列：结构化会话 / PTY 终端（判别联合按 kind 分组，spec I-1）
  const structured = scopedSessions.filter((s): s is StructuredSessionView => s.kind === "structured");
  const ptySessions = scopedSessions.filter((s): s is PtySessionView => s.kind === "pty");

  return (
    <aside className="relative flex flex-col overflow-y-auto border-r border-border bg-card py-2.5">
      <div className="flex items-center justify-between pr-2.5">
        <h4 className="px-3.5 pb-0.5 pt-1.5 text-[11px] tracking-wide text-muted-foreground">项目</h4>
        {/* 常驻注册入口：有项目时也可继续注册（多项目并存，用户故事 1） */}
        <button
          type="button"
          title="注册本地目录为项目"
          className="rounded px-1 text-[11px] text-fg-faint hover:text-primary"
          onClick={onRegisterProject}
        >
          ＋ 注册
        </button>
      </div>
      {projects.length === 0 ? (
        // 空态引导：注册本地目录为项目
        <div className="px-3.5 py-1.5">
          <p className="text-xs text-fg-faint">尚无项目</p>
          <button
            type="button"
            onClick={onRegisterProject}
            className="mt-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:border-primary hover:text-primary"
          >
            ＋ 注册本地目录…
          </button>
        </div>
      ) : (
        projects.map((p) => (
          <div
            key={p.id}
            className={`group relative flex items-center gap-2 px-3.5 py-1.5 ${p.id === currentProjectId ? "bg-muted" : ""}`}
          >
            <button type="button" className="flex min-w-0 flex-1 items-center gap-2 pr-8 text-left" onClick={() => onSelectProject(p.id)}>
              <span aria-hidden>📁</span>
              <span className="truncate text-[13px]" title={p.canonicalPath}>
                {p.name}
              </span>
              {p.status === "missing" ? <span className="flex-none text-[11px] text-warn">目录缺失</span> : null}
            </button>
            {/* 悬浮「＋」：absolute 脱离文档流 + 透明度切换，避免 hover 时 display:none→block 撑高行、挤窄项目名并下移下方内容（原型一致项 2）；
                不用 pointer-events 门控：点击命中判定先于鼠标移动，无 hover 态时命中会落到下层按钮（#65 验收定位的偶发点击拦截根因） */}
            <button
              type="button"
              title="新建会话（选择 CLI）"
              className="absolute right-3.5 top-1/2 h-6 w-6 -translate-y-1/2 rounded-md text-fg-faint opacity-0 hover:text-primary group-hover:opacity-100"
              onClick={() => {
                setMenuProjectId(menuProjectId === p.id ? null : p.id);
              }}
            >
              ＋
            </button>
            {/* ＋新建会话菜单（arch D9 深组件）：open 态/安装表拉取/灰置与 PTY 项内聚；本组件只留锚点与回调（#80 灰置口径不变） */}
            <NewSessionCliMenu
              transport={transport}
              open={menuProjectId === p.id}
              onClose={() => setMenuProjectId(null)}
              onPick={(cli) => {
                if (cli.kind === "pty") onCreatePtySession(p.id);
                else onCreateSession(p.id, cli.cli);
              }}
              menuClassName="left-3.5 min-w-[150px]"
              itemClassName="text-[13px]"
            />
          </div>
        ))
      )}

      <h4 className="px-3.5 pb-0.5 pt-3 text-[11px] tracking-wide text-muted-foreground">会话（本应用创建）</h4>
      {structured.length === 0 ? (
        <p className="px-3.5 py-1 text-xs text-fg-faint">暂无会话</p>
      ) : (
        structured.map((s) => (
          <Fragment key={s.sessionId}>
            <div
              className={`group relative flex w-full items-center gap-1 border-l-2 px-3.5 py-1.5 hover:bg-muted ${
                s.sessionId === activeId ? "border-l-primary bg-muted" : "border-l-transparent"
              }`}
            >
              {renamingId === s.sessionId ? (
                // #94 行内编辑态：input 替换标题行（色点保留，徽标暂避让）
                <>
                  <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${CLI_DOT_CLS[s.cli] ?? "bg-accent2"}`} />
                  <SessionRenameInput
                    title={s.title}
                    onCommit={(next) => {
                      setRenamingId(null);
                      if (!onRenameSession) return;
                      void onRenameSession(s.sessionId, next).then((err) => {
                        if (err) setRenameError({ id: s.sessionId, message: err.message });
                      });
                    }}
                    onCancel={() => setRenamingId(null)}
                  />
                </>
              ) : (
                <>
                  {/* 常驻 pr-20 为 hover 操作区预留右缘（徽标永不进入该区，命中判定不被拦截）；标题 grow + 徽标 truncate 保证 130px 预算下标题不被挤到 0 宽（#65 验收回归） */}
                  <button
                    type="button"
                    data-testid="session-row"
                    data-active={s.sessionId === activeId ? "true" : "false"}
                    className="flex min-w-0 flex-1 items-center gap-1 pr-20 text-left"
                    onClick={() => onSelect(s.sessionId)}
                  >
                    <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${CLI_DOT_CLS[s.cli] ?? "bg-accent2"}`} />
                    {/* 标题 grow（basis auto）而非 flex-1（basis 0）：徽标超宽时按基准宽度分摊收缩，标题不被挤到 0 宽（#65 验收回归） */}
                    <span className="min-w-0 grow truncate text-[13px]" title={s.title}>
                      {s.title}
                    </span>
                    <DirBadge identity={s.dirIdentity} worktreeName={s.worktreeName} cwd={s.cwd} />
                    <StatusBadge status={s.status} />
                    {s.sessionId in sessionToReq ? <ReqBadge requirementId={sessionToReq[s.sessionId]} onOpen={onOpenRequirement} /> : null}
                  </button>
                  <div className="absolute right-3.5 top-1/2 flex -translate-y-1/2 gap-1 opacity-0 group-hover:opacity-100">
                    {onRenameSession ? (
                      // #94 手动重命名铅笔（结构化行独有；PTY 行豁免）
                      <button
                        type="button"
                        title="重命名会话"
                        className="h-5 w-5 rounded-md text-[11px] text-fg-faint hover:text-primary"
                        onClick={() => {
                          setRenameError(null); // 再次进入编辑：清除上次失败提示
                          setRenamingId(s.sessionId);
                        }}
                      >
                        ✎
                      </button>
                    ) : null}
                    <button
                      type="button"
                      title="归档（移出默认列表，可在设置找回）"
                      className="h-5 rounded-md px-1 text-[11px] text-fg-faint hover:text-primary"
                      onClick={() => onArchiveSession(s.sessionId)}
                    >
                      归档
                    </button>
                    <button
                      type="button"
                      title="删除（终止进程并移除会话记录，不可撤销）"
                      className="h-5 rounded-md px-1 text-[11px] text-fg-faint hover:text-destructive"
                      onClick={() => setDeleteTarget(s)}
                    >
                      删除
                    </button>
                  </div>
                </>
              )}
            </div>
            {renameError?.id === s.sessionId ? (
              // #94 重命名失败行内提示（标题回滚由 store 未变天然保证）
              <p data-testid="session-rename-error" className="px-3.5 pb-1 text-[11px] text-destructive">
                {renameError.message}
              </p>
            ) : null}
          </Fragment>
        ))
      )}

      {/* #87（spec #82-F）：PTY 分组标题 + 常驻说明 + 悬浮解释 —— 澄清此列表只含本应用创建的终端，外部终端里运行的 CLI 不混入 */}
      <div
        className="px-3.5 pb-0.5 pt-3"
        title="仅列出本应用内创建的终端会话；在外部终端（系统终端 / IDE 等）里运行的 CLI 不会出现在此列表"
      >
        <h4 className="text-[11px] tracking-wide text-muted-foreground">PTY 终端（本应用创建）</h4>
        <p className="text-[10px] leading-tight text-fg-faint">仅应用内创建的终端；外部终端会话不混入</p>
      </div>
      {ptySessions.length === 0 ? (
        <p className="px-3.5 py-1 text-xs text-fg-faint">暂无终端会话</p>
      ) : (
        ptySessions.map((s) => (
          <div
            key={s.sessionId}
            data-testid="session-row"
            data-active={s.sessionId === activeId ? "true" : "false"}
            className={`group relative flex w-full items-center gap-1 border-l-2 px-3.5 py-1.5 hover:bg-muted ${
              s.sessionId === activeId ? "border-l-primary bg-muted" : "border-l-transparent"
            }`}
          >
            <button type="button" className="flex min-w-0 flex-1 items-center gap-1 pr-24 text-left" onClick={() => onSelect(s.sessionId)}>
              <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-pty" />
              {/* 同结构化行：grow 而非 flex-1，长 worktree 徽标下标题不被挤到 0 宽（#65） */}
              <span className="min-w-0 grow truncate text-[13px]" title={s.title}>
                {s.title}
              </span>
              <DirBadge identity={s.dirIdentity} worktreeName={s.worktreeName} cwd={s.cwd} />
              <StatusBadge status={s.status} />
              {s.sessionId in sessionToReq ? <ReqBadge requirementId={sessionToReq[s.sessionId]} onOpen={onOpenRequirement} /> : null}
            </button>
            <div className="absolute right-3.5 top-1/2 flex -translate-y-1/2 gap-1 opacity-0 group-hover:opacity-100">
              {s.status !== "disconnected" ? (
                <button
                  type="button"
                  title="停止终端（终止进程，保留会话记录）"
                  className="h-5 w-5 rounded-md text-[11px] text-fg-faint hover:text-destructive"
                  onClick={() => onKillTerminal(s.sessionId)}
                >
                  ⏹
                </button>
              ) : null}
              <button
                type="button"
                title="归档（移出默认列表，可在设置找回）"
                className="h-5 rounded-md px-1 text-[11px] text-fg-faint hover:text-primary"
                onClick={() => onArchiveSession(s.sessionId)}
              >
                归档
              </button>
              <button
                type="button"
                title="删除（终止进程并移除会话记录，不可撤销）"
                className="h-5 rounded-md px-1 text-[11px] text-fg-faint hover:text-destructive"
                onClick={() => setDeleteTarget(s)}
              >
                删除
              </button>
            </div>
          </div>
        ))
      )}

      {info ? <div className="mt-auto px-3.5 pb-1 pt-4 text-[11px] leading-relaxed text-fg-faint">{info}</div> : null}

      {/* #62 删除二次确认（原型 stage5 演示②）：确认后才走 onDeleteSession 编排（unlink → 终止 → 删记录） */}
      {deleteTarget ? (
        <DeleteSessionDialog
          title={deleteTarget.title}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const id = deleteTarget.sessionId;
            setDeleteTarget(null);
            onDeleteSession(id);
          }}
        />
      ) : null}
    </aside>
  );
}

/** 底部运行信息行（preload→main IPC 冒烟可见性） */
export function AppInfoLine({ info }: { info: AppInfo | null }) {
  if (!info) return <p>运行信息不可用（window.api 未暴露）</p>;
  return (
    <p>
      {info.app} · Electron {info.electron} · Node {info.node} · SQLite {info.sqliteEntry}
    </p>
  );
}
