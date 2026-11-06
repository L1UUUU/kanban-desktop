// 用途：C1 演进（issue #28 / spec #27 B 节）—— readTranscript 返回的 TranscriptEvent 契约：user/assistant 双视角历史事件（提取管线的唯一历史数据源；user 视角是总结「目标/要求」的来源）
import { z } from "zod";

// 工具调用标注（assistant 事件可选携带）：name 原生工具名，summary 参数/命令摘要
export const transcriptToolSchema = z.object({
  name: z.string().min(1),
  summary: z.string(),
});
export type TranscriptTool = z.infer<typeof transcriptToolSchema>;

// 双视角历史事件：role 两值；text 恒为字符串（工具事件携带空串，形状齐一）；tool 可选
export const transcriptEventSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  tool: transcriptToolSchema.optional(),
});
export type TranscriptEvent = z.infer<typeof transcriptEventSchema>;
