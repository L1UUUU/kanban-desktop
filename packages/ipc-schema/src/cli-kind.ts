// 用途：CLI 种类枚举单源（会话/模型目录/命令目录等跨域 wire 契约共用；自 ipc.ts 拆出避免域文件间的模块环——commands.ts 与 ipc.ts 互相引用同一运行时值）
import { z } from "zod";

// 会话 CLI 枚举（#7 起放开三 CLI；fake 为 #6 演示链路；pty 会话不经 session:create 建）
export const cliKindSchema = z.enum(["fake", "codex", "claude", "opencode"]);
export type CliKind = z.infer<typeof cliKindSchema>;
