// 用途：面板拖拽整机 E2E（#85）—— 侧栏宽度拖拽（Esc 回滚/键盘步进/Home-End/双击复位）+ 输入框高度拖拽（草稿/会话两态共享偏好）+ 两尺寸重启恢复（renderer localStorage 持久化）；Fake 演示链路 + userData 隔离
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** 尽力删除目录：Windows 下 electron/Crashpad 子进程退出有延迟，重试后仍锁则告警放行 */
async function rmBestEffort(target: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.warn(`[e2e] 临时目录仍被占用，跳过清理：${target}`);
}

/** 启动应用（Fake 演示链路；userData 隔离；重启恢复用例复用同一 userData） */
async function launchApp(userData: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await _electron.launch({
    args: [resolve(__dirname, "..")],
    env: {
      ...process.env,
      KANBAN_USER_DATA: userData,
      KANBAN_DISABLE_CLAUDE: "1",
      KANBAN_DISABLE_OPENCODE: "1",
    },
  });
  const win = await app.firstWindow();
  return { app, win };
}

/** 元素当前渲染宽/高（boundingBox 取整；面板尺寸断言统一入口） */
async function boxSize(loc: ReturnType<Page["locator"]>): Promise<{ w: number; h: number }> {
  const bb = await loc.boundingBox();
  if (!bb) throw new Error("元素不可见，无法取 boundingBox");
  return { w: Math.round(bb.width), h: Math.round(bb.height) };
}

/** 拖拽把手：从当前中心按位移拖动（steps 细分保证 pointermove 序列；release=false 留在按下态驱动 Esc 用例） */
async function dragBy(win: Page, loc: ReturnType<Page["locator"]>, dx: number, dy: number, release = true): Promise<void> {
  const bb = await loc.boundingBox();
  if (!bb) throw new Error("把手不可见");
  const cx = bb.x + bb.width / 2;
  const cy = bb.y + bb.height / 2;
  await win.mouse.move(cx, cy);
  await win.mouse.down();
  await win.mouse.move(cx + dx, cy + dy, { steps: 8 });
  if (release) await win.mouse.up();
}

test("侧栏宽度：拖拽调整 → Esc 回滚 → 键盘步进/Home-End → 双击复位 → 重启恢复", async () => {
  const userData = mkdtempSync(join(tmpdir(), "kb-panel-user-"));
  try {
    const { app, win } = await launchApp(userData);
    const aside = win.locator("aside");
    const handle = win.getByTestId("sidebar-resize-handle");

    // 把手为 separator 角色；默认宽 240（既有布局锚点经变量驱动）
    await expect(handle).toHaveAttribute("role", "separator");
    await expect(win.getByRole("separator", { name: "拖拽调整侧栏宽度" })).toBeVisible();
    await expect((await boxSize(aside)).w).toBe(240);

    // 拖拽中 Esc：回滚到拖拽前尺寸（指针捕获下 Esc 生效；预览 360 → 回滚 240）
    await dragBy(win, handle, 120, 0, false);
    await expect((await boxSize(aside)).w).toBe(360); // 预览即时跟随
    await win.keyboard.press("Escape");
    await expect((await boxSize(aside)).w).toBe(240); // Esc 回滚
    await win.mouse.up();

    // 拖拽提交 +100 → 340
    await dragBy(win, handle, 100, 0);
    await expect((await boxSize(aside)).w).toBe(340);

    // 键盘：ArrowRight +16 → 356；End → 480（宽视口下固定上限生效）；Home → 180
    await handle.click(); // 聚焦（pointerDown 即 focus，click 无位移不提交）
    await win.keyboard.press("ArrowRight");
    await expect((await boxSize(aside)).w).toBe(356);
    await win.keyboard.press("End");
    await expect((await boxSize(aside)).w).toBe(480);
    await win.keyboard.press("Home");
    await expect((await boxSize(aside)).w).toBe(180);

    // 双击复位默认 240，再拖到 300 作为重启断言目标
    await handle.dblclick();
    await expect((await boxSize(aside)).w).toBe(240);
    await dragBy(win, handle, 60, 0);
    await expect((await boxSize(aside)).w).toBe(300);
    await app.close();

    // 重启（同一 userData）：localStorage 持久化恢复 300
    const second = await launchApp(userData);
    await expect((await boxSize(second.win.locator("aside"))).w).toBe(300);
    await second.app.close();
  } finally {
    await rmBestEffort(userData);
  }
});

test("输入框高度：草稿态拖拽增高 → 发首条转会话（共享偏好联动）→ 重启恢复", async () => {
  const userData = mkdtempSync(join(tmpdir(), "kb-panel-comp-"));
  try {
    const { app, win } = await launchApp(userData);
    const handle = win.getByTestId("composer-resize-handle");
    const box = win.getByPlaceholder("输入消息，/ 开头触发 Skill…");

    // boot 演示草稿（Fake 链路）：默认高 46
    await expect(win.getByTestId("draft-hint")).toBeVisible({ timeout: 15_000 });
    await expect(handle).toHaveAttribute("role", "separator");
    await expect((await boxSize(box)).h).toBe(46);

    // 上拖 54px → 100（上缘拖拽增高）
    await dragBy(win, handle, 0, -54);
    await expect((await boxSize(box)).h).toBe(100);

    // 发首条消息：草稿转会话，会话 Composer 读同一持久化偏好（两态联动）
    await box.fill("首条消息（驱动草稿转会话）");
    await win.getByRole("button", { name: "发送 ➤" }).click();
    await expect(win.getByTestId("session-row").first()).toBeVisible({ timeout: 15_000 });
    await expect((await boxSize(box)).h).toBe(100);
    await app.close();

    // 重启（同一 userData）：点击恢复的会话行 → Composer 高度从持久化偏好恢复
    const second = await launchApp(userData);
    await second.win.getByTestId("session-row").first().click();
    await expect(second.win.getByPlaceholder("输入消息，/ 开头触发 Skill…")).toBeVisible({ timeout: 15_000 });
    await expect((await boxSize(second.win.getByPlaceholder("输入消息，/ 开头触发 Skill…"))).h).toBe(100);
    await second.app.close();
  } finally {
    await rmBestEffort(userData);
  }
});
