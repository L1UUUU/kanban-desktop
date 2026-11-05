// 用途：contextBridge 薄层 —— 向 renderer 暴露最小 IPC 面（本工单仅 app:getInfo 冒烟通道；全部通道形状由 @kanban/ipc-schema 契约化，spec E）
import { contextBridge, ipcRenderer } from "electron";
import type { AppInfo } from "@kanban/ipc-schema";

const api = {
  /** 拉取应用运行信息（名称/版本/平台/SQLite 入口），用于骨架冒烟展示 */
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke("app:getInfo") as Promise<AppInfo>,
};

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld("api", api);
