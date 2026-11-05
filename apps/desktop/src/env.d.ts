// 用途：renderer 全局类型（Vite client 与 preload 暴露的 window.api 桥接面）
/// <reference types="vite/client" />
import type { DesktopApi } from "../preload/index";

declare global {
  interface Window {
    api?: DesktopApi;
  }
}

export {};
