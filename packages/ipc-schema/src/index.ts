// 用途：@kanban/ipc-schema 入口 —— 全部 IPC wire 形状的 zod 契约（spec A/E：无 Node/Electron 依赖，renderer 仅消费本包类型与开发态校验）
export * from "./app-info";
export * from "./channels";
export * from "./chat";
export * from "./config";
export * from "./diff";
export * from "./ipc";
export * from "./kanban";
export * from "./log";
export * from "./memory";
export * from "./residue";
export * from "./terminal";
export * from "./transcript";
