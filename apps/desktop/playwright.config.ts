// 用途：Playwright E2E 编排 —— 目标为 electron-vite 构建产物（out/ 目录即应用形态），无浏览器工程
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
});
