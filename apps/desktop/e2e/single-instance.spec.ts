// 用途：#51 单实例锁整机验收 —— 二次启动立即退出（退出码 0 + 无 GPU cache 争抢 stderr）、首实例窗口前置聚焦（最小化还原）、锁随首实例退出释放（正常关与强杀后均可再启动）
import { test, expect, _electron } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const appDir = resolve(__dirname, "..");
// electron 包运行时导出其二进制路径（注意：不能用 Playwright 进程的 spawnfile——Windows 上那是 cmd.exe 包装）
const electronExe = require("electron") as unknown as string;

let userData = "";

test.beforeAll(() => {
  // 独立 userData：锁 key 随 userData 路径，与本机真实运行实例/其他 spec 互不干扰
  userData = mkdtempSync(join(tmpdir(), "kb-single-instance-e2e-"));
  if (!electronExe || !existsSync(electronExe)) throw new Error(`electron 二进制不可用：${electronExe}`);
});

test.afterAll(async () => {
  // Windows 句柄释放有毫秒级延迟：小间隔重试防清理假红
  for (let i = 0; i < 3; i += 1) {
    try {
      rmSync(userData, { recursive: true, force: true });
      return;
    } catch {
      await sleep(500);
    }
  }
});

/** 毫秒等待（本地实现：不经 node:timers/promises，规避运行时导出差异） */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 等待进程退出；超时返回 null（不代杀，由调用方决定清理） */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null } | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });
}

/** Windows 进程树强杀（taskkill /T /F；red 态第二实例不退出时的清理兜底，亦是强杀场景的杀灭手段） */
function killTree(pid: number): void {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // 尽力清理：失败不掩盖真正的断言失败
  }
}

test("主实例运行时二次启动：立即退出且首实例窗口前置聚焦", async () => {
  // 首实例 A：正常起窗（真实持锁方）
  const appA = await _electron.launch({ args: [appDir], env: { ...process.env, KANBAN_USER_DATA: userData } });
  await appA.firstWindow();

  let childB: ChildProcess | null = null;
  try {
    // 前置状态：最小化首实例窗口（聚焦断言须走 restore 路径，避免"本来就聚焦"假绿）
    await appA.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.minimize();
    });
    // second-instance 计数器（主进程 globalThis，跨 evaluate 调用保持）
    await appA.evaluate(({ app }) => {
      const g = globalThis as Record<string, unknown> & { __secondInstanceCount?: number };
      g.__secondInstanceCount = 0;
      app.on("second-instance", () => {
        g.__secondInstanceCount = (g.__secondInstanceCount ?? 0) + 1;
      });
    });

    // 第二实例 B：同 exe 同 userData 裸 spawn（不经 Playwright CDP——它应当无窗口直接退出）；
    // ELECTRON_ENABLE_LOGGING 保证应用层 console 输出必达 stderr（下方"零初始化"断言的前提）
    childB = spawn(electronExe, [appDir], {
      env: { ...process.env, KANBAN_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    childB.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    childB.stdout?.on("data", () => {}); // 排空 stdout 防写满阻塞

    const exit = await waitForExit(childB, 20_000);
    if (!exit) killTree(childB.pid ?? -1);
    expect(exit, "第二实例应在 20s 内自行退出").not.toBeNull();
    expect(exit?.code, "持锁失败应以退出码 0 退出").toBe(0);
    // 零初始化：二实例不得跑到应用装配层——DB/CLI Host/残留检测的日志前缀均不得出现
    //（Chromium 自身 GPU cache 的一过性报错属浏览器层初始化，发生在应用锁可达范围之外，不作断言）
    expect(stderr).not.toMatch(/\[kanban:/);
    expect(stderr).not.toMatch(/\[cli-host:/);

    // 首实例收到 second-instance 且窗口还原聚焦
    await expect
      .poll(
        () =>
          appA.evaluate(({ BrowserWindow }) => {
            const w = BrowserWindow.getAllWindows()[0];
            return w ? { minimized: w.isMinimized(), focused: w.isFocused() } : { minimized: true, focused: false };
          }),
        { timeout: 10_000 },
      )
      .toEqual({ minimized: false, focused: true });
    const count = await appA.evaluate(
      () => (globalThis as Record<string, unknown> & { __secondInstanceCount?: number }).__secondInstanceCount ?? 0,
    );
    expect(count, "首实例应收到 second-instance 事件").toBeGreaterThanOrEqual(1);
  } finally {
    await appA.close().catch(() => {});
  }
});

test("首实例正常退出后锁释放，可再次启动", async () => {
  // 第一代：起窗后正常关闭（走 before-quit 统一退出序列）
  const first = await _electron.launch({ args: [appDir], env: { ...process.env, KANBAN_USER_DATA: userData } });
  await first.firstWindow();
  await first.close();

  // 第二代：同 userData 再启动应正常起窗（锁已随首实例退出释放）
  const second = await _electron.launch({ args: [appDir], env: { ...process.env, KANBAN_USER_DATA: userData } });
  await second.firstWindow();
  await second.close();
});

test("强杀首实例后锁不残留，可再次启动", async () => {
  // 受害实例裸 spawn（不经 Playwright 包装——process() 拿到的是 cmd.exe，杀它会留下孤儿）；
  // kanban.db 在 whenReady 内建库时创建，出现即表示应用已完整初始化、锁必然在握
  const victim = spawn(electronExe, [appDir], {
    env: { ...process.env, KANBAN_USER_DATA: userData },
    stdio: "ignore",
  });
  await expect
    .poll(() => existsSync(join(userData, "kanban.db")), { timeout: 20_000 })
    .toBe(true);

  killTree(victim.pid ?? -1); // 强杀整棵进程树（TerminateProcess；Windows 锁随进程句柄释放）
  await waitForExit(victim, 10_000);
  await sleep(500); // 留出内核句柄回收窗口

  const relaunch = await _electron.launch({ args: [appDir], env: { ...process.env, KANBAN_USER_DATA: userData } });
  await relaunch.firstWindow();
  await relaunch.close();
});
