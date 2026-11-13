// 用途：会话标题状态机整机 E2E（#94/#95 / ADR 0003）—— 首条消息派生标题即时更新（含截断）→ 侧栏铅笔行内重命名（manual 终态）→ 再发消息不覆盖；PTY 行豁免（标题 shell 回写不变、无重命名入口）；T2 首轮摘要：turn 结束 → 固定值摘要经 session:event 推送翻转侧栏、摘要进行中手动重命名不被覆盖
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FAKE_SUMMARY_TITLE } from "./helpers/fake-summary";

const PROJECT_NAME = "title-repo";

/** 建隔离 fixture：独立 userData + 伪 git 主仓库 */
function makeFixture(): { userData: string; repoDir: string } {
  const userData = mkdtempSync(join(tmpdir(), "kb-title-user-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "kb-title-repo-"));
  const repoDir = join(repoRoot, PROJECT_NAME);
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  return { userData, repoDir };
}

/** 启动应用（Fake 演示模式；extraEnv 供 #95 摘要延迟注入）并注册项目 */
async function launchApp(extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; win: Page; cleanup(): Promise<void> }> {
  const { userData, repoDir } = makeFixture();
  const app = await _electron.launch({
    args: [resolve(__dirname, "..")],
    env: {
      ...process.env,
      KANBAN_USER_DATA: userData,
      KANBAN_TEST_PICK_DIRECTORY: repoDir,
      KANBAN_DISABLE_CLAUDE: "1",
      KANBAN_DISABLE_OPENCODE: "1",
      ...extraEnv,
    },
  });
  const win = await app.firstWindow();
  await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
  await expect(win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
  return {
    app,
    win,
    cleanup: async () => {
      for (let i = 0; i < 20; i += 1) {
        try {
          rmSync(userData, { recursive: true, force: true });
          rmSync(join(repoDir, ".."), { recursive: true, force: true });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      console.warn(`[e2e] 临时目录仍被占用，跳过清理：${userData}`);
    },
  };
}

/** 在 composer 输入并发送 */
async function send(win: Page, text: string): Promise<void> {
  await win.getByPlaceholder("输入消息，/ 开头触发 Skill…").fill(text);
  await win.getByRole("button", { name: "发送 ➤" }).click();
}

/** 经项目行「＋」建 Claude 草稿并发首条消息（行标题=首条派生，#94） */
async function createSession(win: Page, firstText: string): Promise<void> {
  await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
  await win.getByRole("button", { name: "＋", exact: true }).click();
  await win.getByRole("button", { name: "Claude", exact: true }).click();
  await expect(win.getByTestId("draft-hint")).toBeVisible({ timeout: 10_000 });
  await send(win, firstText);
}

test("首条消息派生标题即时更新 → 铅笔行内重命名 → 再发消息不覆盖（manual 终态）", async () => {
  const t = await launchApp();
  const { app, win } = t;

  // ① 首条消息（超 24 码点）→ 侧栏行标题即时变为派生截断（发送即建会话，无需事件推送）
  await createSession(win, "这条首条消息超过二十四个Unicode码点会被按码点截断");
  await expect(win.locator("aside").getByText("这条首条消息超过二十四个Unicode码点会被按…")).toBeVisible({ timeout: 10_000 });

  // ② hover 会话行 → 铅笔 → 行内编辑（初值=当前标题）→ Enter 提交
  const row = win.locator("aside").locator("div.group").filter({ hasText: "这条首条消息超过二十四个Unicode码点会被按…" });
  await row.hover();
  await row.getByTitle("重命名会话").click();
  const input = win.getByTestId("session-rename-input");
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("这条首条消息超过二十四个Unicode码点会被按…");
  await input.fill("我手动起的名字");
  await input.press("Enter");
  await expect(win.locator("aside").getByText("我手动起的名字")).toBeVisible({ timeout: 10_000 });

  // ③ manual 终态：再发消息，自动派生不覆盖手动标题
  await send(win, "第二条消息不该覆盖手动标题");
  await expect(win.getByText("空闲").first()).toBeVisible({ timeout: 20_000 });
  await expect(win.locator("aside").getByText("我手动起的名字")).toHaveCount(1);
  await expect(win.locator("aside").getByText("第二条消息不该覆盖手动标题")).toHaveCount(0); // 侧栏无派生标题行（消息只在气泡）

  await app.close();
  await t.cleanup();
});

test("PTY 豁免：终端标题保持 shell 回写（终端 · pwsh），PTY 行无重命名铅笔", async () => {
  const t = await launchApp();
  const { app, win } = t;

  // 先建结构化会话（对照组：有铅笔）+ PTY 终端（首输入触发创建）
  await createSession(win, "对照用的结构化会话首条");
  await expect(win.locator("aside").getByText("对照用的结构化会话首条")).toBeVisible({ timeout: 10_000 });
  await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
  await win.getByRole("button", { name: "＋", exact: true }).click();
  await win.getByRole("button", { name: "PTY 终端", exact: true }).click();
  await expect(win.locator(".xterm").first()).toBeVisible({ timeout: 15_000 });
  await win.locator(".xterm").first().click();
  await win.keyboard.type("x");
  // PTY 标题 = spawn 成功后 shell 回写「终端 · pwsh」（无条件写、不进状态机——行为零变化）
  const ptyRow = win.locator("aside").locator("div.group").filter({ hasText: /^终端 · / });
  await expect(ptyRow).toBeVisible({ timeout: 15_000 });

  // 结构化行有铅笔；PTY 行 hover 后无铅笔（豁免：无派生、无重命名入口）
  const structuredRow = win.locator("aside").locator("div.group").filter({ hasText: "对照用的结构化会话首条" });
  await structuredRow.hover();
  await expect(structuredRow.getByTitle("重命名会话")).toBeVisible();
  await ptyRow.hover();
  await expect(ptyRow.getByTitle("重命名会话")).toHaveCount(0);

  await app.close();
  await t.cleanup();
});

test("T2 摘要翻转（#95）：turn 结束 → 摘要固定值 → 侧栏经 session:event 推送刷新", async () => {
  const t = await launchApp();
  const { app, win } = t;

  // 首条消息 → 派生标题（derived）；turn 结束 idle → main 触发一次性摘要（Fake 固定值）→ session:event → 侧栏翻转
  await createSession(win, "等待摘要升级的会话首条消息");
  await expect(win.locator("aside").getByText("等待摘要升级的会话首条消息")).toBeVisible({ timeout: 10_000 });
  await expect(win.locator("aside").getByText(FAKE_SUMMARY_TITLE)).toBeVisible({ timeout: 20_000 });
  // 派生标题已被摘要取代（同一行标题翻转，不并存）
  await expect(win.locator("aside").getByText("等待摘要升级的会话首条消息")).toHaveCount(0);

  await app.close();
  await t.cleanup();
});

test("T2 摘要竞态（#95）：摘要进行中手动重命名不被覆盖（manual 终态权威）", async () => {
  // Fake 摘要延迟 4s：turn 结束触发摘要后留出重命名窗口
  const t = await launchApp({ KANBAN_FAKE_SUMMARIZE_DELAY_MS: "4000" });
  const { app, win } = t;

  await createSession(win, "摘要竞态用的会话首条消息");
  await expect(win.locator("aside").getByText("摘要竞态用的会话首条消息")).toBeVisible({ timeout: 10_000 });
  // turn 结束（空闲徽标）= 摘要已触发且 pending（4s 延迟窗口内）
  await expect(win.getByText("空闲").first()).toBeVisible({ timeout: 20_000 });

  // 摘要进行中手动重命名 → manual；随后摘要迟到，门控拒绝写入且无推送
  const row = win.locator("aside").locator("div.group").filter({ hasText: "摘要竞态用的会话首条消息" });
  await row.hover();
  await row.getByTitle("重命名会话").click();
  const input = win.getByTestId("session-rename-input");
  await expect(input).toBeVisible();
  await input.fill("竞态手动命名");
  await input.press("Enter");
  await expect(win.locator("aside").getByText("竞态手动命名")).toBeVisible({ timeout: 10_000 });

  // 等过摘要延迟窗口（4s 延迟 + 裕量）：手动标题保持，摘要固定值从未出现
  await win.waitForTimeout(6_000);
  await expect(win.locator("aside").getByText("竞态手动命名")).toHaveCount(1);
  await expect(win.locator("aside").getByText(FAKE_SUMMARY_TITLE)).toHaveCount(0);

  await app.close();
  await t.cleanup();
});
