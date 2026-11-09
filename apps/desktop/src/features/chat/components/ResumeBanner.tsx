// 用途：断开会话恢复引导条（#42 / spec I 一致项 3）—— 聊天区顶部常驻三态 banner（与冲突条同位同形）：待恢复 / 恢复中（不可中断，D1）/ 失败（IPC 错误 + 重试 + 复制详情）
import type { ResumeState } from "../chat-store";

/** 写剪贴板（错误详情）；失败记日志不抛出（Electron 剪贴板稳定可用，降级不阻塞重试主路径） */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    console.error("[kanban] 复制错误详情失败", e);
  }
}

export function ResumeBanner({
  title,
  resumeState,
  onResume,
}: {
  /** 会话名（待恢复态展示「会话「xxx」来自上次运行…」） */
  title: string;
  /** 三态数据源（chat-store resumeState；成功收敛后 ChatPane 不再渲染本条） */
  resumeState: ResumeState;
  /** 一键恢复动作（同一 resumeSession 链，重试即再发一次） */
  onResume(): void;
}) {
  if (resumeState.phase === "resuming") {
    // 恢复中（D1 不可中断）：进行中状态展示，无任何按钮（resume 发出后无法真正撤回）
    return (
      <div data-testid="resume-banner" className="flex flex-none items-center gap-2 border-b border-primary/40 bg-primary/10 px-6 py-2 text-xs text-primary">
        <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        <span>正在读取原生历史并恢复上下文…（不可中断，通常数秒内完成）</span>
      </div>
    );
  }
  if (resumeState.phase === "failed") {
    // 失败：IPC 错误原因 + 错误码 + 重试（同一恢复动作）+ 复制错误详情
    return (
      <div
        data-testid="resume-banner"
        className="flex flex-none items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-6 py-2 text-xs text-destructive"
      >
        <span>
          ⚠ 恢复失败：{resumeState.message}（{resumeState.code}）。
        </span>
        <span className="ml-auto flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onResume}
            className="rounded-md border border-destructive/60 px-3 py-1 text-xs text-destructive hover:bg-destructive/10"
          >
            重试
          </button>
          <button
            type="button"
            onClick={() => void copyText(`${resumeState.code}：${resumeState.message}`)}
            className="rounded-md border border-destructive/60 px-3 py-1 text-xs text-destructive hover:bg-destructive/10"
          >
            复制错误详情
          </button>
        </span>
      </div>
    );
  }
  // 待恢复：会话名 + 缓存不替代原生历史说明 + 一键按钮（按钮文案保留「读取原生历史并恢复」，F12 兼容既有测试定位）
  return (
    <div
      data-testid="resume-banner"
      className="flex flex-none items-center gap-2 border-b border-primary/40 bg-primary/10 px-6 py-2 text-xs text-primary"
    >
      <span>📴 会话「{title}」来自上次运行（CLI 已退出）。缓存消息不替代原生历史。</span>
      <span className="ml-auto shrink-0">
        <button
          type="button"
          onClick={onResume}
          className="rounded-md border border-primary/60 px-3 py-1 text-xs text-primary hover:bg-primary/10"
        >
          读取原生历史并恢复
        </button>
      </span>
    </div>
  );
}
