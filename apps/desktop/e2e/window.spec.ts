// 用途：Electron E2E 冒烟 —— 启动构建产物应用，断言三区布局可见与 preload→main IPC 链路连通
import { test, expect, _electron, type ElectronApplication } from "@playwright/test";
import { resolve } from "node:path";

let app: ElectronApplication;

test.beforeAll(async () => {
  app = await _electron.launch({ args: [resolve(__dirname, "..")] });
});

test.afterAll(async () => {
  await app.close();
});

test("窗口打开显示三区布局骨架（原型一致项 1）", async () => {
  const win = await app.firstWindow();

  // 顶栏：应用名 + 设置入口
  await expect(win.getByText("Kanban Desktop")).toBeVisible();
  await expect(win.getByText("设置")).toBeVisible();

  // 左侧栏：项目 / 结构化会话 / PTY 终端三分组
  await expect(win.getByText("项目", { exact: true })).toBeVisible();
  await expect(win.getByText("结构化会话")).toBeVisible();
  await expect(win.getByText("PTY 终端")).toBeVisible();

  // 中央聊天区占位
  await expect(win.getByText(/聊天区占位/)).toBeVisible();
});

test("IPC 链路连通：运行信息经 preload 桥接到 renderer", async () => {
  const win = await app.firstWindow();
  await expect(win.getByText(/Electron \d+/)).toBeVisible({ timeout: 10_000 });
});
