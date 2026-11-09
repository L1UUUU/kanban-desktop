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

/** Diff 视图截断保护上限（#47，spec #40 E 节/F8：三类上限数值进配置不硬编码；超限置 truncated、剩余文件仅列名） */
export interface DiffConfig {
  /** git diff/status 采集 stdout 总字节上限（超出停止采集并终止 git 进程） */
  maxBytes: number;
  /** 文件数上限（窗口外文件仅列名，不采集/不展开 hunks） */
  maxFiles: number;
  /** 单个 untracked 新文件全文展示的行数上限 */
  maxUntrackedLines: number;
}

/** diff 上限各字段的防御上限（防配置写 absurd 值导致主进程超大缓冲） */
const DIFF_LIMIT_BOUNDS = { maxBytes: 100_000_000, maxFiles: 100_000, maxUntrackedLines: 1_000_000 } as const;

export interface AppConfig {
  cliExe: CliExeConfig;
  /** 当前项目 id（项目注册/切换时持久化，重启恢复；null=尚无项目） */
  currentProjectId: string | null;
  /** #43：git 可执行手动覆盖路径（最高优先；null=未覆盖走 where 探测；解析失败 diff 面归 git-missing） */
  gitExe: string | null;
  diff: DiffConfig;
  terminal: TerminalConfig;
  shutdown: ShutdownConfig;
}

/** 默认配置：三 CLI exe 均为占位 null；diff 上限 2MB/200 文件/2000 行（覆盖日常大改动的审阅量级） */
export function defaultConfig(): AppConfig {
  return {
    cliExe: { codex: null, claude: null, opencode: null },
    currentProjectId: null,
    gitExe: null,
    diff: { maxBytes: 2_000_000, maxFiles: 200, maxUntrackedLines: 2000 },
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
  const gitExe = (raw as { gitExe?: unknown }).gitExe;
  if (typeof gitExe === "string" && gitExe.length > 0) fallback.gitExe = gitExe;
  const fileDiff = (raw as { diff?: Record<string, unknown> }).diff;
  if (typeof fileDiff === "object" && fileDiff !== null) {
    for (const key of ["maxBytes", "maxFiles", "maxUntrackedLines"] as const) {
      const v = fileDiff[key];
      // 正整数且不超防御上限才采纳（对齐 graceMs 的不信任文件数值惯例）
      if (typeof v === "number" && Number.isInteger(v) && v > 0 && v <= DIFF_LIMIT_BOUNDS[key]) {
        fallback.diff[key] = v;
      }
    }
  }
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
