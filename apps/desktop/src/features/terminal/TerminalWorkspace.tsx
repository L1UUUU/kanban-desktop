// 用途：PTY 会话中央面板 —— 活跃终端渲染 TerminalPanel + 顶栏（cwd 与「⏹ 停止终端」= 用户显式终止唯一入口）；#60 草稿态：提示行 + 可交互 xterm（首输入触发创建，失败保留缓冲）；草稿与正式会话共用同一挂载树（draft→live 转换不卸载 TerminalPanel，输入焦点不丢字）；从未挂载过的断开会话（重启恢复）显示断开占位
import type { SessionView } from "../chat/chat-store";
import type { TerminalDraftSnapshot } from "./terminal-draft";
import { TerminalPanel } from "./TerminalPanel";
import type { TerminalManager } from "./TerminalManager";

export function TerminalWorkspace({
  session,
  draft = null,
  manager,
  onKill,
}: {
  /** 活跃 PTY 会话（草稿打开时可为 null） */
  session: SessionView | null;
  /** #60：PTY 终端草稿（存在时优先呈现：草稿提示 + 可交互面板，无停止按钮） */
  draft?: TerminalDraftSnapshot | null;
  manager: TerminalManager;
  onKill(terminalId: string): void;
}) {
  if (!draft && !session) return null;

  // 面板渲染条件：草稿恒挂（可交互等待首输入）；会话=本运行期已看过（有实例）或状态未断开（新建活跃）；
  // 仅「重启恢复/从未挂载且已断开」的条目显示占位（进程不在，引导重新新建）
  const terminalId = draft ? draft.terminalId : session!.sessionId;
  const showPanel = Boolean(draft) || manager.has(session!.sessionId) || session!.status !== "disconnected";
  const title = draft ? "终端草稿" : session!.title;
  const cwd = draft ? draft.cwd : session!.cwd;
  const stoppable = !draft && session!.status !== "disconnected";

  return (
    <section className="grid min-h-0 min-w-0 grid-rows-[42px_1fr] bg-background">
      <header className="flex items-center justify-between border-b border-border bg-card px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`inline-block h-2 w-2 shrink-0 rounded-full bg-pty`} />
          <span className="truncate text-[13px]">{title}</span>
          {cwd ? (
            <span className="truncate text-[11px] text-fg-faint" title={cwd}>
              {cwd}
            </span>
          ) : null}
        </div>
        {stoppable ? (
          <button
            type="button"
            className="rounded-md border border-border px-2 py-0.5 text-[12px] text-muted-foreground hover:border-destructive hover:text-destructive"
            onClick={() => onKill(session!.sessionId)}
          >
            ⏹ 停止终端
          </button>
        ) : null}
      </header>
      {/* 槽位固定：提示行槽（草稿专属，非草稿为空）+ 面板槽 —— draft→live 转换时 TerminalPanel 不卸载（焦点保持，输入不丢） */}
      <div className="grid min-h-0 grid-rows-[auto_1fr]">
        {draft ? (
          <div className="border-b border-border bg-muted px-4 py-1.5 text-[11px] leading-relaxed">
            <p className="text-warn">🖥 终端草稿 · 尚未启动进程（不落库、不进侧栏）— 输入任意字符即启动 PTY 并落库</p>
            {draft.error ? (
              <p className="mt-0.5 text-destructive">启动失败：{draft.error.message}（{draft.error.code}）— 输入已保留，继续输入即重试</p>
            ) : null}
          </div>
        ) : null}
        {showPanel ? (
          <TerminalPanel terminalId={terminalId} manager={manager} />
        ) : (
          <div className="flex items-center justify-center px-6 py-4">
            <p className="text-sm text-muted-foreground">该终端进程已结束（随上次运行退出或已被停止）。可在左侧项目行「＋」新建终端会话继续。</p>
          </div>
        )}
      </div>
    </section>
  );
}
