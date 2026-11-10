// 用途：Renderer 全局错误兜底（#55 spec #52 F 节）—— window.onerror / unhandledrejection 经 log:write 记 error；React 挂载入口（main.tsx）createRoot 之前注册；window.api 缺失（jsdom）可选链降级不崩

/** 未捕获异常/未处理 rejection → error 级 crash 条目；onerror 返回 false 保持默认控制台行为（不吞错）；返回注销器（测试清理用） */
export function registerRendererCrashHandlers(win: Window): () => void {
  win.onerror = (message, _source, lineno, colno, error) => {
    win.api?.log?.("error", "crash", `未捕获渲染错误：${String(message)} @${lineno}:${colno}`, errorCtx(error));
    return false;
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    const reason = event.reason;
    win.api?.log?.(
      "error",
      "crash",
      `未处理 Promise rejection：${reason instanceof Error ? reason.message : String(reason)}`,
      errorCtx(reason),
    );
  };
  win.addEventListener("unhandledrejection", onUnhandledRejection);
  return () => {
    win.removeEventListener("unhandledrejection", onUnhandledRejection);
    win.onerror = null;
  };
}

/** Error 实例附堆栈 ctx（非 Error 裸值无堆栈，不带 ctx） */
function errorCtx(value: unknown): { stack: string } | undefined {
  return value instanceof Error ? { stack: value.stack ?? value.message } : undefined;
}
