// 用途：应用配置模块（arch C10 起含活配置统一写入口）—— fs 读写 + 一行 parse（schema/边界/默认值单源于 @kanban/ipc-schema appConfigFileSchema，issue #68；spec J/G）+ LiveConfig（读活配置对象 / 写序先持久化后变异 / 字段级合并全量写回，config:set 与项目切换共用同一写序）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { LOG_LEVELS, appConfigFileSchema, type AppConfig, type LogLevel } from "@kanban/ipc-schema";

// 配置形状 re-export 单源（issue #68：main 内既有 "./config" import 路径不变；LoggingConfig 沿用 logger.ts 的 re-export 先例）
export type { AppConfig, AutoArchiveConfig, CliExeConfig, DiffConfig, LoggingConfig, ShutdownConfig, TerminalConfig } from "@kanban/ipc-schema";

/** 默认配置 = appConfigFileSchema.parse({})（各字段 .catch 默认值汇集，单源不再手抄） */
export function defaultConfig(): AppConfig {
  return appConfigFileSchema.parse({});
}

/** 读取配置：文件缺失/JSON 损坏/顶层非对象 → 整体回退默认；节与字段级非法回退由 schema 内 .catch 承担（字段级合并语义保持：一坏只牵连该字段，各节独立） */
export function loadConfig(path: string): AppConfig {
  if (!existsSync(path)) return defaultConfig();
  try {
    return appConfigFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return defaultConfig();
  }
}

/** 保存配置（自动创建父目录；graceMs 等数值经 schema int 校验后内存态恒为整数，落盘无小数） */
export function saveConfig(path: string, config: AppConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** 活配置读写器（main 侧统一配置写入口，arch C10）：get 恒返回同一内存引用；set 字段级合并、先持久化成功再变异内存 */
export interface LiveConfig {
  get(): AppConfig;
  /** 字段级合并写：先 saveConfig({...当前, ...patch})，成功后原地变异内存对象；写盘失败抛错且内存不动（内存与磁盘不分叉） */
  set(patch: Partial<AppConfig>): void;
}

/** 打开活配置：文件存在读入、缺失用默认并首写落盘（spec J：不硬编码、落应用数据目录）；此后 main 全生命周期读经 get 同一引用、写一律经 set（写序单点：config:set 与项目切换不再各自手抄） */
export function openLiveConfig(path: string): LiveConfig {
  const fresh = !existsSync(path);
  const config = fresh ? defaultConfig() : loadConfig(path);
  if (fresh) saveConfig(path, config); // 首次启动落默认（下次启动读入同值）
  return {
    get: () => config,
    set: (patch) => {
      // 写序：先持久化合并结果，成功后才变异内存对象（失败错误冒泡给调用方，内存与磁盘不分叉）
      saveConfig(path, { ...config, ...patch });
      Object.assign(config, patch);
    },
  };
}

/** #53（spec #52 D 节）：KANBAN_LOG_LEVEL env 覆盖 config 级别 —— 合法四枚举才覆盖，非法/未设回退 config 值；返回 effectiveLevel，不写进 appConfig（切换项目 saveConfig 全量写回时不误持久化，M11） */
export function resolveEffectiveLevel(configLevel: LogLevel, env: string | undefined): LogLevel {
  return typeof env === "string" && (LOG_LEVELS as readonly string[]).includes(env) ? (env as LogLevel) : configLevel;
}
