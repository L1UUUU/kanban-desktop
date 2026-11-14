// 用途：CLI 种类枚举单源（会话/模型目录/命令目录等跨域 wire 契约共用；自 ipc.ts 拆出避免域文件间的模块环——commands.ts 与 ipc.ts 互相引用同一运行时值）
import { z } from "zod";

// 会话 CLI 枚举（#7 起放开三 CLI；fake 为 #6 演示链路；pty 会话不经 session:create 建）
export const cliKindSchema = z.enum(["fake", "codex", "claude", "opencode"]);
export type CliKind = z.infer<typeof cliKindSchema>;

/** CLI 显示名（arch C8 双端单源：main 新会话默认标题与 renderer 展示目录共用；Record 键完备 → 枚举扩员漏配即编译报错） */
export const CLI_LABELS: Record<CliKind, string> = {
  fake: "Fake",
  codex: "Codex",
  claude: "Claude",
  opencode: "OpenCode",
};

/** 新建会话默认标题（ADR 0003 default 态占位名，arch C8 单一构造点）：main 入库兜底与 renderer 草稿提示行派生同源，双端不得各自拼接 */
export function defaultSessionTitle(cli: CliKind): string {
  return `新会话 · ${CLI_LABELS[cli]}`;
}
