// 用途：写剪贴板小工具 —— 失败记统一日志不抛出（Electron 剪贴板稳定可用，降级不阻塞主路径；ResumeBanner/ErrorBanner/CreateErrorCard 共用）
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // #55：迁移统一日志（jsdom 无桥可选链降级）；异常标量化后进 ctx
    window.api?.log?.("error", "clipboard", "复制到剪贴板失败", { error: e instanceof Error ? e.message : String(e) });
  }
}
