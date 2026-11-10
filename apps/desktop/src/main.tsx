// 用途：renderer React 入口 —— 挂载 App 并引入全局样式；createRoot 之前注册全局错误兜底（#55 spec #52 F 节）
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { registerRendererCrashHandlers } from "./lib/renderer-crash";

registerRendererCrashHandlers(window);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
