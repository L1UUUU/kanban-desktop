// 用途：斜杠补全菜单整机 E2E（issue #90 / spec #82 E 块）—— 真 preload/IPC/Main CommandCatalog/FakeAdapter 固定命令集全链：输入 / 弹菜单、键盘导航与接受、Esc 关闭同 token 不重开（token 改变复弹）
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** 建隔离 fixture：独立 userData（无项目无会话 → boot 自动打开 Fake 演示草稿，草稿态即被测面） */
function makeFixture(): { userData: string } {
  return { userData: mkdtempSync(join(tmpdir(), "kb-slash-user-")) };
}

async function launchApp(): Promise<{ app: ElectronApplication; win: Page; cleanup(): Promise<void> }> {
  const { userData } = makeFixture();
  const app = await _electron.launch({
    args: [resolve(__dirname, "..")],
    // Fake 演示模式：真实 CLI 回落 Fake（固定命令集稳定可断言）；禁真实 CLI 与 opencode server 拉起
    env: {
      ...process.env,
      KANBAN_USER_DATA: userData,
      KANBAN_DISABLE_CLAUDE: "1",
      KANBAN_DISABLE_OPENCODE: "1",
    },
  });
  const win = await app.firstWindow();
  return {
    app,
    win,
    cleanup: async () => {
      for (let i = 0; i < 20; i += 1) {
        try {
          rmSync(userData, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      console.warn(`[e2e] 临时目录仍被占用，跳过清理：${userData}`);
    },
  };
}

test("输入 / 弹菜单（FakeAdapter 固定集可见）→ 键盘导航 Enter 接受置入输入流 → Esc 关闭同 token 不重开", async () => {
  const t = await launchApp();
  const { app, win } = t;

  // boot：无项目无会话 → Fake 演示草稿（草稿态输入框生效）
  const box = win.getByPlaceholder("输入消息，/ 开头触发 Skill…");
  await expect(win.getByTestId("draft-pane")).toBeVisible({ timeout: 15_000 });
  await box.click();

  // —— 输入 /：菜单弹出（预热使首次输入不等冷启动），fake 固定集 + 内置应用命令可见
  await box.pressSequentially("/");
  const menu = win.getByTestId("slash-menu");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect(menu.getByTestId("slash-menu-item").filter({ hasText: "/fake-plan" })).toBeVisible();
  await expect(menu.getByTestId("slash-menu-item").filter({ hasText: "/fake-user-only" })).toBeVisible();
  // 分组顺序：应用命令在前（/pty）、CLI 命令在后（/fake-*）
  const names = await menu.getByTestId("slash-menu-item").allInnerTexts();
  const idxPty = names.findIndex((s) => s.includes("/pty"));
  const idxFake = names.findIndex((s) => s.includes("/fake-plan"));
  expect(idxPty).toBeGreaterThanOrEqual(0);
  expect(idxFake).toBeGreaterThan(idxPty);
  // 初始高亮第 0 项（/kanban）
  await expect(menu.getByTestId("slash-menu-item").first()).toHaveAttribute("aria-selected", "true");

  // —— 键盘导航：ArrowDown 高亮下移到 /pty，Enter 接受置入输入流（不发送，派发在 #92）
  await box.press("ArrowDown");
  await expect(menu.getByTestId("slash-menu-item").nth(1)).toHaveAttribute("aria-selected", "true");
  await box.press("Enter");
  await expect(box).toHaveValue("/pty ");
  await expect(menu).toBeHidden();

  // —— Esc 关闭且同一 token 不再弹出；token 改变后复弹
  await box.fill("");
  await box.pressSequentially("/");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await box.press("Escape");
  await expect(menu).toBeHidden();
  await box.press("ArrowDown"); // 同 token 内按键：不重开
  await expect(menu).toBeHidden();
  await box.pressSequentially("p"); // token 改变（/ → /p）：复弹
  await expect(menu).toBeVisible({ timeout: 10_000 });

  await app.close();
  await t.cleanup();
});
