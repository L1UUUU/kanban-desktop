// 用途：斜杠补全菜单整机 E2E（issue #90 / spec #82 E 块；ADR 0004 零内置）—— 真 preload/IPC/Main CommandCatalog/FakeAdapter 全链：输入 / 弹菜单为空态引导（fake 会话无命令源，不填充占位命令）、Esc 关闭同 token 不重开（token 改变复弹）
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
    // Fake 演示模式：真实 CLI 回落 Fake（ADR 0004：fake 无命令源 → 菜单空态）；禁真实 CLI 与 opencode server 拉起
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

test("输入 / 弹菜单为空态引导（fake 无命令源 + 零内置：无占位命令）→ Esc 关闭同 token 不重开，token 改变复弹", async () => {
  const t = await launchApp();
  const { app, win } = t;

  // boot：无项目无会话 → Fake 演示草稿（草稿态输入框生效）
  const box = win.getByPlaceholder("输入消息，/ 开头触发 Skill…");
  await expect(win.getByTestId("draft-pane")).toBeVisible({ timeout: 15_000 });
  await box.click();

  // —— 输入 /：菜单弹出为空态（预热完成即 ready；fake 目录空集 + 零内置 → 无任何条目，仅引导文案）
  await box.pressSequentially("/");
  const menu = win.getByTestId("slash-menu");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect(menu).toContainText("无可用命令"); // 空态引导（降级判据：未匹配按原样发送）
  await expect(menu.getByTestId("slash-menu-item")).toHaveCount(0); // 无条目（含无 /pty /kanban 占位）

  // —— Esc 关闭且同一 token 不再弹出；token 改变后复弹（仍空态）
  await box.press("Escape");
  await expect(menu).toBeHidden();
  await box.press("ArrowDown"); // 同 token 内按键：不重开
  await expect(menu).toBeHidden();
  await box.pressSequentially("p"); // token 改变（/ → /p）：复弹
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect(menu).toContainText("无可用命令");

  await app.close();
  await t.cleanup();
});
