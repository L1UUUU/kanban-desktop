// 用途：斜杠触发检测与菜单纯逻辑（issue #90 / spec #82 E 块）—— 首 token 触发/过滤分组/补全替换/高亮环移全部纯函数，与 React 和 IME 时序解耦（IME 合成冻结由调用方传标志驱动，见 use-slash-menu）
import type { CliKind, CommandEntry } from "@kanban/ipc-schema";

/** token 边界字符（空白一族；与 PI composer-trigger 的 WHITESPACE 集一致） */
const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

/** 活跃 slash 触发：光标所在 token 的几何信息（tokenStart 指向 / 字符本身） */
export interface SlashTrigger {
  /** 过滤关键词（/ 与光标之间；空=不过滤全量展示） */
  query: string;
  /** token 起始下标（首 token 恒 0；保留字段供补全替换定位） */
  tokenStart: number;
  /** token 结束下标（其后首个空白字符） */
  tokenEnd: number;
}

/**
 * 触发检测：首个 token 以 / 开头且光标位于 / 之后（含尾随边界位）才激活；
 * 后继 slash token 不触发（应用命令只在草稿开头引用一次）。
 */
export function detectSlashTrigger(value: string, cursor: number): SlashTrigger | null {
  if (cursor <= 0 || cursor > value.length) return null;
  let start = cursor;
  while (start > 0 && !WHITESPACE.has(value[start - 1])) start -= 1;
  if (start !== 0 || value[0] !== "/") return null;
  let end = cursor;
  while (end < value.length && !WHITESPACE.has(value[end])) end += 1;
  return { query: value.slice(1, cursor), tokenStart: 0, tokenEnd: end };
}

/** 菜单条目视图：分组=应用命令（内置 /pty /kanban，本地执行留 #92）在前、CLI 命令（列举通道）在后 */
export interface MenuCommand {
  /** 命令名（不带 / 前缀；菜单展示与补全匹配键） */
  name: string;
  description: string;
  /** 参数提示（如 codex prompt 的 $ARGUMENTS 占位说明；无提示为 null） */
  argsHint: string | null;
  /** 仅用户调用标记（菜单可示；行为语义在派发层 #92 消费） */
  userOnly: boolean;
  group: "app" | "cli";
  /** CLI 命令的来源 CLI（应用命令无） */
  cli?: CliKind;
}

/** 内置应用命令（#90 只入菜单展示；本地执行接线在 #92：/pty 开终端草稿、/kanban 切看板视图） */
export const APP_SLASH_COMMANDS: MenuCommand[] = [
  { name: "pty", description: "打开 PTY 终端", argsHint: null, userOnly: false, group: "app" },
  { name: "kanban", description: "切换到看板视图", argsHint: null, userOnly: false, group: "app" },
];

/** 通道列举条目 → 菜单条目（cli 组标记 + 透传展示字段） */
export function toMenuCommand(entry: CommandEntry): MenuCommand {
  return { name: entry.name, description: entry.description, argsHint: entry.argsHint, userOnly: entry.userOnly, group: "cli", cli: entry.cli };
}

/** 分组顺序常量：应用命令组在前、CLI 命令组在后 */
export const MENU_GROUP_ORDER: Record<MenuCommand["group"], number> = { app: 0, cli: 1 };

/** 匹配得分（小者优）：0=名称前缀 < 1=名称子串 < 2=名称子序列（模糊） < 3=描述包含；不命中返回 null */
function scoreCommand(cmd: MenuCommand, q: string): number | null {
  const name = cmd.name.toLowerCase();
  if (name.startsWith(q)) return 0;
  if (name.includes(q)) return 1;
  // 子序列模糊：query 各字符按序出现在名称中（fzf 风格）
  let at = 0;
  for (const ch of q) {
    at = name.indexOf(ch, at);
    if (at === -1) {
      at = -1;
      break;
    }
    at += 1;
  }
  if (at !== -1) return 2;
  if (cmd.description.toLowerCase().includes(q)) return 3;
  return null;
}

/** 过滤排序：空 query 全量；命中按（分组序，得分，名称）排序——组内前缀命中优先于模糊/描述命中 */
export function filterSlashCommands(items: MenuCommand[], query: string): MenuCommand[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...items].sort((a, b) => MENU_GROUP_ORDER[a.group] - MENU_GROUP_ORDER[b.group] || a.name.localeCompare(b.name));
  const scored: Array<{ cmd: MenuCommand; score: number }> = [];
  for (const cmd of items) {
    const score = scoreCommand(cmd, q);
    if (score !== null) scored.push({ cmd, score });
  }
  return scored
    .sort((a, b) => MENU_GROUP_ORDER[a.cmd.group] - MENU_GROUP_ORDER[b.cmd.group] || a.score - b.score || a.cmd.name.localeCompare(b.cmd.name))
    .map((s) => s.cmd);
}

/** 补全接受：替换 [tokenStart, tokenEnd) 为 `/name `（尾随空格进入实参位），返回新草稿与光标 */
export function applySlashCompletion(value: string, trigger: SlashTrigger, name: string): { value: string; cursor: number } {
  const insert = `/${name} `;
  return {
    value: value.slice(0, trigger.tokenStart) + insert + value.slice(trigger.tokenEnd),
    cursor: trigger.tokenStart + insert.length,
  };
}

/** ↑↓ 循环高亮：负 delta 环绕到尾、越尾环回 0；空列表恒 0 */
export function nextSlashHighlight(current: number, count: number, delta: 1 | -1): number {
  if (count <= 0) return 0;
  return (current + delta + count) % count;
}

/** Esc 关闭记忆键：token 起止定位 + 内容（token 改变即换键，菜单重新弹出） */
export function slashDismissKey(value: string, trigger: SlashTrigger): string {
  return `${trigger.tokenStart}:${value.slice(trigger.tokenStart, trigger.tokenEnd)}`;
}
