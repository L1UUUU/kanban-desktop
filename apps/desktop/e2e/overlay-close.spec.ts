// 用途：可关闭浮层整机 E2E（issue #83 / spec #82）—— 权限档位菜单与模型下拉共享关闭交互的两条路径（点击外部 / Esc）真窗口断言；
// 经草稿面板同时驱动两浮层（Fake 演示链路，真实 CLI 全部禁用回落 Fake；无需建会话，与 model-combobox.spec.ts 同 launch/env 模式）
import { test, expect, _electron, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmBestEffort } from "./helpers/rm-best-effort";

const PROJECT_NAME = "kb-overlay-close";

/** 建隔离 fixture：独立 userData + 伪 git 主仓库目录 */
function makeFixture(): { userData: string; repoDir: string; repoRoot: string } {
  const userData = mkdtempSync(join(tmpdir(), "kb-ovl-user-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "kb-ovl-repo-"));
  const repoDir = join(repoRoot, PROJECT_NAME);
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  return { userData, repoDir, repoRoot };
}

/** 启动应用（Fake 演示链路：三真实 CLI 全部禁用回落 Fake；userData 隔离） */
async function launchApp(userData: string, repoDir: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await _electron.launch({
    args: [join(__dirname, "..")],
    env: {
      ...process.env,
      KANBAN_USER_DATA: userData,
      KANBAN_TEST_PICK_DIRECTORY: repoDir,
      KANBAN_DISABLE_CODEX: "1",
      KANBAN_DISABLE_CLAUDE: "1",
      KANBAN_DISABLE_OPENCODE: "1",
    },
  });
  const win = await app.firstWindow();
  return { app, win };
}

/** 注册项目并经项目行「＋」打开 Claude 草稿（权限 chip 与模型 combobox 同在草稿 composer），返回草稿面板根 */
async function openClaudeDraftPane(win: Page): Promise<Locator> {
  await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
  await expect(win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
  await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
  await win.getByRole("button", { name: "＋", exact: true }).click();
  await win.getByRole("button", { name: "Claude", exact: true }).click();
  await expect(win.getByTestId("draft-hint")).toBeVisible({ timeout: 10_000 });
  return win.getByTestId("draft-pane");
}

test("可关闭浮层：点击外部与 Esc 两种路径关闭权限菜单和模型下拉", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    const { app, win } = await launchApp(userData, repoDir);
    const pane = await openClaudeDraftPane(win);
    // 模型就绪（默认选中 Fake 标准模型）后再驱动浮层，避免加载态只读干扰
    const combo = pane.getByRole("combobox");
    await expect(combo).toHaveValue("Fake 标准模型", { timeout: 15_000 });
    // 浮层外点击落点：草稿提示条（pane 顶部，两浮层均向上展开且宽度有限，永远盖不到它）
    const outside = pane.getByTestId("draft-hint");
    const permChip = pane.getByRole("button", { name: "⚡ 权限：自动 ▾" }); // 草稿默认档 auto
    const permMenuDesc = pane.getByText("所有工具调用前弹出审批卡片"); // 菜单内 ask 档说明行（chip 本体不含）
    const listbox = win.getByRole("listbox", { name: "模型列表" });

    // —— 权限菜单：点击外部关闭
    await permChip.click();
    await expect(permMenuDesc).toBeVisible();
    await outside.click();
    await expect(permMenuDesc).toBeHidden();

    // —— 权限菜单：Esc 关闭
    await permChip.click();
    await expect(permMenuDesc).toBeVisible();
    await win.keyboard.press("Escape");
    await expect(permMenuDesc).toBeHidden();

    // —— 模型下拉：点击外部关闭（既有行为回归）
    await combo.focus();
    await expect(listbox).toBeVisible();
    await outside.click();
    await expect(listbox).toBeHidden();

    // —— 模型下拉：Esc 关闭（#83 起与权限菜单共享）
    await combo.focus();
    await expect(listbox).toBeVisible();
    await combo.press("Escape");
    await expect(listbox).toBeHidden();

    await app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});
