// 用途：desktop 单测编排 —— renderer 组件（jsdom）与主进程纯 Node 模块（node）两个 project
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        resolve: {
          alias: {
            "@": resolve(__dirname, "src"),
            "@kanban/ipc-schema": resolve(__dirname, "../../packages/ipc-schema/src/index.ts"),
          },
        },
        test: {
          name: "renderer",
          environment: "jsdom",
          include: ["src/**/*.test.{ts,tsx}"],
          globals: true,
        },
      },
      {
        resolve: {
          alias: {
            "@kanban/ipc-schema": resolve(__dirname, "../../packages/ipc-schema/src/index.ts"),
          },
        },
        test: {
          name: "node",
          environment: "node",
          include: ["electron/**/*.test.ts", "tests/**/*.test.ts"],
          globals: true,
          // SQLite 重负载用例在共享机器高负载下会超默认 5s（隔离复跑仅数百 ms），放宽以消除负载型假红
          testTimeout: 20_000,
        },
      },
    ],
  },
});
