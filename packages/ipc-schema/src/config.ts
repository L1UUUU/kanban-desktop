// 用途：config wire 契约（issue #61，spec #57 配置链路节）—— config:ipc 独立单通道二请求（对齐 diff:ipc 先例，不并入 ipcOkSchema 可选字段大杂烩）+ autoArchive 边界单源（1–365 整数，主进程 config 读入侧复用同一常量）；读写结果均只携带 autoArchive 子集，不暴露项目/CLI 路径等其余配置字段
import { z } from "zod";
import { errorCodeSchema } from "./ipc";

/** 自动归档天数边界（spec #57：1–365 整数；单源供 schema 与主进程 loadConfig 校验共用） */
export const AUTO_ARCHIVE_DAYS_BOUNDS = { min: 1, max: 365 } as const;

// 自动归档配置节（enabled 默认关、days 默认 30 由主进程 defaultConfig 定义；wire 只约束形状与边界）
export const autoArchiveConfigSchema = z.object({
  enabled: z.boolean(),
  days: z.number().int().min(AUTO_ARCHIVE_DAYS_BOUNDS.min).max(AUTO_ARCHIVE_DAYS_BOUNDS.max),
});
export type AutoArchiveConfig = z.infer<typeof autoArchiveConfigSchema>;

/** #64：上次自动归档扫描摘要（主进程缓存；config:get/成功 set 应答携带，设置区反馈位数据源） */
export const autoArchiveScanSummarySchema = z.object({
  /** 本次扫描实际归档条数 */
  archived: z.number().int().min(0),
  /** 归档失败条数（单条失败不影响其余，日志可查） */
  failed: z.number().int().min(0),
});
export type AutoArchiveScanSummary = z.infer<typeof autoArchiveScanSummarySchema>;

// config:ipc 请求单通道联合（读 = 全量 autoArchive 子集；写 = 仅接受该子集，多余字段被剥离不落 config）
export const configRequestSchema = z.discriminatedUnion("channel", [
  /** 读取当前 autoArchive 配置（设置面板打开时拉取初始值） */
  z.object({ channel: z.literal("config:get") }),
  /** 保存 autoArchive 配置（字段级合并进主进程内存配置对象，不触碰项目/CLI 路径等其它字段） */
  z.object({ channel: z.literal("config:set"), autoArchive: autoArchiveConfigSchema }),
]);
export type ConfigRequest = z.infer<typeof configRequestSchema>;

// IPC 错误信封（入站不合契约 E_SCHEMA / 写盘失败 E_INTERNAL —— 复用全局错误码形状，不新增）
const configIpcErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: errorCodeSchema, message: z.string() }),
});

// config:ipc 结果：成功（autoArchive 生效子集 + lastScan 上次扫描摘要，get/set 共用；null=尚未扫描）∪ IPC 错误信封（写盘失败新值不生效时 set 亦回此形态）
export const configResultSchema = z.union([
  z.object({ ok: z.literal(true), autoArchive: autoArchiveConfigSchema, lastScan: autoArchiveScanSummarySchema.nullable() }),
  configIpcErrorSchema,
]);
export type ConfigResult = z.infer<typeof configResultSchema>;
