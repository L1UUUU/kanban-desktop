// 用途：preload 桥接的 renderer 侧 transport —— 通道经声明表驱动 lib/bridge-factory 生成（arch D8：出站开发态 zod 校验（spec E）+ 事件订阅，新通道 = 声明表加一行）
import {
  adapterEventSchema,
  ipcRequestSchema,
  memoryEventSchema,
  memoryRequestSchema,
  modelsRequestSchema,
  sessionEventSchema,
  terminalEventSchema,
  trackerChangeSchema,
  type AdapterEvent,
  type IpcRequest,
  type IpcResult,
  type MemoryEventWire,
  type MemoryRequest,
  type MemoryResult,
  type ModelsRequest,
  type ModelsResult,
  type SessionEventWire,
  type TerminalEvent,
  type TrackerChangeWire,
} from "@kanban/ipc-schema";
import { bridged, type EventSpec, type InvokeSpec } from "./bridge-factory";

/** 传输 seam：组件测试注入 FakeAdapter 直连实现，生产为 window.api 桥接 */
export interface ChatTransport {
  invoke(req: IpcRequest): Promise<IpcResult>;
  onEvent(handler: (event: AdapterEvent) => void): () => void;
  onTerminalEvent(handler: (event: TerminalEvent) => void): () => void;
  /** tracker 变更订阅（#18 看板实时刷新：requirement_created/stage_changed/session_linked/... 推送载荷） */
  onTrackerEvent(handler: (change: TrackerChangeWire) => void): () => void;
  /** #33：memory:ipc 请求（提取/取消/审核/总结处置/需求一次读；可选——未接的旧 fake 由消费方降级占位） */
  invokeMemory?(req: MemoryRequest): Promise<MemoryResult>;
  /** #33：memory 事件订阅（batch-status 批次状态 / chunk-progress 段进度） */
  onMemoryEvent?(handler: (event: MemoryEventWire) => void): () => void;
  /** #77：models:ipc 请求（models:list 按 CLI 拉取模型目录；可选——未接的旧 fake 由模型目录降级为错误态手输兜底） */
  invokeModels?(req: ModelsRequest): Promise<ModelsResult>;
  /** #95：session:event 事件订阅（摘要标题异步完成推送，schema 见 sessionEventSchema；可选——未接的旧 fake 安全降级） */
  onSessionEvent?(handler: (event: SessionEventWire) => void): () => void;
}

/**
 * window.api 桥接声明表（单源）：invoke 段一行 = 一条带 DEV 请求校验的出站通道，
 * events 段一行 = 一条带 DEV 载荷校验的订阅通道；schema 单源 @kanban/ipc-schema，通道名即 preload 方法名
 */
export const windowBridgeSpec = {
  invoke: {
    invoke: { channel: "invoke", schema: ipcRequestSchema, label: "出站请求" },
    invokeMemory: { channel: "invokeMemory", schema: memoryRequestSchema, label: "出站 memory 请求" },
    invokeModels: { channel: "invokeModels", schema: modelsRequestSchema, label: "出站 models 请求" },
  },
  events: {
    onEvent: { channel: "onChatEvent", schema: adapterEventSchema, message: "入站事件不符合 schema" },
    onTerminalEvent: { channel: "onTerminalEvent", schema: terminalEventSchema, message: "入站终端事件不符合 schema" },
    onTrackerEvent: { channel: "onTrackerEvent", schema: trackerChangeSchema, message: "入站 tracker 变更不符合 schema" },
    onMemoryEvent: { channel: "onMemoryEvent", schema: memoryEventSchema, message: "入站 memory 事件不符合 schema" },
    onSessionEvent: { channel: "onSessionEvent", schema: sessionEventSchema, message: "入站 session 事件不符合 schema" },
  },
} satisfies { invoke: Record<string, InvokeSpec>; events: Record<string, EventSpec> };

/** 从 window.api（contextBridge 暴露）构造 transport；桥接不可用（如 jsdom 测试）返回 null */
export function createWindowTransport(): ChatTransport | null {
  const api = window.api;
  if (!api) return null;
  return bridged(api, windowBridgeSpec);
}
