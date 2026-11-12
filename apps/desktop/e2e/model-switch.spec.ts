// 用途：会话中途切换模型整机 E2E（issue #81 / spec #75 收口，真实 preload/IPC/worker 全链驱动 Fake）——
// 成功：点选候选 → chip 立即更新 + 「模型已切换，下一轮起生效」提示 → 发下一轮提示自动收起、chip 保持新模型；
// 失败回滚（KANBAN_FAKE_SETMODEL_FAIL_FIRST 注入）：chip 回滚切换前值 + 会话内错误卡原文展示（含模型名）+ 会话仍可继续。
// 截图归档 docs/acceptance/model-combobox/（KANBAN_UPDATE_SCREENSHOTS=1 时写回）。
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shot } from "./helpers/acceptance-artifacts";

const PROJECT_NAME = "kb-model-switch";
const SHOT_DIR = resolve(__dirname, "../../../docs/acceptance/model-combobox");

/** 建隔离 fixture：独立 userData + 伪 git 主仓库目录 */
function makeFixture(): { userData: string; repoDir: string; repoRoot: string } {
  const userData = mkdtempSync(join(tmpdir(), "kb-ms-user-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "kb-ms-repo-"));
  const repoDir = join(repoRoot, PROJECT_NAME);
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  return { userData, repoDir, repoRoot };
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

/** 启动应用（Fake 演示链路：真实 CLI 回落 Fake；userData 隔离；extraEnv 透传切换失败注入） */
async function launchApp(userData: string, repoDir: string, extraEnv?: Record<string, string>): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await _electron.launch({
    args: [join(__dirname, "..")],
    env: {
      ...process.env,
      KANBAN_USER_DATA: userData,
      KANBAN_TEST_PICK_DIRECTORY: repoDir,
      KANBAN_DISABLE_CODEX: "1",
      KANBAN_DISABLE_CLAUDE: "1",
      KANBAN_DISABLE_OPENCODE: "1",
      ...extraEnv,
    },
  });
  const win = await app.firstWindow();
  return { app, win };
}

/** 在 composer 输入并发送 */
async function send(win: Page, text: string): Promise<void> {
  await win.getByPlaceholder("输入消息，/ 开头触发 Skill…").fill(text);
  await win.getByRole("button", { name: "发送 ➤" }).click();
}

/** 注册项目并建首个 Claude 会话（发首条消息才创建），等首轮流式完成回到空闲 */
async function createSession(win: Page): Promise<void> {
  await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
  await expect(win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
  await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
  await win.getByRole("button", { name: "＋", exact: true }).click();
  await win.getByRole("button", { name: "Claude", exact: true }).click();
  await expect(win.getByTestId("draft-hint")).toBeVisible({ timeout: 10_000 });
  await send(win, "首条消息（建立会话）");
  await expect(win.getByText("新会话 · Claude").first()).toBeVisible({ timeout: 10_000 });
  await expect(win.getByText("空闲").first()).toBeVisible({ timeout: 30_000 }); // 首轮结束：idle 可切
}

test("切换成功：chip 立即更新 + 「下一轮起生效」提示 → 新一轮开始提示收起、chip 保持", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    const { app, win } = await launchApp(userData, repoDir);
    await createSession(win);

    // 已建会话 composer：chip 显示创建模型（默认选中随首条下发）；点选候选切换
    const combo = win.getByRole("combobox");
    await expect(combo).toHaveValue("Fake 标准模型");
    await combo.focus();
    await win.getByRole("listbox", { name: "模型列表" }).getByRole("option", { name: /Fake 轻量模型/ }).click();

    // 成功：chip 立即显示新模型 + 「下一轮起生效」提示（当前轮仍用旧模型）
    await expect(combo).toHaveValue("Fake 轻量模型");
    const note = win.getByTestId("model-switch-note");
    await expect(note).toBeVisible({ timeout: 10_000 });
    await expect(note).toContainText("模型已切换，下一轮起生效");
    await shot(win, SHOT_DIR, "05-model-switch-note.png");

    // 发下一轮：turn 开始提示自动收起；回复照常、chip 保持新模型（最终态）
    await send(win, "第二轮：换模型后继续");
    await expect(note).toHaveCount(0, { timeout: 10_000 });
    await expect(win.getByText("基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。")).toBeVisible({ timeout: 30_000 });
    await expect(win.getByText("空闲").first()).toBeVisible({ timeout: 20_000 });
    await expect(combo).toHaveValue("Fake 轻量模型");

    await app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("切换失败回滚（注入）：chip 回切换前值 + 会话错误卡原文（含模型名）+ 会话仍可继续", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    // 前一次 setModel 抛 AdapterError：驱动失败回滚（创建链路计数独立，不受影响）
    const { app, win } = await launchApp(userData, repoDir, { KANBAN_FAKE_SETMODEL_FAIL_FIRST: "1" });
    await createSession(win);

    const combo = win.getByRole("combobox");
    await expect(combo).toHaveValue("Fake 标准模型");
    await combo.focus();
    await win.getByRole("listbox", { name: "模型列表" }).getByRole("option", { name: /Fake 轻量模型/ }).click();

    // 失败：chip 回滚为切换前值，无「下一轮起生效」提示；错误按会话内既有形态展示（原文含模型名）
    await expect(combo).toHaveValue("Fake 标准模型", { timeout: 10_000 });
    await expect(win.getByTestId("model-switch-note")).toHaveCount(0);
    const card = win.getByTestId("error-card");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText("注入的模型切换失败");
    await expect(card).toContainText("fake-lite");
    await shot(win, SHOT_DIR, "06-model-switch-rollback.png");

    // 会话不受切换失败破坏：继续发消息照常完成
    await send(win, "切换失败后继续");
    await expect(win.getByText("基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。")).toBeVisible({ timeout: 30_000 });
    await expect(win.getByText("空闲").first()).toBeVisible({ timeout: 20_000 });

    await app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});
