// 用途：memory 传输 seam（#34）—— renderer 侧经 preload 暴露的 window.api.invokeMemory/onMemoryEvent 桥接（#31 已铺好）；组件测试注入直连 MemoryService 的 fake（本文件不含业务逻辑）
import type { MemoryEventWire, MemoryRequest, MemoryResult } from "@kanban/ipc-schema";

/** memory 传输 seam：组件测试注入 fake（真实 MemoryService 直连），生产为 window.api 桥接 */
export interface MemoryTransport {
  invoke(req: MemoryRequest): Promise<MemoryResult>;
  /** 订阅 memory 事件流（batch-status/chunk-progress），返回注销函数 */
  onEvent(handler: (event: MemoryEventWire) => void): () => void;
}

/** 从 window.api（contextBridge 暴露）构造 memory transport；桥接不可用（如 jsdom 测试）返回 null */
export function createWindowMemoryTransport(): MemoryTransport | null {
  const api = window.api;
  if (!api?.invokeMemory || !api?.onMemoryEvent) return null;
  return {
    invoke: (req) => api.invokeMemory(req),
    onEvent: (handler) => api.onMemoryEvent(handler),
  };
}
