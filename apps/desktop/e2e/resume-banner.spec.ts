// 用途：恢复引导条三态流转整机 E2E（#42 验收 5 / spec I 一致项 3）—— 断开 → 点击恢复 → 恢复中（不可中断）→ 成功收敛；失败 → 重试 → 收敛；
// Fake 驱动（KANBAN_DISABLE_* 三件套 + Fake resume 注入钩子）
// + #56（spec #52 验收 2 C 类）：resume 失败日志留痕断言（含会话标识；注入设施实际归属本 spec 与 stage4-acceptance-screenshots，M10）
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunEntries } from "./log-run";

const PROJECT_NAME = "kb-resume";

/** 建隔离 fixture：独立 userData + 伪 git 主仓库目录 */
function makeFixture(): { userData: string; repoDir: string; repoRoot: string } {
  const userData = mkdtempSync(join(tmpdir(), "kb-resume-user-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "kb-resume-repo-"));
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

/**
 * 启动应用（Fake 演示链路：真实 CLI 回落 Fake；userData 隔离）。
 * extraEnv：#42 Fake resume 注入钩子（KANBAN_FAKE_RESUME_DELAY_MS 观察「恢复中」态 / KANBAN_FAKE_RESUME_FAIL_FIRST 驱动失败态）。
 */
async function launchApp(userData: string, repoDir?: string, extraEnv?: Record<string, string>): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await _electron.launch({
    args: [join(__dirname, "..")],
    env: {
      ...process.env,
      KANBAN_USER_DATA: userData,
      KANBAN_DISABLE_CLAUDE: "1",
      KANBAN_DISABLE_OPENCODE: "1",
      ...(repoDir ? { KANBAN_TEST_PICK_DIRECTORY: repoDir } : {}),
      ...extraEnv,
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
  // #59 草稿：点 CLI 只开草稿，发出首条消息才创建会话（侧栏行出现）
  await expect(win.getByTestId("draft-hint")).toBeVisible({ timeout: 10_000 });
  await send(win, "首条消息（建立会话）");
  await expect(win.getByText("新会话 · Claude").first()).toBeVisible({ timeout: 10_000 });
}

/** 在 composer 输入并发送 */
async function send(win: Page, text: string): Promise<void> {
  await win.getByPlaceholder("输入消息，/ 开头触发 Skill…").fill(text);
  await win.getByRole("button", { name: "发送 ➤" }).click();
}

test("恢复条成功流转：断开 → 待恢复条 → 点击恢复 → 恢复中（不可中断、无按钮）→ banner 消失 + 空闲 + 可续聊", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    // 第一次运行：注册 + 会话跑一个完整 turn
    const first = await launchApp(userData, repoDir);
    await registerAndCreate(first.win);
    await send(first.win, "拆类型");
    await expect(first.win.getByText("空闲").first()).toBeVisible({ timeout: 30_000 });
    await first.app.close();

    // 重启（同一 userData，注入 1.5s resume 延迟使「恢复中」态可观察）
    const second = await launchApp(userData, undefined, { KANBAN_FAKE_RESUME_DELAY_MS: "1500" });
    await expect(second.win.getByText("新会话 · Claude").first()).toBeVisible({ timeout: 15_000 });
    await expect(second.win.getByText("已断开").first()).toBeVisible();
    await second.win.getByText("新会话 · Claude").first().click();

    // 待恢复态：会话名 + 缓存不替代原生历史说明 + 主按钮（文案保留，F12）
    const banner = second.win.getByTestId("resume-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("新会话 · Claude");
    await expect(banner).toContainText("缓存消息不替代原生历史");

    // 点击恢复 → 恢复中态：进行中说明 + 不可中断（D1：无取消/无任何按钮）
    await second.win.getByRole("button", { name: "读取原生历史并恢复" }).click();
    await expect(banner).toContainText("正在读取原生历史并恢复上下文", { timeout: 10_000 });
    await expect(banner).toContainText("不可中断");
    await expect(banner.getByRole("button")).toHaveCount(0);

    // 成功收敛：banner 消失、状态徽标回空闲；恢复会话可续聊
    await expect(banner).toHaveCount(0, { timeout: 15_000 });
    await expect(second.win.getByText("空闲").first()).toBeVisible({ timeout: 15_000 });
    await send(second.win, "中断后继续");
    await expect(second.win.getByText("基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。")).toBeVisible({ timeout: 30_000 });
    await second.app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("恢复条失败流转：恢复失败（IPC 错误原因/错误码 + 重试 + 复制详情）→ 重试成功收敛", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    // 第一次运行：注册 + 会话跑一个完整 turn
    const first = await launchApp(userData, repoDir);
    await registerAndCreate(first.win);
    await send(first.win, "拆类型");
    await expect(first.win.getByText("空闲").first()).toBeVisible({ timeout: 30_000 });
    await first.app.close();

    // 重启（同一 userData，注入首次 resume 失败）
    const second = await launchApp(userData, undefined, { KANBAN_FAKE_RESUME_FAIL_FIRST: "1" });
    await expect(second.win.getByText("已断开").first()).toBeVisible({ timeout: 15_000 });
    await second.win.getByText("新会话 · Claude").first().click();

    // 待恢复 → 点击 → 失败态：IPC 错误原因 + 错误码 + 「重试」+「复制错误详情」，会话保持断开
    const banner = second.win.getByTestId("resume-banner");
    await expect(banner).toBeVisible();
    await second.win.getByRole("button", { name: "读取原生历史并恢复" }).click();
    await expect(banner).toContainText("恢复失败", { timeout: 10_000 });
    await expect(banner).toContainText("注入的恢复失败");
    await expect(banner).toContainText("E_INTERNAL");
    await expect(banner.getByRole("button", { name: "重试" })).toBeVisible();
    await expect(banner.getByRole("button", { name: "复制错误详情" })).toBeVisible();
    await expect(second.win.getByText("已断开").first()).toBeVisible();

    // 重试（同一恢复动作）→ 成功收敛：banner 消失 + 空闲
    await banner.getByRole("button", { name: "重试" }).click();
    await expect(banner).toHaveCount(0, { timeout: 15_000 });
    await expect(second.win.getByText("空闲").first()).toBeVisible({ timeout: 15_000 });

    // #56（spec #52 验收 2 C 类）：resume 失败在日志留 error 含会话标识（「文件含 error 条目」口径，非末条）——
    // Main 侧 command-failed 白名单摘要（kind=resume + sessionId）；renderer 侧「会话恢复失败（resume）」ctx 带 sessionId/code/message
    const pid = await second.app.evaluate(() => process.pid);
    await second.app.close();
    const entries = readRunEntries(userData, pid);
    const cmdFailed = entries.find((e) => e.level === "error" && e.scope === "cli-host" && e.message.includes("E_INTERNAL") && e.message.includes("kind=resume"));
    expect(cmdFailed).toBeTruthy();
    expect(cmdFailed?.message).toMatch(/sessionId=\S+/);
    const rendererFailed = entries.find((e) => e.source === "renderer" && e.message === "会话恢复失败（resume）");
    expect(rendererFailed).toBeTruthy();
    expect(String(rendererFailed?.ctx?.sessionId ?? "")).not.toBe("");
    expect(rendererFailed?.ctx?.code).toBe("E_INTERNAL");
    expect(String(rendererFailed?.ctx?.message ?? "")).toContain("注入的恢复失败");
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});
