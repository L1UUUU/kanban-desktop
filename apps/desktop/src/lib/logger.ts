// 用途：渲染端日志唯一出口（issue #69 P1）—— 固定 scope 子记录器 + 可注入 sink（生产=window.api.log 桥，测试=内存断言）；词汇对齐 Main 侧 ScopedLogger（electron/main/logger.ts），level/ctx 类型单源 @kanban/ipc-schema
import type { LogCtx, LogLevel } from "@kanban/ipc-schema";

/** 日志落点 seam：生产 window 桥 / 测试内存断言（两个 adapter） */
export type LogSink = (level: LogLevel, scope: string, message: string, ctx?: LogCtx) => void;

/** 生产 sink：可选链降级语义收敛到这一处（jsdom 无桥不崩，fire-and-forget 语义不变） */
const windowSink: LogSink = (level, scope, message, ctx) => {
  window.api?.log?.(level, scope, message, ctx);
};

let sink: LogSink = windowSink;

/** 测试注入断言 sink；返回还原函数（afterEach 必调，防跨用例泄漏） */
export function setLogSinkForTest(s: LogSink): () => void {
  sink = s;
  return () => {
    sink = windowSink;
  };
}

/** 固定 scope 子记录器（scope 每文件单源，调用点免 scope） */
export interface ScopedLogger {
  error(m: string, ctx?: LogCtx): void;
  warn(m: string, ctx?: LogCtx): void;
  info(m: string, ctx?: LogCtx): void;
  debug(m: string, ctx?: LogCtx): void;
}

/** 创建固定 scope 子记录器：条目经当前 sink 发出（注入后已有实例同样生效） */
export function createScopedLogger(scope: string): ScopedLogger {
  const emit = (level: LogLevel, m: string, ctx?: LogCtx): void => sink(level, scope, m, ctx);
  return {
    error: (m, c) => emit("error", m, c),
    warn: (m, c) => emit("warn", m, c),
    info: (m, c) => emit("info", m, c),
    debug: (m, c) => emit("debug", m, c),
  };
}
