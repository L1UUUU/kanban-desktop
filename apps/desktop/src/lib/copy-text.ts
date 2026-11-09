// 用途：写剪贴板小工具 —— 失败记日志不抛出（Electron 剪贴板稳定可用，降级不阻塞主路径；ResumeBanner/ErrorBanner/CreateErrorCard 共用）
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    console.error("[kanban] 复制到剪贴板失败", e);
  }
}
