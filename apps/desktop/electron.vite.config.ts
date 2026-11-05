// 用途：electron-vite 三段构建配置（main / preload / renderer）；workspace 包以 TS 源打进 bundle，其余依赖外置
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// workspace 内部包不外置：以 TS 源码直接编译进产物（外部依赖如 electron 才走 require 外置）
const workspacePackages = ["@kanban/ipc-schema", "@kanban/cli-host", "@kanban/tracker"];

// 生产 CSP：脚本仅自身源（禁远程/内联脚本）、样式放宽 unsafe-inline（Tailwind/Vite 打包注入）、数据字体/图片放行
// dev 不注入（HMR websocket 与 React Fast Refresh 内联脚本需要；electron-vite 模板同款做法）
const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'";

export default defineConfig({
  main: {
    // spec A 冻结布局为 electron/（非 electron-vite 默认的 src/main），入口显式声明
    build: {
      lib: { entry: resolve(__dirname, "electron/main/index.ts") },
    },
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
  },
  preload: {
    build: {
      lib: { entry: resolve(__dirname, "preload/index.ts") },
    },
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
  },
  renderer: {
    root: "src",
    // spec A 布局：src/ 即 renderer 根（index.html 在 src/ 下，非约定的 src/renderer/），入口显式声明
    build: {
      rollupOptions: { input: resolve(__dirname, "src/index.html") },
    },
    plugins: [
      react(),
      tailwindcss(),
      // 仅生产构建向 index.html 注入 CSP meta（apply: build —— dev server 不经过此插件）
      {
        name: "csp-meta-prod-only",
        apply: "build",
        transformIndexHtml(html: string): string {
          return html.replace(
            "</title>",
            `</title>\n    <meta http-equiv="Content-Security-Policy" content="${PROD_CSP}" />`,
          );
        },
      },
    ],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
      },
    },
  },
});
