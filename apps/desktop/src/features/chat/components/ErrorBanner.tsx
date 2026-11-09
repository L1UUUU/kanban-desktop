// 用途：会话内错误卡 ErrorBanner（#46 / spec I 一致项 2、原型 d2 五卡信息结构）—— 按 classify 结果渲染四类 + 未知兜底：
// 卡式布局（图标+标题头 / 原因区含原始信息 / 指引命令块（认证）/ 动作按钮区右对齐）；动作仅编排不执行破坏性操作（恢复=ResumeBanner 同一动作 D4，重试/开终端/复制）
import { authLoginCommand, classifyError, CLI_LABELS } from "../error-classify";
import { copyText } from "../../../lib/copy-text";

/** 次要按钮（知道了/复制类）：中性描边 */
const BTN = "rounded-md border border-border px-3 py-1 text-xs text-muted-foreground hover:border-primary hover:text-primary";
/** 主按钮（恢复/重试）：destructive 描边（错误语境主动作） */
const BTN_PRIMARY = "rounded-md border border-destructive/60 px-3 py-1 text-xs text-destructive hover:bg-destructive/10";

export interface ErrorBannerProps {
  /** 错误码（三源并集：session_error 枚举 / E_SESSION_EXIT / IPC 码） */
  code: string;
  /** 错误消息原文（unknown 卡与「原始信息」行保留展示，不吞错） */
  message: string;
  /** 会话 CLI（标题与指引命令按 CLI 定制） */
  cli: string;
  /** 会话名（cli_exit 卡说明用） */
  title: string;
  /** 配置文件绝对路径（spawn 卡「复制配置路径」；null=不可用则不渲染该按钮） */
  configPath?: string | null;
  /** 是否可重试（会话内有可重发的用户消息；false 时不渲染「重试」） */
  canRetry?: boolean;
  /** 是否可开 PTY 终端（会话有 cwd；false 时不渲染「打开 PTY 终端」） */
  canOpenPtyTerminal?: boolean;
  /** 「恢复会话/读取原生历史并恢复」：与恢复引导条完全相同的动作（D4，非独立路径） */
  onResume(): void;
  /** 「重试」：重发最近一条用户消息 */
  onRetry(): void;
  /** 「打开 PTY 终端」：在会话 cwd 新建 PTY 终端（认证指引命令在终端内运行） */
  onOpenPtyTerminal(): void;
  /** 「知道了」：关闭错误卡（仅清除 lastError，不影响会话） */
  onDismiss(): void;
}

export function ErrorBanner(props: ErrorBannerProps) {
  const { code, message, cli, title, configPath = null, canRetry = false, canOpenPtyTerminal = false } = props;
  const kind = classifyError(code);
  const label = CLI_LABELS[cli] ?? cli;

  // ── 卡头（图标 + 标题；unknown 用中性配色，其余 destructive）──
  const head =
    kind === "cli_exit"
      ? { icon: "⚠", text: "CLI 进程异常退出" }
      : kind === "auth_expired"
        ? { icon: "🔑", text: `登录已失效（${label}）` }
        : kind === "spawn_not_found"
          ? { icon: "🔍", text: `找不到 CLI 程序（${label}）` }
          : kind === "protocol_disconnect"
            ? { icon: "🔌", text: `连接中断（${label}）` }
            : { icon: "❔", text: "未知错误" };
  const unknownKind = kind === "unknown";

  // ── 原因区（说明行 + why 行；所有卡保留原始信息原文）──
  let lead: string;
  let why: string;
  if (kind === "cli_exit") {
    lead = `会话「${title}」的 CLI 进程已退出，会话已断开。已产生的对话与文件修改不受影响。`;
    why = `原始信息：${message}。常见原因：CLI 自身崩溃、被系统终止、或机器资源不足。不会自动重放任何未完成的操作。`;
  } else if (kind === "auth_expired") {
    lead = `${label} 报告认证失败，会话无法继续。需要在终端重新登录一次。`;
    why = `原始信息：${message}。可在应用的 PTY 终端会话中直接运行上面的命令；完成后点「重试」继续本会话。`;
  } else if (kind === "spawn_not_found") {
    lead = `未找到 ${label} 可执行文件，会话无法继续。已探测的常见安装位置均无结果。`;
    why = `原始信息：${message}。确认已安装并在 PATH 中，或在配置文件${configPath ? `（${configPath}）` : ""}手动指定 cliExe.${cli} 路径。`;
  } else if (kind === "protocol_disconnect") {
    lead = `与 ${label} 服务的连接断开，消息流已停止。工作区文件保持当前状态。`;
    why = `原始信息：${message}。常见原因：server 进程退出、端口被占用或网络抖动。可尝试恢复会话；恢复时将按需重新拉起 server。`;
  } else {
    lead = `发生未识别的错误（${code}）：${message}`;
    why = "未覆盖的错误类型保留原始 code 与 message 原文展示（不吞错、不编造原因）。";
  }

  // ── 指引命令块（仅认证卡；等宽底色块）──
  const cmds = kind === "auth_expired" ? authLoginCommand(cli) : [];

  return (
    <div
      data-testid="error-card"
      className={`mx-auto mb-3.5 w-[min(640px,92%)] overflow-hidden rounded-[10px] border bg-card ${unknownKind ? "border-border" : "border-destructive/40"}`}
    >
      <div
        className={`flex items-center gap-2 border-b border-border px-3.5 py-2.5 text-[13px] font-semibold ${unknownKind ? "text-muted-foreground" : "text-destructive"}`}
      >
        <span aria-hidden>{head.icon}</span>
        <span>{head.text}</span>
      </div>
      <div className="flex flex-col gap-2 px-3.5 py-2.5">
        <p className="text-[13px] text-foreground">{lead}</p>
        {cmds.length > 0 ? (
          <pre data-testid="auth-cmd" className="rounded-lg border border-border bg-muted px-2.5 py-1.5 font-mono text-xs text-muted-foreground">
            {cmds.join("\n")}
          </pre>
        ) : null}
        <p className="break-all text-xs text-muted-foreground">{why}</p>
      </div>
      <div className="flex justify-end gap-2 px-3.5 pb-3">
        {kind === "cli_exit" ? (
          <>
            <button type="button" className={BTN_PRIMARY} onClick={props.onResume}>
              读取原生历史并恢复
            </button>
            <button type="button" className={BTN} onClick={props.onDismiss}>
              知道了
            </button>
          </>
        ) : null}
        {kind === "auth_expired" ? (
          <>
            {canRetry ? (
              <button type="button" className={BTN_PRIMARY} onClick={props.onRetry}>
                重试
              </button>
            ) : null}
            {canOpenPtyTerminal ? (
              <button type="button" className={BTN} onClick={props.onOpenPtyTerminal}>
                打开 PTY 终端
              </button>
            ) : null}
          </>
        ) : null}
        {kind === "spawn_not_found" ? (
          <>
            {canRetry ? (
              <button type="button" className={BTN_PRIMARY} onClick={props.onRetry}>
                重试
              </button>
            ) : null}
            {configPath ? (
              <button type="button" className={BTN} onClick={() => void copyText(configPath)}>
                复制配置路径
              </button>
            ) : null}
          </>
        ) : null}
        {kind === "protocol_disconnect" ? (
          <>
            <button type="button" className={BTN_PRIMARY} onClick={props.onResume}>
              恢复会话
            </button>
            <button type="button" className={BTN} onClick={props.onDismiss}>
              知道了
            </button>
          </>
        ) : null}
        {kind === "unknown" ? (
          <>
            {canRetry ? (
              <button type="button" className={BTN_PRIMARY} onClick={props.onRetry}>
                重试
              </button>
            ) : null}
            <button type="button" className={BTN} onClick={() => void copyText(`${code}：${message}`)}>
              复制错误详情
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
