// 用途：项目管理与会话恢复 E2E（#7 验收第 1/2/3/5 条）—— 注册项目 → 「＋」菜单新建会话（主仓库徽标）→ 重启恢复（项目/会话/当前项目/断开态），全链经真 preload/IPC/SQLite
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_NAME = "e2e-repo";

/** 尽力删除目录：Windows 下 electron/Crashpad 子进程退出有延迟，重试后仍锁则告警放行（残留 %TEMP% 由系统清理，不应判定测试失败） */
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

/** 建隔离 fixture：独立 userData + 伪 git 主仓库目录（.git 目录即主仓库形态） */
function makeFixture(): { userData: string; repoDir: string } {
  const userData = mkdtempSync(join(tmpdir(), "kb-e2e-user-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "kb-e2e-repo-"));
  const repoDir = join(repoRoot, PROJECT_NAME);
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  return { userData, repoDir };
}

/** 启动应用（env 隔离 userData；KANBAN_TEST_PICK_DIRECTORY 固定目录选择，跳过原生模态；KANBAN_DISABLE_CODEX=1 走 Fake 演示模式——本套验证 UI 行为，真实 Codex 链路由 cli-host e2e 覆盖） */
async function launchApp(userData: string, repoDir?: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await _electron.launch({
    args: [join(__dirname, "..")],
    env: {
      ...process.env,
      KANBAN_USER_DATA: userData,
      KANBAN_DISABLE_CODEX: "1",
      ...(repoDir ? { KANBAN_TEST_PICK_DIRECTORY: repoDir } : {}),
    },
  });
  const win = await app.firstWindow();
  return { app, win };
}

/** 点常驻「＋ 注册」入口完成注册并等项目行出现 */
async function registerProject(win: Page, projectName: string): Promise<void> {
  await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
  await expect(win.locator("aside").getByText(projectName, { exact: true })).toBeVisible({ timeout: 15_000 });
}

/** 项目行悬浮「＋」→ 菜单选 CLI 新建会话（原型一致项 2） */
async function createSession(win: Page, cliLabel: string): Promise<void> {
  await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
  await win.getByRole("button", { name: "＋", exact: true }).click();
  await win.getByRole("button", { name: cliLabel, exact: true }).click();
  await expect(win.getByText(`新会话 · ${cliLabel}`).first()).toBeVisible({ timeout: 10_000 });
}

test("注册项目 → 新建会话（主仓库徽标）→ 重启完整恢复（项目/会话/当前项目/断开态）", async () => {
  const { userData, repoDir } = makeFixture();
  const repoRoot = join(repoDir, "..");
  try {
    // —— 第一次启动：空态引导可见 → 注册 → 项目行出现
    const first = await launchApp(userData, repoDir);
    await expect(first.win.getByText("尚无项目")).toBeVisible({ timeout: 15_000 });
    await registerProject(first.win, PROJECT_NAME);

    // 「＋」菜单四项可见（一致项 2）；Claude 新建 → 会话行 + 主仓库徽标 + 空闲徽标（一致项 3）
    await first.win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
    await first.win.getByRole("button", { name: "＋", exact: true }).click();
    await expect(first.win.getByText("Codex")).toBeVisible();
    await expect(first.win.getByText("OpenCode")).toBeVisible();
    await expect(first.win.getByRole("button", { name: /PTY 终端/ })).toBeVisible();
    // PTY 项新建终端会话（#12 实体）：PTY 分组出现会话行 + xterm 面板挂起
    await first.win.getByRole("button", { name: /PTY 终端/ }).click();
    await expect(first.win.getByText(/^终端 · /).first()).toBeVisible({ timeout: 10_000 });
    await expect(first.win.locator(".xterm").first()).toBeVisible({ timeout: 10_000 });
    // 切回 Claude 会话建结构化会话（PTY 已占位激活，重新 hover 打开菜单）
    await first.win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
    await first.win.getByRole("button", { name: "＋", exact: true }).click();
    await first.win.getByRole("button", { name: "Claude", exact: true }).click();
    await expect(first.win.getByText("新会话 · Claude").first()).toBeVisible({ timeout: 10_000 });
    // 主仓库徽标（cwd 为 Main 侧 canonical 化后的路径，用正则断言；PTY 终端行同徽标 → first）
    await expect(first.win.getByTitle(/工作在主仓库（.*e2e-repo）/).first()).toBeVisible();
    await expect(first.win.getByText("空闲").first()).toBeVisible();
    await first.app.close();

    // —— 重启（同一 userData，无固定目录选择）：项目、当前项目与会话列表恢复；会话呈断开态
    const second = await launchApp(userData);
    await expect(second.win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(second.win.getByText("新会话 · Claude").first()).toBeVisible({ timeout: 10_000 });
    await expect(second.win.getByText("已断开").first()).toBeVisible();
    // 断开会话视图提示 + 当前项目过滤（boot 演示会话不再创建）
    await second.win.getByText("新会话 · Claude").first().click();
    await expect(second.win.getByText("该会话来自上次运行（CLI 已退出）。缓存不替代原生历史。")).toBeVisible();
    await expect(second.win.getByText("演示会话 · Fake")).toHaveCount(0);
    await second.app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("多项目并存与切换、目录缺失标记", async () => {
  const { userData, repoDir } = makeFixture();
  const repoRoot = join(repoDir, "..");
  const secondRepo = join(repoRoot, "e2e-repo-2");
  mkdirSync(join(secondRepo, ".git"), { recursive: true });
  try {
    // 注册第一个项目并建 Codex 会话
    const a = await launchApp(userData, repoDir);
    await registerProject(a.win, PROJECT_NAME);
    await createSession(a.win, "Codex");
    await a.app.close();

    // 第二次启动：常驻「＋ 注册」注册第二个项目（注册即切换为当前项目）
    const b = await launchApp(userData, secondRepo);
    await registerProject(b.win, "e2e-repo-2");
    // 注册即切换：当前项目=e2e-repo-2（其会话列表为空；e2e-repo 的会话被过滤）
    await expect(b.win.getByText("暂无会话")).toBeVisible();
    await expect(b.win.getByText("新会话 · Codex")).toHaveCount(0);
    // 点回第一个项目：会话恢复可见
    await b.win.locator("aside").getByText(PROJECT_NAME, { exact: true }).click();
    await expect(b.win.getByText("新会话 · Codex").first()).toBeVisible({ timeout: 10_000 });
    await b.app.close();

    // —— 删除第一个项目目录后重启：目录缺失标记可见（启动探测）
    rmSync(repoDir, { recursive: true, force: true });
    const c = await launchApp(userData);
    await expect(c.win.getByText("目录缺失").first()).toBeVisible({ timeout: 15_000 });
    await expect(c.win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible();
    await c.app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});
