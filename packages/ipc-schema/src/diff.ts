// 用途：diff wire 契约（issue #43/#47，spec #40 A/D/E 节）—— diff:ipc 独立单通道（对齐 memory:ipc 先例，不并入 ipcOkSchema 可选字段大杂烩）+ 工作区 diff 结果三级行状（文件/hunk/行）+ 四档错误闭枚举 + 全局 truncated 标志（三类上限任一超限即 true：采集总字节/文件数/untracked 行数，剩余文件仅列名）
import { z } from "zod";
import { errorCodeSchema } from "./ipc";

// 变更类型（与 git-diff-service 解析口径对齐：status XY 归类 + untracked；renamed 含 copied）
export const diffChangeTypeSchema = z.enum(["modified", "added", "deleted", "renamed", "untracked"]);
export type DiffChangeType = z.infer<typeof diffChangeTypeSchema>;

// diff 行（kind 判别：上下文灰 / 新增绿 / 删除红；text 为去掉 +/-/空白前缀后的正文）
export const diffLineSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("context"), text: z.string() }),
  z.object({ kind: z.literal("add"), text: z.string() }),
  z.object({ kind: z.literal("del"), text: z.string() }),
]);
export type DiffLine = z.infer<typeof diffLineSchema>;

// hunk（header 为 @@ 行原文；untracked 全文展示 #47 复用本形状）
export const diffHunkSchema = z.object({
  header: z.string().min(1),
  lines: z.array(diffLineSchema),
});
export type DiffHunk = z.infer<typeof diffHunkSchema>;

// 文件行（additions/deletions 供行级 +N/-N 统计；binary=true 时 hunks 为 null；untracked 全文承载于 hunks（#47），截断窗口外/读取失败/二进制为 null）
export const diffFileRowSchema = z.object({
  path: z.string().min(1),
  changeType: diffChangeTypeSchema,
  binary: z.boolean(),
  /** renamed 的原路径；其余为 null */
  oldPath: z.string().min(1).nullable(),
  /** 行级 hunks；binary/untracked（本票）为 null */
  hunks: z.array(diffHunkSchema).nullable(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type DiffFileRow = z.infer<typeof diffFileRowSchema>;

// 四档错误（判别联合 ok:false 分支）：not-a-repo 非 git 仓库 / git-missing git 可执行不可解析 / git-failed git 执行失败 / missing-cwd 项目目录不存在
export const diffErrorKindSchema = z.enum(["not-a-repo", "git-missing", "git-failed", "missing-cwd"]);
export type DiffErrorKind = z.infer<typeof diffErrorKindSchema>;

// diff:ipc 请求单通道联合（#47 若需增量通道在此扩成员）
export const diffRequestSchema = z.discriminatedUnion("channel", [
  /** 读取当前项目工作区未提交变更（HEAD 对比 + untracked）；Main 侧经 project store 解析 cwd */
  z.object({ channel: z.literal("diff:get"), projectId: z.string().min(1) }),
]);
export type DiffRequest = z.infer<typeof diffRequestSchema>;

// IPC 错误信封（入站不合契约 E_SCHEMA / 退出门闸 E_INTERNAL / 项目不存在 E_PROJECT_NOT_FOUND —— 复用全局错误码形状，不新增）
const diffIpcErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: errorCodeSchema, message: z.string() }),
});

// diff:ipc 结果：成功（files + truncated）∪ 四档错误 ∪ IPC 错误信封（ok:false 两形态形状不同，用 union）
export const diffResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    files: z.array(diffFileRowSchema),
    /** 截断保护标志（总字节/文件数/untracked 行数任一超限置 true，剩余文件仅列名） */
    truncated: z.boolean(),
  }),
  z.object({ ok: z.literal(false), kind: diffErrorKindSchema, message: z.string() }),
  diffIpcErrorSchema,
]);
export type DiffResult = z.infer<typeof diffResultSchema>;

/** 工作区 diff 成功载荷（git-diff-service 返回形状与 wire 同构） */
export type WorkspaceDiffOk = Extract<DiffResult, { ok: true }>;
