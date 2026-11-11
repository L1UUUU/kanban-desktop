// 用途：三源错误码 → 四类 ErrorKind + unknown 兜底的纯函数分类（#46 / spec #40 A 节）——输入域 = ① ChatEvent session_error 六枚举 ② renderer 合成码（E_SESSION_EXIT）③ IPC 错误码（含 #46 协议级 E_SPAWN_NOT_FOUND）；不吞错：无法归类的 code 一律 unknown，原文由卡面保留展示

/** 错误四类（US 9–12）+ unknown 兜底（US 13：未识别类型保留原始 code 与 message 原文） */
export type ErrorKind = "cli_exit" | "auth_expired" | "spawn_not_found" | "protocol_disconnect" | "unknown";

/** code → kind 映射表（显式列举三源全部已知成员；枚举演进时此处同步） */
const KIND_BY_CODE: Record<string, ErrorKind> = {
  // 源 ①：ChatEvent session_error 六成员闭枚举（#41）
  AUTH_EXPIRED: "auth_expired",
  SPAWN_NOT_FOUND: "spawn_not_found",
  PROTOCOL_DISCONNECT: "protocol_disconnect",
  CLI_EXIT: "cli_exit",
  // 源 ②：renderer 合成码（chat-store session_exit 处理合成；不进 ChatEvent schema——F1/F4）
  E_SESSION_EXIT: "cli_exit",
  // 源 ③：IPC 错误码（session:create / sendTurn / resume 结果；spawn 失败协议级映射）
  E_SPAWN_NOT_FOUND: "spawn_not_found",
};

/** 分类主函数：未列举的 code（INTERNAL/UNKNOWN/E_SCHEMA/E_INTERNAL/…及任意字符串）落 unknown 兜底 */
export function classifyError(code: string): ErrorKind {
  return KIND_BY_CODE[code] ?? "unknown";
}

/** CLI 显示名（错误卡标题「找不到 CLI 程序（Claude）」、设置面板归档行 meta 等共用；含 pty 终端） */
export const CLI_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  opencode: "OpenCode",
  fake: "Fake",
  pty: "PTY",
};

/**
 * 认证失效卡按 CLI 给出的具体登录指引命令（US 10；文案依据 docs/acceptance/stage4/auth-samples.md 与各 CLI 实际命令）。
 * claude 为两步（启动 CLI 后在会话内 /login）；fake/未知 CLI 返回空数组（卡面不渲染命令块）。
 */
export function authLoginCommand(cli: string): string[] {
  if (cli === "codex") return ["codex login"];
  if (cli === "claude") return ["claude", "/login（进入 claude 后输入）"];
  if (cli === "opencode") return ["opencode auth login"];
  return [];
}
