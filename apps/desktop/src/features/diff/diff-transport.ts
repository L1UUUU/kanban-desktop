// 用途：diff 传输 seam（#43）—— 经 lib/bridge-factory 声明驱动从 window.api 生成带 DEV 校验的 invoke 面（arch D8 收敛到统一生成路径）；组件测试注入 fake（本文件不含业务逻辑）
import { diffRequestSchema, type DiffRequest, type DiffResult } from "@kanban/ipc-schema";
import { bridged } from "../../lib/bridge-factory";

/** diff 传输 seam：生产为 window.api 桥接，测试注入 fake */
export interface DiffTransport {
  invoke(req: DiffRequest): Promise<DiffResult>;
}

/** 从 window.api（contextBridge 暴露）构造 diff transport；桥接不可用（如 jsdom 测试）返回 null */
export function createWindowDiffTransport(): DiffTransport | null {
  const api = window.api;
  if (!api?.invokeDiff) return null;
  return bridged(api, {
    invoke: { invoke: { channel: "invokeDiff", schema: diffRequestSchema, label: "出站 diff 请求" } },
  });
}
