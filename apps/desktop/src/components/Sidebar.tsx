// 用途：侧栏 —— 项目区（注册引导/项目行切换/悬浮「＋」CLI 新建菜单）+ 结构化会话与 PTY 终端两组会话行（CLI 色点/目录徽标/状态徽标/需求徽标/PTY 停止按钮，按当前项目过滤）+ 底部运行信息（原型一致项 1/2/3/6；PTY 实体 #12；REQ 徽标 #20；hover 归档 #58；hover 删除+二次确认 #62）
import { useState, type ReactNode } from "react";
import type { AppInfo, CliKind, ProjectRow } from "@kanban/ipc-schema";
import type { SessionView } from "../features/chat/chat-store";
import { StatusBadge } from "../features/chat/components/StatusBadge";
import { CLI_DOT_CLS, NEW_MENU_CLIS } from "../lib/cli-catalog";
import { DeleteSessionDialog } from "./DeleteSessionDialog";
import { DirBadge } from "./DirBadge";

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
  /** PTY 行停止按钮：显式终止终端进程（唯一停止入口） */
  onKillTerminal(terminalId: string): void;
  /** #58 会话行 hover「归档」（结构化与 PTY 同款）：Main 编排中断/终止+写归档标记，行移出默认列表 */
  onArchiveSession(sessionId: string): void;
  /** #62 会话行 hover「删除」（结构化与 PTY 同款）：经二次确认后由 Main 编排 unlink+终止+删记录，行移除 */
  onDeleteSession(sessionId: string): void;
  /** #20：会话→需求反查映射（kanban:list；会话行需求徽标数据源） */
  sessionToReq?: Record<string, string>;
  /** #20：会话行 REQ 徽标点击 → 进入看板并选中该需求（原型一致项 6） */
  onOpenRequirement?(requirementId: string): void;
  info?: ReactNode;
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
  onKillTerminal,
  onArchiveSession,
  onDeleteSession,
  sessionToReq = {},
  onOpenRequirement,
  info,
}: SidebarProps) {
  // 「＋」菜单开在哪个项目行上（一次只开一个）
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null);
  // #62 待二次确认删除的会话行（null=确认弹窗关闭）
  const [deleteTarget, setDeleteTarget] = useState<SessionView | null>(null);

  // 会话按作用域过滤：有当前项目=该项目会话；无=无项目会话（boot 演示链路可见）
  const scopedSessions = sessions.filter((s) =>
    currentProjectId ? s.projectId === currentProjectId : s.projectId === null,
  );
  // 两组并列：结构化会话 / PTY 终端（cli=pty，spec I-1）
  const structured = scopedSessions.filter((s) => s.cli !== "pty");
  const ptySessions = scopedSessions.filter((s) => s.cli === "pty");

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
            {menuProjectId === p.id ? (
              <div className="absolute left-3.5 top-full z-10 mt-1 min-w-[150px] rounded-lg border border-border bg-muted p-1 shadow-[0_8px_24px_rgba(0,0,0,.5)]">
                {NEW_MENU_CLIS.map(({ cli, label }) => (
                  <button
                    key={cli}
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-card"
                    onClick={() => {
                      setMenuProjectId(null);
                      onCreateSession(p.id, cli);
                    }}
                  >
                    <span className={`inline-block h-2 w-2 rounded-full ${CLI_DOT_CLS[cli]}`} />
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-card"
                  onClick={() => {
                    setMenuProjectId(null);
                    onCreatePtySession(p.id);
                  }}
                >
                  <span className="inline-block h-2 w-2 rounded-full bg-pty" />
                  PTY 终端
                </button>
              </div>
            ) : null}
          </div>
        ))
      )}

      <h4 className="px-3.5 pb-0.5 pt-3 text-[11px] tracking-wide text-muted-foreground">结构化会话</h4>
      {structured.length === 0 ? (
        <p className="px-3.5 py-1 text-xs text-fg-faint">暂无会话</p>
      ) : (
        structured.map((s) => (
          <div
            key={s.sessionId}
            className={`group relative flex w-full items-center gap-1 border-l-2 px-3.5 py-1.5 hover:bg-muted ${
              s.sessionId === activeId ? "border-l-primary bg-muted" : "border-l-transparent"
            }`}
          >
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

      <h4 className="px-3.5 pb-0.5 pt-3 text-[11px] tracking-wide text-muted-foreground">PTY 终端</h4>
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
