// 用途：解析真实 opencode 可执行文件路径（spawn 直连目标，不经 .cmd shim / PATH 兜底；spec G 通用决策，npm 全局优先）
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** 解析优先级：手动覆盖（config cliExe.opencode）→ env KANBAN_OPENCODE_BIN → npm 全局 → 原生安装目录 → where/which 显式解析 */
export interface OpenCodeExeOptions {
  manualOverride?: string | null;
}

/** 经 npm root -g 定位全局安装根（win32 下 npm 是 .cmd，经 ComSpec 执行；与 claude/exe.ts 同链路） */
function npmRootGlobal(): string {
  if (process.platform === "win32") {
    return execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm root -g"], {
      encoding: "utf8",
    }).trim();
  }
  return execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
}

/** 经 PATH 显式解析可执行文件绝对路径（只用于「找到路径」，spawn 仍直连该绝对路径） */
function fromPathLookup(): string | null {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, ["opencode"], { encoding: "utf8" }).trim();
    for (const line of out.split(/\r?\n/).filter(Boolean)) {
      // where 可能返回多行（.cmd/.exe/…），优先真实 exe，其次非 .cmd shim 的可执行（posix 无扩展名）
      if (existsSync(line) && !line.toLowerCase().endsWith(".cmd")) return line;
    }
    return null;
  } catch {
    return null;
  }
}

/** 原生安装形态：Windows 安装器布局 %LOCALAPPDATA%\Programs\opencode\opencode.exe（工单指定直连目标） */
function nativeInstallPath(): string | null {
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  const exe = path.join(local, "Programs", "opencode", "opencode.exe");
  return existsSync(exe) ? exe : null;
}

/**
 * 解析 opencode 真实 exe：找不到时抛错（含已尝试路径与覆盖方法，失败可定位）。
 * npm 全局优先于原生安装：npm 1.19.5 为 poc-3 实测版本且与用户真实 opencode DB 兼容；
 * 原生安装（1.15.7）对 1.19.5 时代的用户 DB migration 失败（启动挂死，e2e 前探针实证）。
 * shortcut: 用户升级原生安装到 ≥1.19.5 后可复查优先级；复查触发条件 = 原生版本号追平 npm 版本。
 */
export function resolveOpenCodeExe(options: OpenCodeExeOptions = {}): string {
  const tried: string[] = [];
  // 1) config 手动覆盖
  if (options.manualOverride) {
    if (existsSync(options.manualOverride)) return options.manualOverride;
    tried.push(`手动覆盖 ${options.manualOverride}（不存在）`);
  }
  // 2) env 覆盖（测试/特殊环境；CliHostClient 经 env 传给 worker）
  if (process.env.KANBAN_OPENCODE_BIN) {
    if (existsSync(process.env.KANBAN_OPENCODE_BIN)) return process.env.KANBAN_OPENCODE_BIN;
    tried.push(`KANBAN_OPENCODE_BIN=${process.env.KANBAN_OPENCODE_BIN}（不存在）`);
  }
  // 3) npm 全局 opencode-ai/bin/opencode.exe（poc-3 实测形态；DB 版本兼容）
  try {
    const root = npmRootGlobal();
    const bin = process.platform === "win32" ? "opencode.exe" : "opencode";
    const exe = path.join(root, "opencode-ai", "bin", bin);
    if (existsSync(exe)) return exe;
    tried.push(`npm 全局 ${exe} 不存在`);
  } catch (e) {
    tried.push(`npm root -g 探测失败：${e instanceof Error ? e.message : String(e)}`);
  }
  // 4) 原生安装目录（win32 安装器布局；注意 DB 版本兼容问题见函数注释）
  const native = nativeInstallPath();
  if (native) return native;
  tried.push("原生安装目录 %LOCALAPPDATA%\\Programs\\opencode\\opencode.exe 不存在");
  // 5) where/which 显式解析（不采用 .cmd shim）
  const looked = fromPathLookup();
  if (looked) return looked;
  tried.push("where/which 未解析到 opencode 可执行文件（.cmd shim 不采用）");
  throw new Error(
    `未找到 opencode 可执行文件（已尝试：${tried.join("；")}）。请在设置中手动指定 opencode.exe 路径或设置 KANBAN_OPENCODE_BIN。`,
  );
}
