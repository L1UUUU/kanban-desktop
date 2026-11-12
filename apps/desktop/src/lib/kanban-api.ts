// 用途：preload 桥接的 renderer 侧 transport 工厂 —— 出站开发态 zod 校验（spec E：Renderer 出站 dev 校验，生产零开销）+ chat/terminal/tracker/memory 事件订阅
import {
  adapterEventSchema,
  ipcRequestSchema,
  memoryEventSchema,
  memoryRequestSchema,
  modelsRequestSchema,
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
  type TerminalEvent,
  type TrackerChangeWire,
} from "@kanban/ipc-schema";
import { createScopedLogger } from "./logger";

// 本文件日志出口（scope 固定 transport，经 lib/logger 唯一出口发出）
const log = createScopedLogger("transport");

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
}

/** dev 态出站校验（#55 迁移）：失败经统一日志记 warn 后原样重抛，保持既有 dev-only throw 语义 */
function devCheck(parse: () => void, label: string): void {
  try {
    parse();
  } catch (e) {
    log.warn(`${label}不符合 schema`, { issues: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/** 从 window.api（contextBridge 暴露）构造 transport；桥接不可用（如 jsdom 测试）返回 null */
export function createWindowTransport(): ChatTransport | null {
  const api = window.api;
  if (!api) return null;
  return {
    invoke: async (req) => {
      if (import.meta.env.DEV) devCheck(() => ipcRequestSchema.parse(req), "出站请求");
      return api.invoke(req);
    },
    onEvent: (handler) =>
      api.onChatEvent((event: AdapterEvent) => {
        if (import.meta.env.DEV) {
          const parsed = adapterEventSchema.safeParse(event);
          if (!parsed.success) {
            log.warn("入站事件不符合 schema", { issues: JSON.stringify(parsed.error.issues) });
          }
        }
        handler(event);
      }),
    onTerminalEvent: (handler) =>
      api.onTerminalEvent((event: TerminalEvent) => {
        if (import.meta.env.DEV) {
          const parsed = terminalEventSchema.safeParse(event);
          if (!parsed.success) {
            log.warn("入站终端事件不符合 schema", { issues: JSON.stringify(parsed.error.issues) });
          }
        }
        handler(event);
      }),
    onTrackerEvent: (handler) =>
      api.onTrackerEvent((change: TrackerChangeWire) => {
        if (import.meta.env.DEV) {
          const parsed = trackerChangeSchema.safeParse(change);
          if (!parsed.success) {
            log.warn("入站 tracker 变更不符合 schema", { issues: JSON.stringify(parsed.error.issues) });
          }
        }
        handler(change);
      }),
    invokeMemory: async (req) => {
      if (import.meta.env.DEV) devCheck(() => memoryRequestSchema.parse(req), "出站 memory 请求");
      return api.invokeMemory(req);
    },
    invokeModels: async (req) => {
      if (import.meta.env.DEV) devCheck(() => modelsRequestSchema.parse(req), "出站 models 请求");
      return api.invokeModels(req);
    },
    onMemoryEvent: (handler) =>
      api.onMemoryEvent((event: MemoryEventWire) => {
        if (import.meta.env.DEV) {
          const parsed = memoryEventSchema.safeParse(event);
          if (!parsed.success) {
            log.warn("入站 memory 事件不符合 schema", { issues: JSON.stringify(parsed.error.issues) });
          }
        }
        handler(event);
      }),
  };
}
