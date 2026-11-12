// 用途：斜杠派发判定纯函数（issue #92 / spec #82 E 块）—— 输入（命令目录快照 + 首 token + CLI）输出派发动作，与 React/store/IPC 解耦（PoC 结论矩阵：claude/opencode/fake=透传原文、codex=客户端读文件展开、未匹配原样、内置 /pty /kanban 本地执行且重名优先；fail-closed 只封「codex 无法判定/无法展开」，透传类 CLI 形态与匹配无关）
import type { CliKind, CommandEntry, ErrorCode } from "@kanban/ipc-schema";

/** 内置应用命令名（单源：菜单 slash-trigger.APP_SLASH_COMMANDS 的展示条目由此派生对齐，密封测试防漂移） */
export const APP_COMMAND_NAMES = ["pty", "kanban"] as const;
export type AppCommandName = (typeof APP_COMMAND_NAMES)[number];

/** 派发动作：透传发送 / codex 展开（读来源文件替换占位符后作普通文本发送）/ 内置本地执行 / fail-closed 拒绝 */
export type SlashDispatch =
  | { action: "send-text"; text: string }
  | { action: "expand"; name: string; args: string; sourcePath: string }
  | { action: "app"; app: AppCommandName }
  | { action: "blocked"; code: ErrorCode; message: string };

/** 切分斜杠调用：首 token 为命令名（/ 后至首个空白），余文为实参；非斜杠开头或仅 / 返回 null */
export function parseSlashInvocation(text: string): { name: string; args: string } | null {
  if (!text.startsWith("/")) return null;
  const rest = text.slice(1);
  const m = rest.match(/^\S+/);
  if (!m) return null;
  return { name: m[0], args: rest.slice(m[0].length).trim() };
}

export interface SlashDispatchInput {
  /** 完整输入文本（发送期判定，菜单接受只负责置入文本） */
  text: string;
  /** 目标会话 CLI（决定派发形态的路由键，与 wire 一致） */
  cli: CliKind;
  /** 该 (cli,cwd) 的命令目录快照（与菜单同源）；null=目录不可用（loading/error）——仅 codex 判定需要 */
  commands: CommandEntry[] | null;
}

/**
 * 派发判定（矩阵见 E-poc-results.md §4）：
 * 1. 非斜杠/未匹配 → send-text 原样（三 CLI 一致）；
 * 2. 内置 /pty /kanban → app 本地执行（优先于 CLI 目录同名命令；不依赖目录）；
 * 3. claude/opencode/fake 匹配 → send-text 透传原文（CLI 侧/适配器自行解析，userOnly 不改变形态）；
 * 4. codex 匹配 → expand（app-server 不解析 / 前缀，客户端读 sourcePath 展开）；目录不可用或无来源文件 → blocked（fail-closed，不静默发原文）。
 */
export function resolveSlashDispatch(input: SlashDispatchInput): SlashDispatch {
  const invocation = parseSlashInvocation(input.text);
  if (!invocation) return { action: "send-text", text: input.text };
  const lower = invocation.name.toLowerCase();
  // 内置优先（重名时 CLI 同名命令不可达，菜单分组标注来源区分）
  if ((APP_COMMAND_NAMES as readonly string[]).includes(lower)) return { action: "app", app: lower as AppCommandName };
  if (input.cli !== "codex") return { action: "send-text", text: input.text }; // 透传类：匹配与否形态一致
  if (input.commands === null)
    return { action: "blocked", code: "E_INTERNAL", message: `命令目录不可用，无法判定 /${invocation.name} 是否为已知命令（已拒绝发送）` };
  const entry = input.commands.find((c) => c.name.toLowerCase() === lower);
  if (!entry) return { action: "send-text", text: input.text }; // 未匹配：原样发送
  if (!entry.sourcePath)
    return { action: "blocked", code: "E_INTERNAL", message: `命令 /${entry.name} 无来源文件，无法展开（已拒绝发送）` };
  return { action: "expand", name: entry.name, args: invocation.args, sourcePath: entry.sourcePath };
}
