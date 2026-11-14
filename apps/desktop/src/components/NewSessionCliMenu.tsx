// 用途：「＋」新建会话共享菜单深组件（arch D9）—— 侧栏项目行与详情面板两处同构菜单的单一实现：open 期间经 transport 拉安装表（未装灰置 +「未安装」尾注 + 悬停说明；结果未回/通道未接/失败一律不拦菜单，fake/pty 恒可选）+ 色点/PTY 项渲染；open 布尔经受控 props 由消费方持有（侧栏跨行互斥需要共享态，触发按钮与锚点定位差异留给消费方）
import { CLI_DOT_CLS, NEW_MENU_CLIS } from "../lib/cli-catalog";
import type { CliStatusChannel } from "../lib/use-cli-status";
import { CLI_NOT_INSTALLED_HINT, isCliUnavailable, useCliInstallStatus } from "../lib/use-cli-status";
import type { SessionDraftCli } from "../features/chat/use-chat";

export interface NewSessionCliMenuProps {
  /** cli:status 通道（transport 窄化注入；null/未接 = 不拦菜单） */
  transport?: CliStatusChannel | null;
  /** 菜单开态（受控：消费方触发按钮持有；打开即拉取安装表） */
  open: boolean;
  /** 选中任一项即关菜单（消费方回写自己的 open 态） */
  onClose(): void;
  /** 选中回调：三真实 CLI 结构化会话或 PTY 终端（随 onClose 一并触发） */
  onPick(cli: SessionDraftCli): void;
  /** PTY 项尾注（详情面板「无 skill 信号」；侧栏不注） */
  ptyNote?: string;
  /** 面板锚点差异（侧栏 left-3.5 min-w-[150px]；详情面板 left-0 min-w-[190px]） */
  menuClassName: string;
  /** 项字号差异（侧栏 text-[13px]；详情面板 text-xs） */
  itemClassName: string;
  /** 项 data-testid 前缀（详情面板 e2e/组件测试定位 new-session-item-*；侧栏无） */
  itemTestIdPrefix?: string;
}

export function NewSessionCliMenu({
  transport = null,
  open,
  onClose,
  onPick,
  ptyNote,
  menuClassName,
  itemClassName,
  itemTestIdPrefix,
}: NewSessionCliMenuProps) {
  // #80：菜单打开时拉取 CLI 安装表（未装灰置；结果未回/通道未接不拦菜单）
  const cliInstalled = useCliInstallStatus(transport, open);
  if (!open) return null;
  return (
    <div className={`absolute top-full z-10 mt-1 rounded-lg border border-border bg-muted p-1 shadow-[0_8px_24px_rgba(0,0,0,.5)] ${menuClassName}`}>
      {NEW_MENU_CLIS.map(({ cli, label }) => {
        // #80：未装灰置 + 「未安装」尾注（悬停说明），点击无效；fake/pty 恒可选不经探测
        const unavailable = isCliUnavailable(cliInstalled, cli);
        return (
          <button
            key={cli}
            type="button"
            data-testid={itemTestIdPrefix ? `${itemTestIdPrefix}-${cli}` : undefined}
            disabled={unavailable}
            title={unavailable ? CLI_NOT_INSTALLED_HINT : undefined}
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left enabled:hover:bg-card disabled:cursor-not-allowed disabled:opacity-50 ${itemClassName}`}
            onClick={() => {
              onClose();
              onPick({ kind: "structured", cli });
            }}
          >
            <span aria-hidden className={`inline-block h-2 w-2 flex-none rounded-full ${CLI_DOT_CLS[cli]}`} />
            {label}
            {unavailable ? <span className="ml-auto text-[11px] text-fg-faint">未安装</span> : null}
          </button>
        );
      })}
      <button
        type="button"
        data-testid={itemTestIdPrefix ? `${itemTestIdPrefix}-pty` : undefined}
        className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-card ${itemClassName}`}
        onClick={() => {
          onClose();
          onPick({ kind: "pty" });
        }}
      >
        <span aria-hidden className="inline-block h-2 w-2 flex-none rounded-full bg-pty" />
        PTY 终端
        {ptyNote ? <span className="ml-auto text-[11px] text-fg-faint">{ptyNote}</span> : null}
      </button>
    </div>
  );
}
