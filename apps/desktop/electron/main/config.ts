// 用途：应用配置加载/保存 —— 三 CLI exe 路径等用户配置统一落 JSON 文件，不硬编码（spec J/G）；探测逻辑为占位，由后续 Adapter 工单接入
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 三 CLI exe 配置：null = 未探测/未手动覆盖 */
export interface CliExeConfig {
  codex: string | null;
  claude: string | null;
  opencode: string | null;
}

/** 终端配置：shell=null 自动探测（pwsh→powershell→cmd）；不硬编码默认 shell */
export interface TerminalConfig {
  shell: string | null;
}

/** 退出序列配置（spec H：有限等待/受控终止的时长参数，不硬编码） */
export interface ShutdownConfig {
  /** 活跃会话有序取消后的有限等待上限 ms（等待各会话离开 running/waiting；缺省 3000） */
  graceMs: number;
}

export interface AppConfig {
  cliExe: CliExeConfig;
  /** 当前项目 id（项目注册/切换时持久化，重启恢复；null=尚无项目） */
  currentProjectId: string | null;
  terminal: TerminalConfig;
  shutdown: ShutdownConfig;
}

/** 默认配置：三 CLI exe 均为占位 null；终端 shell 自动探测；退出等待 3s */
export function defaultConfig(): AppConfig {
  return {
    cliExe: { codex: null, claude: null, opencode: null },
    currentProjectId: null,
    terminal: { shell: null },
    shutdown: { graceMs: 3000 },
  };
}

const CLI_KEYS = ["codex", "claude", "opencode"] as const;

/** 读取配置：文件缺失/损坏/字段非法时回退默认值，合法的手动覆盖保留（各节独立合并，一节损坏不牵连其余） */
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
  if (typeof fileCli === "object" && fileCli !== null) {
    for (const key of CLI_KEYS) {
      const v = fileCli[key];
      if (typeof v === "string" && v.length > 0) fallback.cliExe[key] = v;
    }
  }
  const current = (raw as { currentProjectId?: unknown }).currentProjectId;
  if (typeof current === "string" && current.length > 0) fallback.currentProjectId = current;
  const termShell = (raw as { terminal?: { shell?: unknown } }).terminal?.shell;
  if (typeof termShell === "string" && termShell.length > 0) fallback.terminal.shell = termShell;
  const graceMs = (raw as { shutdown?: { graceMs?: unknown } }).shutdown?.graceMs;
  if (typeof graceMs === "number" && Number.isFinite(graceMs) && graceMs > 0 && graceMs <= 60_000) {
    fallback.shutdown.graceMs = Math.floor(graceMs);
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
