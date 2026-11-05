// 用途：PTY 会话中央面板 —— 活跃终端渲染 TerminalPanel + 顶栏（cwd 与「⏹ 停止终端」= 用户显式终止唯一入口）；从未挂载过的断开会话（重启恢复）显示断开占位
import type { SessionView } from "../chat/chat-store";
import { TerminalPanel } from "./TerminalPanel";
import type { TerminalManager } from "./TerminalManager";

export function TerminalWorkspace({
  session,
  manager,
  onKill,
}: {
  session: SessionView;
  manager: TerminalManager;
  onKill(terminalId: string): void;
}) {
  // 面板渲染条件：本运行期已看过（有实例，含停止后保留最终画面）或状态未断开（新建活跃终端）；
  // 仅「重启恢复/从未挂载且已断开」的条目显示占位（进程不在，引导重新新建）
  const showPanel = manager.has(session.sessionId) || session.status !== "disconnected";

  return (
    <section className="grid min-h-0 min-w-0 grid-rows-[42px_1fr] bg-background">
      <header className="flex items-center justify-between border-b border-border bg-card px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`inline-block h-2 w-2 shrink-0 rounded-full bg-pty`} />
          <span className="truncate text-[13px]">{session.title}</span>
          {session.cwd ? (
            <span className="truncate text-[11px] text-fg-faint" title={session.cwd}>
              {session.cwd}
            </span>
          ) : null}
        </div>
        {session.status !== "disconnected" ? (
          <button
            type="button"
            className="rounded-md border border-border px-2 py-0.5 text-[12px] text-muted-foreground hover:border-destructive hover:text-destructive"
            onClick={() => onKill(session.sessionId)}
          >
            ⏹ 停止终端
          </button>
        ) : null}
      </header>
      {showPanel ? (
        <TerminalPanel terminalId={session.sessionId} manager={manager} />
      ) : (
        <div className="flex items-center justify-center px-6 py-4">
          <p className="text-sm text-muted-foreground">该终端进程已结束（随上次运行退出或已被停止）。可在左侧项目行「＋」新建终端会话继续。</p>
        </div>
      )}
    </section>
  );
}
