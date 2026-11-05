// 用途：侧栏 —— 项目区（hover「＋」新建菜单，#6 仅 Fake 入口）+ 结构化会话行（CLI 色点/标题/状态徽标）+ PTY 分组 + 底部运行信息（原型一致项 1/2/3 的 #6 范围）
import { useState, type ReactNode } from "react";
import type { AppInfo } from "@kanban/ipc-schema";
import type { SessionView } from "../features/chat/chat-store";
import { StatusBadge } from "../features/chat/components/StatusBadge";

// CLI 色点（原型四色；fake 演示用 accent2 蓝）
const CLI_DOT_CLS: Record<string, string> = {
  fake: "bg-accent2",
  codex: "bg-codex",
  claude: "bg-claude",
  opencode: "bg-opencode",
  pty: "bg-pty",
};

export interface SidebarProps {
  sessions: SessionView[];
  activeId: string | null;
  onSelect(sessionId: string): void;
  onCreate(): void;
  info?: ReactNode;
}

export function Sidebar({ sessions, activeId, onSelect, onCreate, info }: SidebarProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <aside className="relative flex flex-col overflow-y-auto border-r border-border bg-card py-2.5">
      <h4 className="px-3.5 pb-0.5 pt-1.5 text-[11px] tracking-wide text-muted-foreground">项目</h4>
      {/* 项目行：悬浮显示「＋」，点击弹 CLI 新建菜单（#6 仅 Fake；三 CLI 随 #7/#9/#10 接入） */}
      <div className="group flex items-center gap-2 bg-muted px-3.5 py-1.5">
        <span aria-hidden>📁</span>
        <span className="truncate text-[13px]">kanban-desktop</span>
        <button
          type="button"
          title="新建会话（选择 CLI）"
          className="hidden h-6 w-6 shrink-0 rounded-md text-fg-faint hover:text-primary group-hover:block"
          onClick={() => setMenuOpen((v) => !v)}
        >
          ＋
        </button>
        {menuOpen ? (
          <div className="absolute left-3.5 top-full z-10 mt-1 min-w-[150px] rounded-lg border border-border bg-muted p-1 shadow-[0_8px_24px_rgba(0,0,0,.5)]">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-card"
              onClick={() => {
                setMenuOpen(false);
                onCreate();
              }}
            >
              <span className={`inline-block h-2 w-2 rounded-full ${CLI_DOT_CLS.fake}`} />
              新建 Fake 会话
            </button>
          </div>
        ) : null}
      </div>

      <h4 className="px-3.5 pb-0.5 pt-3 text-[11px] tracking-wide text-muted-foreground">结构化会话</h4>
      {sessions.length === 0 ? (
        <p className="px-3.5 py-1 text-xs text-fg-faint">暂无会话</p>
      ) : (
        sessions.map((s) => (
          <button
            key={s.sessionId}
            type="button"
            className={`flex w-full items-center gap-1 border-l-2 px-3.5 py-1.5 text-left hover:bg-muted ${
              s.sessionId === activeId ? "border-l-primary bg-muted" : "border-l-transparent"
            }`}
            onClick={() => onSelect(s.sessionId)}
          >
            <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${CLI_DOT_CLS[s.cli] ?? "bg-accent2"}`} />
            <span className="min-w-0 flex-1 truncate text-[13px]">{s.title}</span>
            <StatusBadge status={s.status} />
          </button>
        ))
      )}

      <h4 className="px-3.5 pb-0.5 pt-3 text-[11px] tracking-wide text-muted-foreground">PTY 终端</h4>
      <p className="px-3.5 py-1 text-xs text-fg-faint">暂无终端会话</p>

      {info ? <div className="mt-auto px-3.5 pb-1 pt-4 text-[11px] leading-relaxed text-fg-faint">{info}</div> : null}
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
