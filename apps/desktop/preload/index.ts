// 用途：contextBridge 薄层 —— 向 renderer 暴露最小 IPC 面（app:getInfo + kanban:ipc 单通道 invoke + chat:event/terminal:event 订阅）；全部通道形状由 @kanban/ipc-schema 契约化，preload 不做校验（两端校验，spec E）
import { contextBridge, ipcRenderer } from "electron";
import type { AdapterEvent, AppInfo, IpcRequest, IpcResult, TerminalEvent } from "@kanban/ipc-schema";

const api = {
  /** 拉取应用运行信息（名称/版本/平台/SQLite 入口），用于骨架冒烟展示 */
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke("app:getInfo") as Promise<AppInfo>,
  /** 发送一条 IPC 请求（请求/结果形状见 ipcRequestSchema/ipcResultSchema；terminal:* 同经此通道） */
  invoke: (req: IpcRequest) => ipcRenderer.invoke("kanban:ipc", req) as Promise<IpcResult>,
  /** 订阅 Adapter 事件流（ChatEvent ∪ SkillObservation），返回注销函数 */
  onChatEvent: (handler: (event: AdapterEvent) => void): (() => void) => {
    const listener = (_e: unknown, event: AdapterEvent): void => handler(event);
    ipcRenderer.on("chat:event", listener);
    return () => ipcRenderer.off("chat:event", listener);
  },
  /** 订阅 PTY 终端事件流（started/data/exit/error 按 terminalId 路由），返回注销函数 */
  onTerminalEvent: (handler: (event: TerminalEvent) => void): (() => void) => {
    const listener = (_e: unknown, event: TerminalEvent): void => handler(event);
    ipcRenderer.on("terminal:event", listener);
    return () => ipcRenderer.off("terminal:event", listener);
  },
};

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld("api", api);
