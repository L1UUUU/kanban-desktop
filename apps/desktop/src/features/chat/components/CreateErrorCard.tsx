// 用途：会话创建失败卡（#46 / spec #40 F1 + 原型 d2 卡 3 形态）—— session:create 失败无会话视图可挂，在侧栏创建入口（info 槽）呈现：
// spawn 失败（E_SPAWN_NOT_FOUND）显示配置路径指引 +「重试创建」；其余保留 code/message 原文 +「复制错误详情」；动作仅编排不执行破坏性操作
import type { CreateFailure } from "../chat-store";
import { classifyError, CLI_LABELS } from "../error-classify";
import { copyText } from "../../../lib/copy-text";

/** 次要按钮（复制/知道了）：中性描边（侧栏窄容器内小号） */
const BTN = "rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary hover:text-primary";
/** 主按钮（重试创建）：destructive 描边 */
const BTN_PRIMARY = "rounded-md border border-destructive/60 px-2 py-0.5 text-[11px] text-destructive hover:bg-destructive/10";

export function CreateErrorCard({
  failure,
  configPath,
  onRetry,
  onDismiss,
}: {
  failure: CreateFailure;
  /** 配置文件绝对路径（AppInfo 注入；null=不可用则不渲染「复制配置路径」与路径文本） */
  configPath: string | null;
  /** 「重试创建」：以原参数（cli/cwd/projectId/title/requirementId）重发 session:create */
  onRetry(): void;
  /** 「知道了」：仅关闭卡片（不重试） */
  onDismiss(): void;
}) {
  const kind = classifyError(failure.code);
  const spawn = kind === "spawn_not_found";
  const label = CLI_LABELS[failure.cli] ?? failure.cli;

  return (
    <div
      data-testid="create-error-card"
      className={`mb-1.5 overflow-hidden rounded-[10px] border bg-card ${spawn ? "border-destructive/40" : "border-border"}`}
    >
      <div className={`flex items-center gap-1.5 border-b border-border px-2.5 py-1.5 text-xs font-semibold ${spawn ? "text-destructive" : "text-muted-foreground"}`}>
        <span aria-hidden>{spawn ? "🔍" : "❔"}</span>
        <span>{spawn ? `找不到 CLI 程序（${label}）` : "会话创建失败"}</span>
      </div>
      <div className="flex flex-col gap-1 px-2.5 py-1.5">
        {spawn ? (
          <>
            <p className="text-xs text-foreground">未找到 {label} 可执行文件，会话创建失败。已探测的常见安装位置均无结果。</p>
            <p className="break-all text-[11px] leading-relaxed text-muted-foreground">
              确认已安装并在 PATH 中，或在配置文件{configPath ? `（${configPath}）` : ""}手动指定 cliExe.{failure.cli} 路径。原始信息：{failure.message}
            </p>
          </>
        ) : (
          <p className="break-all text-[11px] leading-relaxed text-muted-foreground">
            创建失败（{failure.code}）：{failure.message}（保留原始 code 与 message 原文）
          </p>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-1.5 px-2.5 pb-2">
        <button type="button" className={BTN_PRIMARY} onClick={onRetry}>
          重试创建
        </button>
        {spawn && configPath ? (
          <button type="button" className={BTN} onClick={() => void copyText(configPath)}>
            复制配置路径
          </button>
        ) : null}
        {!spawn ? (
          <button type="button" className={BTN} onClick={() => void copyText(`${failure.code}：${failure.message}`)}>
            复制错误详情
          </button>
        ) : null}
        <button type="button" className={BTN} onClick={onDismiss}>
          知道了
        </button>
      </div>
    </div>
  );
}
