// 用途：顶层 IPC 通道名单源 —— 五个 :ipc 通道的名称 / wire 契约配对 / 错误方言描述符（main 侧 ipcMain.handle 与日志 scope、preload 侧 invoke 的通道名字符串唯一出处；纯常量零 Node 依赖，不建运行时注册表）
import type { z } from "zod";
import { configRequestSchema, configResultSchema } from "./config";
import { diffRequestSchema, diffResultSchema } from "./diff";
import { ipcRequestSchema, ipcResultSchema } from "./ipc";
import { memoryRequestSchema, memoryResultSchema } from "./memory";
import { residueRequestSchema, residueResultSchema } from "./residue";

/** 信封错误方言标记（wire 形状不变，仅 main 侧信封工厂参数化依据）：code={ok:false,error:{code,message}}｜reason={ok:false,reason,detail?} */
export type EnvelopeErrorShape = "code" | "reason";

/** 单个顶层 IPC 通道的 wire 契约描述符（#72 方案 A 最小元素：渐进挂 def 用；handler 与接线留在 main，不进本包） */
export interface IpcChannelDef<N extends string, Req, Res> {
  /** 通道名（main ipcMain.handle / preload invoke / 日志 scope 共用单源） */
  readonly name: N;
  /** 入站请求契约 */
  readonly request: z.ZodType<Req>;
  /** 出站结果契约 */
  readonly result: z.ZodType<Res>;
  /** 错误方言（入站拒绝与退出门闸的 wire 错误形状） */
  readonly errorShape: EnvelopeErrorShape;
}

/** 顶层 IPC 通道契约表（通道名逐字保持既有字符串；新增顶层通道 = 加一个成员，main 注册与 preload invoke 引用即编译对齐） */
export const IPC_CHANNELS = {
  kanban: { name: "kanban:ipc", request: ipcRequestSchema, result: ipcResultSchema, errorShape: "code" },
  memory: { name: "memory:ipc", request: memoryRequestSchema, result: memoryResultSchema, errorShape: "reason" },
  residue: { name: "residue:ipc", request: residueRequestSchema, result: residueResultSchema, errorShape: "reason" },
  diff: { name: "diff:ipc", request: diffRequestSchema, result: diffResultSchema, errorShape: "code" },
  config: { name: "config:ipc", request: configRequestSchema, result: configResultSchema, errorShape: "code" },
} as const satisfies Record<string, IpcChannelDef<string, unknown, unknown>>;

/** 通道键名（"kanban" | "memory" | "residue" | "diff" | "config"） */
export type IpcChannelName = keyof typeof IPC_CHANNELS;
