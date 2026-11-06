// 用途：看板视图 E2E（#18 验收）—— 侧栏「看板」入口 → 五列看板（Fake 全链）；verified design-feature 自动建卡实时出现；视图切换回聊天会话仍在；重启后 kanban:list 再水化看板与退出前一致（对照原型一致项 1/2/3）
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PROJECT_NAME = "kb-kanban-board";

/** 建隔离 fixture：独立 userData + 伪 git 主仓库目录 */
function makeFixture(): { userData: string; repoDir: string; repoRoot: string } {
  const userData = mkdtempSync(join(tmpdir(), "kb-kb-user-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "kb-kb-repo-"));
  const repoDir = join(repoRoot, PROJECT_NAME);
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  return { userData, repoDir, repoRoot };
}

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

/** 启动应用（Fake 演示链路：真实 CLI 回落 Fake；userData 隔离） */
async function launchApp(userData: string, repoDir?: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await _electron.launch({
    args: [resolve(__dirname, "..")],
    env: {
      ...process.env,
      KANBAN_USER_DATA: userData,
      KANBAN_DISABLE_CLAUDE: "1",
      KANBAN_DISABLE_OPENCODE: "1",
      ...(repoDir ? { KANBAN_TEST_PICK_DIRECTORY: repoDir } : {}),
    },
  });
  const win = await app.firstWindow();
  return { app, win };
}

/** 注册项目 + 建首个 Claude（Fake）会话 */
async function registerAndCreate(win: Page): Promise<void> {
  await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
  await expect(win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
  await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
  await win.getByRole("button", { name: "＋", exact: true }).click();
  await win.getByRole("button", { name: "Claude", exact: true }).click();
  await expect(win.getByText("新会话 · Claude").first()).toBeVisible({ timeout: 10_000 });
}

/** 发送 "/design-feature verified"（Fake 脚本以 claude-code 口径发 verified 观察信号 → tracker 自动建卡） */
async function sendVerifiedDesignFeature(win: Page): Promise<void> {
  await win.getByPlaceholder("输入消息，/ 开头触发 Skill…").fill("/design-feature verified 设计阶段2看板");
  await win.getByRole("button", { name: "发送 ➤" }).click();
}

test("看板入口 → 五列看板 → verified design-feature 卡片实时出现（Design 列）→ 切回聊天会话仍在", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    const { app, win } = await launchApp(userData, repoDir);
    await registerAndCreate(win);

    // 侧栏底部「看板」入口（带当前项目指示）→ 看板视图：五列（原型一致项 1/2）
    await expect(win.getByTestId("kanban-entry")).toContainText(PROJECT_NAME);
    await win.getByTestId("kanban-entry").click();
    await expect(win.getByTestId("kanban-board")).toBeVisible();
    for (const key of ["none", "Design", "Implement", "PR", "Retro"]) {
      await expect(win.getByTestId(`kanban-col-${key}`)).toBeVisible();
    }

    // 切回聊天发送 verified skill（会话未因视图切换中断）
    await win.getByTestId("kanban-entry").click();
    await sendVerifiedDesignFeature(win);
    // 发送后立即进看板：卡片无需任何刷新动作实时出现（tracker:event 推送驱动）
    await win.getByTestId("kanban-entry").click();
    const designCol = win.getByTestId("kanban-col-Design");
    await expect(designCol.getByText("待命名需求")).toBeVisible({ timeout: 10_000 });
    await expect(designCol.getByText("◍ 1 会话")).toBeVisible(); // 自动建卡关联触发会话
    await expect(designCol.getByTestId("verified-badge").first()).toBeVisible(); // verified 绿徽标
    await expect(designCol.getByTestId("kanban-col-count")).toHaveText("1");

    // 切回聊天：会话完成回空闲（CLI 生命周期与视图切换无关）
    await win.getByTestId("kanban-entry").click();
    await expect(win.getByText("空闲").first()).toBeVisible({ timeout: 20_000 });

    await app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("重启再水化：退出前 Design 列有卡 → 重启后看板与退出前一致（kanban:list 再水化，S2-17）", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    // 第一次运行：建卡后退出
    const first = await launchApp(userData, repoDir);
    await registerAndCreate(first.win);
    await sendVerifiedDesignFeature(first.win);
    await first.win.getByTestId("kanban-entry").click();
    const designCol1 = first.win.getByTestId("kanban-col-Design");
    await expect(designCol1.getByText("待命名需求")).toBeVisible({ timeout: 10_000 });
    await expect(designCol1.getByTestId("kanban-col-count")).toHaveText("1");
    await first.app.close();

    // 重启（同一 userData）：tracker 重放不产生推送，靠 kanban:list 再水化 → 看板一致
    const second = await launchApp(userData);
    await second.win.getByTestId("kanban-entry").click();
    const designCol2 = second.win.getByTestId("kanban-col-Design");
    await expect(designCol2.getByText("待命名需求")).toBeVisible({ timeout: 15_000 });
    await expect(designCol2.getByText("◍ 1 会话")).toBeVisible();
    await expect(designCol2.getByTestId("verified-badge").first()).toBeVisible();
    await expect(designCol2.getByTestId("kanban-col-count")).toHaveText("1");
    await second.app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});
