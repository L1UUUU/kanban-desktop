// 用途：diff 传输 seam（#43）—— renderer 侧经 preload 暴露的 window.api.invokeDiff 桥接；组件测试注入 fake（本文件不含业务逻辑）
import type { DiffRequest, DiffResult } from "@kanban/ipc-schema";

/** diff 传输 seam：生产为 window.api 桥接，测试注入 fake */
export interface DiffTransport {
  invoke(req: DiffRequest): Promise<DiffResult>;
}

/** 从 window.api（contextBridge 暴露）构造 diff transport；桥接不可用（如 jsdom 测试）返回 null */
export function createWindowDiffTransport(): DiffTransport | null {
  const api = window.api;
  if (!api?.invokeDiff) return null;
  return { invoke: (req) => api.invokeDiff!(req) };
}
