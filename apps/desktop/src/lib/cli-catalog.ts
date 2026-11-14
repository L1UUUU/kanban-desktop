// 用途：CLI 展示目录（渲染端）—— 色点/「＋」菜单收录由单一目录表派生，新增 CLI 只改本表（键完备受 CliKind 约束）；
// 显示名单源在 @kanban/ipc-schema（arch C8：main 新会话默认标题与渲染端展示同源，本表仅引用不复制）
import { CLI_LABELS, type CliKind } from "@kanban/ipc-schema";

/** 目录条目：一个 CLI 的全部渲染端展示属性 */
export interface CliCatalogEntry {
  cli: CliKind;
  /** 显示名（错误卡标题/归档行/消息发送者标签；值取自 ipc-schema 单源表） */
  label: string;
  /** 色点 tailwind 类（原型四色；fake 演示用 accent2 蓝） */
  dotCls: string;
  /** 是否进「＋」新建菜单（codex/claude/opencode 三真实 CLI；fake 仅演示链路不列） */
  inNewMenu: boolean;
}

// 目录主表：Record 键完备 → CliKind 加成员而漏配时编译报错；条目顺序即「＋」菜单顺序（codex/claude/opencode）
const CATALOG_BY_CLI: Record<CliKind, CliCatalogEntry> = {
  codex: { cli: "codex", label: CLI_LABELS.codex, dotCls: "bg-codex", inNewMenu: true },
  claude: { cli: "claude", label: CLI_LABELS.claude, dotCls: "bg-claude", inNewMenu: true },
  opencode: { cli: "opencode", label: CLI_LABELS.opencode, dotCls: "bg-opencode", inNewMenu: true },
  fake: { cli: "fake", label: CLI_LABELS.fake, dotCls: "bg-accent2", inNewMenu: false },
};

/** 目录条目列表（主表顺序） */
export const CLI_CATALOG: readonly CliCatalogEntry[] = Object.values(CATALOG_BY_CLI);

// CLI 显示名单源 re-export（@kanban/ipc-schema；保持既有 import 面不变）
export { CLI_LABELS };

/** CLI 色点类（会话行/归档行/关联区；pty 终端为目录外会话类型，另行并入 pty 色） */
export const CLI_DOT_CLS: Record<string, string> = {
  ...Object.fromEntries(CLI_CATALOG.map((e) => [e.cli, e.dotCls])),
  pty: "bg-pty",
};

/** 「＋」新建菜单收录的 CLI（目录顺序：codex/claude/opencode） */
export const NEW_MENU_CLIS: readonly CliCatalogEntry[] = CLI_CATALOG.filter((e) => e.inNewMenu);

// 会话域 cli 词表超集：pty 终端 + tracker 侧 claude-code 别名（目录表外，不属 CliKind）
const SESSION_EXTRA_LABELS: Record<string, string> = { pty: "PTY", "claude-code": "Claude" };
const SESSION_LABELS: Record<string, string> = { ...CLI_LABELS, ...SESSION_EXTRA_LABELS };

/** 会话 cli → 显示名（含 pty 终端与 tracker 词表 claude-code 别名；未知原样返回） */
export function sessionCliLabel(cli: string): string {
  return SESSION_LABELS[cli] ?? cli;
}
