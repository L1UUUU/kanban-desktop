// 用途：日志系统 wire 契约（#55 spec #52 B/C 节）—— renderer→main 单向通道 log:write 的条目形状；ctx 逐键收敛标量防聊天对象入日志（N14），嵌套对象丢弃 = 逐键剥离、条目与 message 保留；maxMessageChars 截断不进 schema 常量、只在 Logger 按 config 运行期值生效（N12）
import { z } from "zod";

/** 日志级别四枚举（Q4：error/warn/info/debug，默认 info） */
export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export const logLevelSchema = z.enum(LOG_LEVELS);
export type LogLevel = (typeof LOG_LEVELS)[number];

/** 日志来源三执行体口径（Q2：CLI 子进程 stderr 归 worker，由产生它的执行体归属） */
export const LOG_SOURCES = ["main", "worker", "renderer"] as const;
export const logSourceSchema = z.enum(LOG_SOURCES);
export type LogSource = (typeof LOG_SOURCES)[number];

/**
 * 诊断日志 kind 全集（issue #68）：cli-host `log(kind, detail)` 通道的固定枚举，生产者横跨 cli-host（三 CLI 适配器 / codex rpc / opencode server-host / run-once）与 desktop main（cli-host-client / shutdown 编排）。
 * 单源于 ipc-schema 使两包生产者签名共用 LogKind 编译期收窄；level/scope 映射由 Main KIND_LOG_MAP: Record<LogKind,…> 穷尽（新增 kind 不改表从静默落 debug 变为编译错误）。
 */
export const LOG_KINDS = [
  // warn / cli-host
  "stderr",
  "server-stderr",
  "job-guard",
  "worker-exit-pending",
  // error / cli-host
  "dead",
  "server-dead",
  "parse-error",
  "init-error",
  "command-failed",
  "worker-exit",
  // info / lifecycle
  "shutdown",
  "restore",
  // debug / cli-host（默认静默诊断，映射表显式条目化）
  "readTranscript",
  "text-mismatch",
  "stuck-finish",
  "tool-reconcile",
  "session-id-mismatch",
  "unknown-control-request",
  "perm-mode-shared",
  "server-stop",
  "registry-write",
  "orphan-reject",
  "orphan-unreachable",
  "orphan-adopt",
  "orphan-response",
  "unknown-shape",
  "server-start",
  "port-retry",
  "api-retry",
  "sse-error",
  "sse-parse",
] as const;
export const logKindSchema = z.enum(LOG_KINDS);
export type LogKind = (typeof LOG_KINDS)[number];

/** ctx 标量 Record：逐键收敛，仅保留 string/number/boolean，嵌套对象/数组/null/undefined 值剥键不弃条目（N14） */
export const logCtxSchema = z.preprocess(
  (raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
    const scalars: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") scalars[key] = value;
    }
    return scalars;
  },
  z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
);
export type LogCtx = z.infer<typeof logCtxSchema>;

/**
 * renderer→main 单向日志条目（通道 log:write，send fire-and-forget）。
 * source 与 ts 虽在 wire 上必填，但 Main 侧一律强制 source=入口归属、ts 由 Logger 生成，不信自报（spec #52 C 节）。
 */
export const logEntrySchema = z.object({
  level: logLevelSchema,
  source: logSourceSchema,
  /** 记录域分类（chat/terminal/kanban/memory/transport/...），上限 64 字符 */
  scope: z.string().max(64),
  message: z.string(),
  /** 发送方时间戳（epoch ms）——仅 wire 完整性用，落盘 ts 由 Main 生成 */
  ts: z.number(),
  ctx: logCtxSchema.optional(),
});
export type LogEntryWire = z.infer<typeof logEntrySchema>;
