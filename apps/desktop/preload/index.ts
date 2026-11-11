// 用途：contextBridge 薄层 —— 向 renderer 暴露最小 IPC 面（app:getInfo + kanban:ipc/memory:ipc/residue:ipc/diff:ipc/config:ipc 单通道 invoke + chat:event/terminal:event/tracker:event/memory:event/app:event/app:shutdown 订阅 + log:write 单向日志/log:getPath/log:openDir）；全部通道形状由 @kanban/ipc-schema 契约化，通道名经 IPC_CHANNELS 单源（#72 Step4），preload 不做校验（两端校验，spec E）
import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type AdapterEvent, type AppEventWire, type AppInfo, type ConfigRequest, type ConfigResult, type DiffRequest, type DiffResult, type IpcRequest, type IpcResult, type LogCtx, type LogLevel, type MemoryEventWire, type MemoryRequest, type MemoryResult, type ResidueRequest, type ResidueResult, type ShutdownNotice, type TerminalEvent, type TrackerChangeWire } from "@kanban/ipc-schema";

const api = {
  /** 拉取应用运行信息（名称/版本/平台/SQLite 入口），用于骨架冒烟展示 */
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke("app:getInfo") as Promise<AppInfo>,
  /** 发送一条 IPC 请求（请求/结果形状见 ipcRequestSchema/ipcResultSchema；terminal:* 同经此通道） */
  invoke: (req: IpcRequest) => ipcRenderer.invoke(IPC_CHANNELS.kanban.name, req) as Promise<IpcResult>,
  /** #31：发送一条 memory:ipc 请求（提取/取消/审核/总结处置/需求一次读/项目检索/知识再编辑，schema 见 memoryRequestSchema） */
  invokeMemory: (req: MemoryRequest) => ipcRenderer.invoke(IPC_CHANNELS.memory.name, req) as Promise<MemoryResult>,
  /** #49：发送一条 residue:ipc 请求（residue:detect 检测清单 / residue:kill 确认式清理，schema 见 residueRequestSchema） */
  invokeResidue: (req: ResidueRequest) => ipcRenderer.invoke(IPC_CHANNELS.residue.name, req) as Promise<ResidueResult>,
  /** #43：发送一条 diff:ipc 请求（工作区未提交变更一次读，schema 见 diffRequestSchema） */
  invokeDiff: (req: DiffRequest) => ipcRenderer.invoke(IPC_CHANNELS.diff.name, req) as Promise<DiffResult>,
  /** #61：发送一条 config:ipc 请求（config:get 读 / config:set 存 autoArchive 子集，schema 见 configRequestSchema） */
  invokeConfig: (req: ConfigRequest) => ipcRenderer.invoke(IPC_CHANNELS.config.name, req) as Promise<ConfigResult>,
  /**
   * #55：发送一条 renderer 日志（fire-and-forget：send 不等待回执，不用 invoke；Main 侧强制 source=renderer、
   * 落盘 ts 由 Main 生成，两者不信自报；jsdom 无桥时调用方以 window.api?.log?.() 可选链降级）
   */
  log: (level: LogLevel, scope: string, message: string, ctx?: LogCtx): void => {
    ipcRenderer.send("log:write", { level, source: "renderer", scope, message, ts: Date.now(), ctx });
  },
  /** #55：取当前启动主日志文件绝对路径（「复制日志文件路径」数据源） */
  getLogPath: (): Promise<string> => ipcRenderer.invoke("log:getPath") as Promise<string>,
  /** #55：在资源管理器中定位当前启动主日志文件（「打开日志文件」动作） */
  openLogDir: (): Promise<void> => ipcRenderer.invoke("log:openDir").then(() => undefined),
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
  /** #17：订阅 tracker 变更流（requirement_created/stage_changed/session_linked/... 看板实时刷新载荷，schema 见 trackerChangeSchema），返回注销函数 */
  onTrackerEvent: (handler: (change: TrackerChangeWire) => void): (() => void) => {
    const listener = (_e: unknown, change: TrackerChangeWire): void => handler(change);
    ipcRenderer.on("tracker:event", listener);
    return () => ipcRenderer.off("tracker:event", listener);
  },
  /** #31：订阅 memory 事件流（batch-status 批次状态 / chunk-progress 段进度，schema 见 memoryEventSchema），返回注销函数 */
  onMemoryEvent: (handler: (event: MemoryEventWire) => void): (() => void) => {
    const listener = (_e: unknown, event: MemoryEventWire): void => handler(event);
    ipcRenderer.on("memory:event", listener);
    return () => ipcRenderer.off("memory:event", listener);
  },
  /** #49：订阅应用级事件流（residue-detected 残留检测一次性通知，schema 见 appEventSchema），返回注销函数 */
  onAppEvent: (handler: (event: AppEventWire) => void): (() => void) => {
    const listener = (_e: unknown, event: AppEventWire): void => handler(event);
    ipcRenderer.on("app:event", listener);
    return () => ipcRenderer.off("app:event", listener);
  },
  /** 订阅退出通知（统一退出序列第 1 步「停止接收新请求」的 UI 提示，#13/spec H），返回注销函数 */
  onShutdownNotice: (handler: (notice: ShutdownNotice) => void): (() => void) => {
    const listener = (_e: unknown, notice: ShutdownNotice): void => handler(notice);
    ipcRenderer.on("app:shutdown", listener);
    return () => ipcRenderer.off("app:shutdown", listener);
  },
};

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld("api", api);
