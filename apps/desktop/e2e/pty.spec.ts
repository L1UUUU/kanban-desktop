// 用途：PTY 终端全链 E2E（#12 验收第 2 条 + 工单 E2E 项；#60 草稿语义）—— 真实 ConPTY PowerShell：点「＋」只开草稿（不落库不进侧栏）→ 首个键入触发创建 → 回显 → 切结构化会话再切回（终端内容保留、进程仍活）→ 显式停止 → 重启恢复断开态条目
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_NAME = "e2e-pty";

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

/** 建隔离 fixture：独立 userData + 伪 git 主仓库目录 */
function makeFixture(): { userData: string; repoDir: string } {
  const userData = mkdtempSync(join(tmpdir(), "kb-e2e-pty-user-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "kb-e2e-pty-repo-"));
  const repoDir = join(repoRoot, PROJECT_NAME);
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  return { userData, repoDir };
}

/** 启动应用（env 隔离 userData；固定目录选择跳过原生模态） */
async function launchApp(userData: string, repoDir?: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await _electron.launch({
    args: [join(__dirname, "..")],
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

/** 在终端面板键入文本并回车（点击 .xterm 聚焦后走键盘事件 → term.onData → terminal:write） */
async function typeInTerminal(win: Page, line: string): Promise<void> {
  await win.locator(".xterm").first().click();
  await win.keyboard.type(line);
  await win.keyboard.press("Enter");
}

test("PTY 终端：草稿 → 首输入创建 → 回显 → 切结构化会话再切回（内容保留/进程仍活）→ 停止 → 重启恢复断开态", async () => {
  const { userData, repoDir } = makeFixture();
  const repoRoot = join(repoDir, "..");
  try {
    // —— 第一次启动：注册项目 → 「＋」PTY 项只打开终端草稿（#60：不落库、不进侧栏、不起进程）
    const first = await launchApp(userData, repoDir);
    await first.win.getByRole("button", { name: "＋ 注册", exact: true }).click();
    await expect(first.win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });

    await first.win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
    await first.win.getByRole("button", { name: "＋", exact: true }).click();
    await first.win.getByRole("button", { name: /PTY 终端/ }).click();

    // 草稿态：提示可见 + xterm 面板可交互 + 侧栏 PTY 分组仍为空态
    await expect(first.win.getByText(/终端草稿 · 尚未启动进程/)).toBeVisible({ timeout: 15_000 });
    await expect(first.win.locator(".xterm").first()).toBeVisible({ timeout: 15_000 });
    await expect(first.win.getByText("暂无终端会话")).toBeVisible();

    // 首个键入触发创建（真实 ConPTY；首输入由 Main 重放不丢失）→ PTY 分组出现会话行 + 空闲徽标 + 回显可见
    await typeInTerminal(first.win, "echo kb-pty-marker-1");
    await expect(first.win.getByText(/^终端 · /).first()).toBeVisible({ timeout: 15_000 });
    await expect(first.win.getByText("空闲").first()).toBeVisible();
    await expect(first.win.getByText(/kb-pty-marker-1/).first()).toBeVisible({ timeout: 20_000 });

    // 建结构化会话并切换（#59 草稿：发首条消息才建）：PTY 面板卸载（xterm 元素消失），PTY 会话行保留
    await first.win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
    await first.win.getByRole("button", { name: "＋", exact: true }).click();
    await first.win.getByRole("button", { name: "Claude", exact: true }).click();
    await expect(first.win.getByTestId("draft-hint")).toBeVisible({ timeout: 10_000 });
    await first.win.getByPlaceholder("输入消息，/ 开头触发 Skill…").fill("首条消息（建立会话）");
    await first.win.getByRole("button", { name: "发送 ➤" }).click();
    await expect(first.win.getByText("新会话 · Claude").first()).toBeVisible({ timeout: 10_000 });
    await expect(first.win.getByPlaceholder("输入消息，/ 开头触发 Skill…")).toBeVisible();
    await expect(first.win.locator(".xterm")).toHaveCount(0);

    // 切回 PTY：终端内容保留（marker 仍在缓冲）且进程仍活（新命令继续回显）
    await first.win.getByText(/^终端 · /).first().click();
    await expect(first.win.locator(".xterm").first()).toBeVisible({ timeout: 10_000 });
    await expect(first.win.getByText(/kb-pty-marker-1/).first()).toBeVisible({ timeout: 10_000 });
    await typeInTerminal(first.win, "echo kb-pty-alive");
    await expect(first.win.getByText(/kb-pty-alive/).first()).toBeVisible({ timeout: 20_000 });

    // 显式停止（面板顶栏按钮 = 唯一停止入口）→ 状态徽标已断开
    await first.win.getByRole("button", { name: "⏹ 停止终端" }).click();
    await expect(first.win.getByText("已断开").first()).toBeVisible({ timeout: 15_000 });
    await first.app.close();

    // —— 重启（同一 userData）：PTY 会话恢复为断开态条目（进程不在），点击显示断开占位
    const second = await launchApp(userData);
    await expect(second.win.getByText(/^终端 · /).first()).toBeVisible({ timeout: 15_000 });
    await expect(second.win.getByText("已断开").first()).toBeVisible();
    await second.win.getByText(/^终端 · /).first().click();
    await expect(second.win.getByText(/该终端进程已结束/)).toBeVisible({ timeout: 10_000 });
    await second.app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});
