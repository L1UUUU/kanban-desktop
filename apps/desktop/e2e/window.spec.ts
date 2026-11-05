// 用途：Electron E2E 冒烟 —— 启动构建产物应用，断言三区布局可见与 preload→main IPC 链路连通（Fake 链路版；userData 隔离保证空项目 boot 态）
/// <reference lib="dom" /> <!-- evaluate 回调在页面上下文执行，需 DOM lib（仅本文件） -->
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let app: ElectronApplication;
let win: Page;
let userData = "";

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), "kb-window-e2e-"));
  app = await _electron.launch({
    args: [resolve(__dirname, "..")],
    env: { ...process.env, KANBAN_USER_DATA: userData },
  });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  await app.close();
  rmSync(userData, { recursive: true, force: true });
});

test("窗口打开显示三区布局（原型一致项 1）", async () => {
  // 顶栏：应用名 + 设置入口
  await expect(win.getByText("Kanban Desktop")).toBeVisible();
  await expect(win.getByText("设置")).toBeVisible();

  // 左侧栏：项目 / 结构化会话 / PTY 终端三分组 + 空项目 boot 演示会话行（#7：无项目时引导注册）
  await expect(win.getByText("项目", { exact: true })).toBeVisible();
  await expect(win.getByText("结构化会话")).toBeVisible();
  await expect(win.getByText("PTY 终端")).toBeVisible();
  await expect(win.getByText("尚无项目")).toBeVisible({ timeout: 15_000 });
  await expect(win.getByText("演示会话 · Fake")).toBeVisible({ timeout: 15_000 });
});

test("IPC 链路连通：运行信息经 preload 桥接到 renderer（侧栏底部）", async () => {
  await expect(win.getByText(/Electron \d+/)).toBeVisible({ timeout: 10_000 });
});

test("CSP 已收紧：页面携带 Content-Security-Policy 且渲染未被阻断", async () => {
  const csp = await win.evaluate(() =>
    document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
  );
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self'");
  // 渲染未被 CSP 阻断：composer 输入框存在
  await expect(win.getByPlaceholder("输入消息，/ 开头触发 Skill…")).toBeVisible();
});
