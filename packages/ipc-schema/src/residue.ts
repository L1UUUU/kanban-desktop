// 用途：残留进程治理 wire 契约（issue #49，spec #40 D/F 节）—— residue:ipc 二请求单通道联合 + 结果形状（业务拒绝 ok:false + reason，对齐 memory:ipc 模式，不新增全局错误码）+ 逐 pid kill 结果行；app:event 推送载荷见 app-info.ts
import { z } from "zod";

// 残留进程行（通知条进程表数据：pid / exe 路径 / 启动时间 / 关联会话记录；sessionTitle=null 即「无会话记录」）
export const residueProcessSchema = z.object({
  pid: z.number().int().positive(),
  exePath: z.string().min(1),
  /** 进程启动时间（ISO；CIM CreationDate 缺失时为 null） */
  startedAt: z.string().nullable(),
  /** 关联会话记录标题（best-effort 归属：命令行/注册表/同 CLI 最近会话；null=无会话记录，UI 默认不勾选防误杀） */
  sessionTitle: z.string().nullable(),
});
export type ResidueProcess = z.infer<typeof residueProcessSchema>;

// kill 单 pid 结果（killed / failed + 失败原因；确认式清理的逐 pid 回报）
export const residueKillResultSchema = z.object({
  pid: z.number().int().positive(),
  status: z.enum(["killed", "failed"]),
  /** failed 时的失败原因（taskkill 退出码/权限等） */
  error: z.string().nullable().optional(),
});
export type ResidueKillResult = z.infer<typeof residueKillResultSchema>;

// residue:ipc 请求单通道二联合（对齐 memory:ipc discriminatedUnion 模式；Main 入站强制校验）
export const residueRequestSchema = z.discriminatedUnion("channel", [
  /** 检测疑似残留 CLI 进程（Main 缓存本次启动的检测结果：spec 每次启动只检测一次，不轮询） */
  z.object({ channel: z.literal("residue:detect") }),
  /** 确认式终止选中进程（逐 pid 回报 killed/failed；无任何自动清理路径） */
  z.object({ channel: z.literal("residue:kill"), pids: z.array(z.number().int().positive()).min(1) }),
]);
export type ResidueRequest = z.infer<typeof residueRequestSchema>;

// 业务拒绝：ok:false + reason（shutting-down 等，不新增全局错误码）
export const residueRejectionSchema = z.object({
  ok: z.literal(false),
  reason: z.string().min(1),
  detail: z.string().optional(),
});
export type ResidueRejection = z.infer<typeof residueRejectionSchema>;

// 成功结果：ok:true + 按通道的可选载荷（对齐 memoryOkSchema 模式）
export const residueOkSchema = z.object({
  ok: z.literal(true),
  /** residue:detect：残留清单（无残留为空数组——不推送任何事件、不打扰） */
  processes: z.array(residueProcessSchema).optional(),
  /** residue:kill：逐 pid 终止结果 */
  results: z.array(residueKillResultSchema).optional(),
});
export type ResidueOk = z.infer<typeof residueOkSchema>;

export const residueResultSchema = z.discriminatedUnion("ok", [residueRejectionSchema, residueOkSchema]);
export type ResidueResult = z.infer<typeof residueResultSchema>;
