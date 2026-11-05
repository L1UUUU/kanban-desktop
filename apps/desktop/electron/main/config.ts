// 用途：应用配置加载/保存 —— 三 CLI exe 路径等用户配置统一落 JSON 文件，不硬编码（spec J/G）；探测逻辑为占位，由后续 Adapter 工单接入
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 三 CLI exe 配置：null = 未探测/未手动覆盖 */
export interface CliExeConfig {
  codex: string | null;
  claude: string | null;
  opencode: string | null;
}

export interface AppConfig {
  cliExe: CliExeConfig;
}

/** 默认配置：三 CLI exe 均为占位 null */
export function defaultConfig(): AppConfig {
  return { cliExe: { codex: null, claude: null, opencode: null } };
}

const CLI_KEYS = ["codex", "claude", "opencode"] as const;

/** 读取配置：文件缺失/损坏/字段非法时回退默认值，合法的手动覆盖保留 */
export function loadConfig(path: string): AppConfig {
  const fallback = defaultConfig();
  if (!existsSync(path)) return fallback;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
  if (typeof raw !== "object" || raw === null) return fallback;
  const fileCli = (raw as { cliExe?: Record<string, unknown> }).cliExe;
  if (typeof fileCli !== "object" || fileCli === null) return fallback;
  for (const key of CLI_KEYS) {
    const v = fileCli[key];
    if (typeof v === "string" && v.length > 0) fallback.cliExe[key] = v;
  }
  return fallback;
}

/** 保存配置（自动创建父目录） */
export function saveConfig(path: string, config: AppConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** 三 CLI exe 探测占位：真实探测（PATH / npm 全局目录 / 手动覆盖 UI）由后续 Adapter 工单接入（spec G） */
export function detectCliExe(): CliExeConfig {
  return defaultConfig().cliExe;
}
