// 用途：preload 桥接的 renderer 侧 transport 工厂 —— 出站开发态 zod 校验（spec E：Renderer 出站 dev 校验，生产零开销）+ 事件订阅
import { adapterEventSchema, ipcRequestSchema, type AdapterEvent, type IpcRequest, type IpcResult } from "@kanban/ipc-schema";

/** 传输 seam：组件测试注入 FakeAdapter 直连实现，生产为 window.api 桥接 */
export interface ChatTransport {
  invoke(req: IpcRequest): Promise<IpcResult>;
  onEvent(handler: (event: AdapterEvent) => void): () => void;
}

/** 从 window.api（contextBridge 暴露）构造 transport；桥接不可用（如 jsdom 测试）返回 null */
export function createWindowTransport(): ChatTransport | null {
  const api = window.api;
  if (!api) return null;
  return {
    invoke: async (req) => {
      if (import.meta.env.DEV) ipcRequestSchema.parse(req);
      return api.invoke(req);
    },
    onEvent: (handler) =>
      api.onChatEvent((event: AdapterEvent) => {
        if (import.meta.env.DEV) {
          const parsed = adapterEventSchema.safeParse(event);
          if (!parsed.success) {
            console.warn("[kanban] 入站事件不符合 schema", parsed.error.issues);
          }
        }
        handler(event);
      }),
  };
}
