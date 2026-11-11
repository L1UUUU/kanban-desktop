// 用途：Playwright E2E 编排 —— 目标为 electron-vite 构建产物（out/ 目录即应用形态），无浏览器工程
import { defineConfig } from "@playwright/test";
import { ensureTestModelEnv } from "../../scripts/test-model-env";

// 真实 CLI 集（kanban-real / memory-real）启动的 Electron worker 经 env 继承拿到白名单，不烧昂贵模型
ensureTestModelEnv();

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
});
