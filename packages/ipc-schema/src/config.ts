// 用途：配置契约双职责 —— ① config wire 契约（issue #61，spec #57 配置链路节）：config:ipc 独立单通道二请求（对齐 diff:ipc 先例）+ autoArchive 边界单源（1–365 整数）；读写结果均只携带 autoArchive 子集，不暴露项目/CLI 路径等其余配置字段；② config.json 文件格式契约（issue #68）：全部配置节 file schema 单源（边界与默认值同居），main/config.ts 瘦身为 fs 读写 + 一行 parse
import { z } from "zod";
import { errorCodeSchema } from "./ipc";
import { logLevelSchema } from "./log";

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

// ── config.json 文件格式契约（issue #68）：宽松合并语义 —— 非法字段静默回退默认（与 wire 契约的严格拒绝互补）──

/** 非空字符串：空串视同未设置（cliExe 各键 / gitExe / currentProjectId / terminal.shell 共用） */
const nonEmptyString = z.string().min(1);

/** 三 CLI exe 节（null = 未探测/未手动覆盖）；字段级 catch = 缺失/类型错/空串均回退 null */
export const cliExeConfigSchema = z.object({
  codex: nonEmptyString.nullable().catch(null),
  claude: nonEmptyString.nullable().catch(null),
  opencode: nonEmptyString.nullable().catch(null),
});
export type CliExeConfig = z.infer<typeof cliExeConfigSchema>;

/** diff 上限各字段的防御上限（防配置写 absurd 值导致主进程超大缓冲；#47 spec #40 E 节） */
export const DIFF_LIMIT_BOUNDS = { maxBytes: 100_000_000, maxFiles: 100_000, maxUntrackedLines: 1_000_000 } as const;

/** diff 截断保护节（#47：三类上限数值进配置不硬编码；正整数且不超防御上限才采纳，默认 2MB/200 文件/2000 行） */
export const diffConfigSchema = z.object({
  maxBytes: z.number().int().min(1).max(DIFF_LIMIT_BOUNDS.maxBytes).catch(2_000_000),
  maxFiles: z.number().int().min(1).max(DIFF_LIMIT_BOUNDS.maxFiles).catch(200),
  maxUntrackedLines: z.number().int().min(1).max(DIFF_LIMIT_BOUNDS.maxUntrackedLines).catch(2000),
});
export type DiffConfig = z.infer<typeof diffConfigSchema>;

/** 终端节：shell=null 自动探测（pwsh→powershell→cmd），不硬编码默认 shell */
export const terminalConfigSchema = z.object({
  shell: nonEmptyString.nullable().catch(null),
});
export type TerminalConfig = z.infer<typeof terminalConfigSchema>;

/** 退出序列节（spec H）：graceMs 正整数、上限 60_000，默认 3000；非整数回退默认而非 floor 采纳（issue #68 语义收紧——config.json 只由 saveConfig 整数落盘，收紧无实际影响） */
export const shutdownConfigSchema = z.object({
  graceMs: z.number().int().positive().max(60_000).catch(3000),
});
export type ShutdownConfig = z.infer<typeof shutdownConfigSchema>;

/** logging 数值字段的防御边界：下限防过小值致每条切文件/删当前文件/消息全空，上限防 absurd 值（spec #52 D 节；retainRuns 范围 1–100） */
export const LOGGING_BOUNDS = {
  maxFileBytes: { min: 1024, max: 100_000_000 },
  retainRuns: { min: 1, max: 100 },
  maxMessageChars: { min: 1, max: 1_000_000 },
} as const;

/** logging 节（spec #52 D 节四参数：level 四枚举默认 info / 5MB / 10 次启动 / 单条 2000 字符） */
export const loggingConfigSchema = z.object({
  level: logLevelSchema.catch("info"),
  maxFileBytes: z
    .number()
    .int()
    .min(LOGGING_BOUNDS.maxFileBytes.min)
    .max(LOGGING_BOUNDS.maxFileBytes.max)
    .catch(5_000_000),
  retainRuns: z.number().int().min(LOGGING_BOUNDS.retainRuns.min).max(LOGGING_BOUNDS.retainRuns.max).catch(10),
  maxMessageChars: z
    .number()
    .int()
    .min(LOGGING_BOUNDS.maxMessageChars.min)
    .max(LOGGING_BOUNDS.maxMessageChars.max)
    .catch(2000),
});
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;

/** 节级 catch 帮助函数：节缺失/非对象 → 整节默认（parse({}) 汇集各字段 .catch 默认，默认值单一来源）；节内坏字段由字段级 .catch 单独回退（保持字段级合并语义：一坏只牵连该字段） */
const sectioned = <T extends z.ZodType>(schema: T) => schema.catch(schema.parse({}));

/** config.json 文件格式全契约：顶层字段非法回退默认；autoArchive 节用宽松版（字段级回退），wire 的 autoArchiveConfigSchema 保持严格拒绝 */
export const appConfigFileSchema = z.object({
  cliExe: sectioned(cliExeConfigSchema),
  /** 当前项目 id（项目注册/切换时持久化，重启恢复；null=尚无项目） */
  currentProjectId: nonEmptyString.nullable().catch(null),
  /** git 可执行手动覆盖路径（最高优先；null=未覆盖走 where 探测） */
  gitExe: nonEmptyString.nullable().catch(null),
  diff: sectioned(diffConfigSchema),
  terminal: sectioned(terminalConfigSchema),
  shutdown: sectioned(shutdownConfigSchema),
  logging: sectioned(loggingConfigSchema),
  autoArchive: sectioned(
    z.object({
      enabled: z.boolean().catch(false),
      days: z.number().int().min(AUTO_ARCHIVE_DAYS_BOUNDS.min).max(AUTO_ARCHIVE_DAYS_BOUNDS.max).catch(30),
    }),
  ),
});
export type AppConfig = z.infer<typeof appConfigFileSchema>;
