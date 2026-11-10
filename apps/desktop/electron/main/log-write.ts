// 用途：Renderer 日志入站处理（#55 spec #52 B/C 节）—— log:write 单向消息的 safeParse 校验、source 强制、丢弃告警；fire-and-forget 语义不回 Renderer
import { logEntrySchema } from "@kanban/ipc-schema";
import type { Logger } from "./logger";

/**
 * 处理一条 renderer 经 log:write 发来的日志条目：
 * safeParse 失败 → 丢弃并记一条 warn（不抛错、不回执，N10 fire-and-forget）；
 * 成功 → source 强制 renderer（不信自报）、ts 由 Logger 生成（wire ts 不透传）、ctx 已由 schema 保证标量。
 */
export function handleLogWrite(logger: Pick<Logger, "log">, raw: unknown): void {
  const parsed = logEntrySchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.message).join("；");
    logger.log("warn", "log", `Renderer 日志条目不符合 schema 已丢弃：${issues}`);
    return;
  }
  const { level, scope, message, ctx } = parsed.data;
  logger.log(level, scope, message, ctx, "renderer");
}
