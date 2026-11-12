// 用途：cli:status wire 契约（issue #80，spec #75 实现决策 3/7）—— 三真实 CLI 安装状态聚合查询（独立顶层通道，对齐 diff:ipc 单成员先例）：fake 演示与 pty 终端恒可用不经探测，不出现在结果中；「＋」新建菜单两处共享禁用逻辑的数据源
import { z } from "zod";
import { errorCodeSchema } from "./ipc";

/** 经 exe 探测链判定安装状态的三真实 CLI（fake/pty 恒可用，不入本面） */
export const realCliKindSchema = z.enum(["codex", "claude", "opencode"]);
export type RealCliKind = z.infer<typeof realCliKindSchema>;

/** 三真实 CLI 安装状态（true=已装，false=未装；未装结果不缓存——重开菜单即重探） */
export const cliInstalledMapSchema = z.object({
  codex: z.boolean(),
  claude: z.boolean(),
  opencode: z.boolean(),
});
export type CliInstalledMap = z.infer<typeof cliInstalledMapSchema>;

// cli:status 请求单通道联合（后续 CLI 域查询可在此扩成员，对齐 diff:get 先例）
export const cliStatusRequestSchema = z.discriminatedUnion("channel", [
  /** 三 CLI 安装状态聚合查询（「＋」菜单打开时拉取；已装进程内缓存、未装每次重探） */
  z.object({ channel: z.literal("cli:status") }),
]);
export type CliStatusRequest = z.infer<typeof cliStatusRequestSchema>;

// IPC 错误信封（入站不合契约 E_SCHEMA / 探测意外异常 E_INTERNAL —— 复用全局错误码形状，不新增）
const cliStatusIpcErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: errorCodeSchema, message: z.string() }),
});

// cli:status 结果：成功（三 CLI 安装状态）∪ IPC 错误信封
export const cliStatusResultSchema = z.union([
  z.object({ ok: z.literal(true), installed: cliInstalledMapSchema }),
  cliStatusIpcErrorSchema,
]);
export type CliStatusResult = z.infer<typeof cliStatusResultSchema>;
