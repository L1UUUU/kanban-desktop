// 用途：模型目录通道契约（issue #76，spec #75）—— models:ipc 独立单通道（单请求 models:list：按 CLI 拉取真实模型目录）；目录条目四字段形状单源（cli-host ModelEntry 与 renderer 消费方共用）；默认项由 isDefault 派生，不设独立 defaultModel 字段（单一事实源）
import { z } from "zod";
import { cliKindSchema, errorCodeSchema } from "./ipc";

/** 模型目录条目（三 CLI 摊平/映射后的统一形状）：displayName 主行 + 完整 id 副行（opencode 为 providerID/modelID 完整串）；isDefault 为默认项唯一标记 */
export const modelEntrySchema = z.object({
  id: z.string().min(1),
  displayName: z.string(),
  description: z.string(),
  isDefault: z.boolean(),
});
export type ModelEntry = z.infer<typeof modelEntrySchema>;

// models:ipc 请求单通道联合（对齐 config:ipc 先例；cwd 供 server-per-project CLI（opencode）按项目拉起 server）
export const modelsRequestSchema = z.discriminatedUnion("channel", [
  z.object({
    channel: z.literal("models:list"),
    cli: cliKindSchema,
    cwd: z.string().min(1),
  }),
]);
export type ModelsRequest = z.infer<typeof modelsRequestSchema>;

// IPC 错误信封（复用全局错误码形状：入站 E_SCHEMA；adapter 侧 AdapterError 原码透传，如 claude 暂未支持 E_INTERNAL、exe 未装 E_SPAWN_NOT_FOUND）
const modelsIpcErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: errorCodeSchema, message: z.string() }),
});

// models:ipc 结果：成功（models 目录数组；默认项由 isDefault 派生，无独立 defaultModel 字段）∪ IPC 错误信封
export const modelsResultSchema = z.union([
  z.object({ ok: z.literal(true), models: z.array(modelEntrySchema) }),
  modelsIpcErrorSchema,
]);
export type ModelsResult = z.infer<typeof modelsResultSchema>;
