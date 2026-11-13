// 用途：CLI 安装状态「＋」菜单禁用态整机 E2E（#80 spec #75）—— KANBAN_TEST_CLI_STATUS_JSON 种子驱动（Fake 会话链路与菜单显示状态解耦）：侧栏项目「＋」与详情面板「＋新建会话」两处菜单未装项灰置 + 「未安装」标注 + 点击无效（不出现草稿）；已装项与 PTY 恒可选；种子翻转（模拟装完）后重开菜单恢复可选（无需重启应用）
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_NAME = "e2e-cli-status";

/** 建隔离 fixture：独立 userData + 伪 git 主仓库 + cli:status 种子 JSON（初始 claude 未装） */
function makeFixture(): { userData: string; repoDir: string; seedPath: string; roots: string[] } {
  const userData = mkdtempSync(join(tmpdir(), "kb-cs-user-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "kb-cs-repo-"));
  const repoDir = join(repoRoot, PROJECT_NAME);
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  const seedDir = mkdtempSync(join(tmpdir(), "kb-cs-seed-"));
  const seedPath = join(seedDir, "cli-status.json");
  writeFileSync(seedPath, JSON.stringify({ codex: true, claude: false, opencode: true }), "utf8");
  return { userData, repoDir, seedPath, roots: [userData, repoRoot, seedDir] };
}

/** 尽力删除目录：Windows 下 electron 子进程退出有延迟，重试后仍锁则告警放行（不应判定测试失败） */
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

/** 启动应用：Fake 会话链路（DISABLE_*）+ userData 隔离 + 固定目录选择 + cli:status 种子探测 */
async function launchApp(userData: string, repoDir: string, seedPath: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await _electron.launch({
    args: [join(__dirname, "..")],
    env: {
      ...process.env,
      KANBAN_USER_DATA: userData,
      KANBAN_DISABLE_CODEX: "1",
      KANBAN_DISABLE_CLAUDE: "1",
      KANBAN_DISABLE_OPENCODE: "1",
      KANBAN_TEST_PICK_DIRECTORY: repoDir,
      KANBAN_TEST_CLI_STATUS_JSON: seedPath,
    },
  });
  const win = await app.firstWindow();
  return { app, win };
}

/** 点常驻「＋ 注册」完成注册并等项目行出现 */
async function registerProject(win: Page): Promise<void> {
  await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
  await expect(win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
}

/** 打开侧栏项目行悬浮「＋」菜单（hover 显隐按钮） */
async function openSidebarMenu(win: Page): Promise<void> {
  await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
  await win.getByRole("button", { name: "＋", exact: true }).click();
}

test("两处「＋」菜单未装项灰置 + 「未安装」标注 + 点击无效；已装项与 PTY 恒可选", async () => {
  const { userData, repoDir, seedPath, roots } = makeFixture();
  try {
    const { app, win } = await launchApp(userData, repoDir, seedPath);
    await registerProject(win);

    // 侧栏项目「＋」菜单：claude 未装灰置（可访问名 = 标签 + 标注，Chromium 与 jsdom 空格拼接差异用 \s* 吸收）+ 悬停说明
    await openSidebarMenu(win);
    const claudeItem = win.locator("aside").getByRole("button", { name: /Claude\s*未安装/ });
    await expect(claudeItem).toBeDisabled();
    await expect(claudeItem).toContainText("未安装");
    await expect(claudeItem).toHaveAttribute("title", expect.stringContaining("未安装"));

    // 点击无效：不出现草稿（禁用按钮不派发 click；force 点击同样无效）
    await claudeItem.click({ force: true });
    await expect(win.getByTestId("draft-hint")).toBeHidden();

    // 已装项可选（点击打开草稿）与 PTY 项恒可选
    const codexItem = win.locator("aside").getByRole("button", { name: "Codex", exact: true });
    await expect(codexItem).toBeEnabled();
    await codexItem.click();
    await expect(win.getByTestId("draft-hint")).toBeVisible({ timeout: 10_000 });
    await expect(win.getByTestId("draft-hint")).toContainText("新会话 · Codex");

    // 详情面板「＋新建会话」菜单（看板手动建卡 → 点卡开详情面板）：同一禁用逻辑
    await win.getByTestId("kanban-entry").click();
    const noneCol = win.getByTestId("kanban-col-none");
    await noneCol.getByTitle("手动新建需求（归属当前项目）").click();
    // #84 建卡即命名：Esc 放弃命名保留缺省标题
    const nameInput = noneCol.getByTestId("card-title-input");
    await expect(nameInput).toBeVisible({ timeout: 10_000 });
    await nameInput.press("Escape");
    await expect(noneCol.getByText("待命名需求")).toBeVisible({ timeout: 10_000 });
    await noneCol.getByText("待命名需求").click();
    await expect(win.getByTestId("detail-panel")).toBeVisible();
    await win.getByTestId("new-session-menu").click();
    await expect(win.getByTestId("new-session-item-claude")).toBeDisabled();
    await expect(win.getByTestId("new-session-item-claude")).toContainText("未安装");
    await expect(win.getByTestId("new-session-item-codex")).toBeEnabled();
    await expect(win.getByTestId("new-session-item-pty")).toBeEnabled();

    await app.close();
  } finally {
    for (const root of roots) await rmBestEffort(root);
  }
});

test("探测翻转（模拟装完 claude）：重开侧栏菜单恢复可选并打开草稿，无需重启应用", async () => {
  const { userData, repoDir, seedPath, roots } = makeFixture();
  try {
    const { app, win } = await launchApp(userData, repoDir, seedPath);
    await registerProject(win);

    // 初始未装：灰置
    await openSidebarMenu(win);
    await expect(win.locator("aside").getByRole("button", { name: /Claude\s*未安装/ })).toBeDisabled();

    // 模拟装完（改写种子文件即探测翻转）→ 关菜单重开：恢复可选
    writeFileSync(seedPath, JSON.stringify({ codex: true, claude: true, opencode: true }), "utf8");
    await win.getByRole("button", { name: "＋", exact: true }).click(); // 关菜单
    await openSidebarMenu(win);
    const claudeItem = win.locator("aside").getByRole("button", { name: "Claude", exact: true });
    await expect(claudeItem).toBeEnabled();
    await expect(claudeItem).not.toContainText("未安装");
    await claudeItem.click();
    await expect(win.getByTestId("draft-hint")).toBeVisible({ timeout: 10_000 });
    await expect(win.getByTestId("draft-hint")).toContainText("新会话 · Claude");

    await app.close();
  } finally {
    for (const root of roots) await rmBestEffort(root);
  }
});
