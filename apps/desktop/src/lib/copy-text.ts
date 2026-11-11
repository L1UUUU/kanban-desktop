// 用途：写剪贴板小工具 —— 失败记统一日志不抛出（Electron 剪贴板稳定可用，降级不阻塞主路径；ResumeBanner/ErrorBanner/CreateErrorCard 共用）
import { createScopedLogger } from "./logger";

// 本文件日志出口（scope 固定 clipboard，经 lib/logger 唯一出口发出）
const log = createScopedLogger("clipboard");

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // #55：迁移统一日志（无桥可选链降级收敛于 logger.windowSink）；异常标量化后进 ctx
    log.error("复制到剪贴板失败", { error: e instanceof Error ? e.message : String(e) });
  }
}
