// 用途：错误提示五类卡整机 E2E（#46 验收 5 / spec I 一致项 2）—— Fake 驱动（KANBAN_DISABLE_* 三件套）：
// 四类 + 未知兜底卡呈现与动作流转（重试重发 / 打开 PTY 终端 / 恢复会话 / 知道了）+ spawn 创建失败侧栏卡（KANBAN_FAKE_CREATE_FAIL_FIRST 注入，重试创建成功收敛）
// + #56（spec #52 验收 2 C 类）：spawn 失败日志留痕断言（E_SPAWN_NOT_FOUND + kind/cli 关联标识）
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunEntries } from "./log-run";

const PROJECT_NAME = "kb-errcard";

/** 建隔离 fixture：独立 userData + 伪 git 主仓库目录 */
function makeFixture(): { userData: string; repoDir: string; repoRoot: string } {
  const userData = mkdtempSync(join(tmpdir(), "kb-errcard-user-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "kb-errcard-repo-"));
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

/** 打开项目行的悬浮「＋」新建会话菜单（两处入口同口径）
 *  ＋ 按钮 opacity-0 pointer-events-none，仅 group-hover 时可交互（#51 修布局抖动的一致项，产品 UI 不改）：
 *  hover 项目行使按钮可交互 → 过渡断言消除竞态 → 再对按钮本身 hover 保持 group-hover → click，
 *  避免「hover 行后指针移动离开行一瞬」按钮立即回 pointer-events-none 导致 click 被拦截。 */
async function openCreateMenu(win: Page): Promise<void> {
  await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
  const plus = win.getByRole("button", { name: "＋", exact: true });
  await expect(plus).toBeVisible();
  await expect(plus).toBeEnabled();
  await plus.hover();
  await plus.click();
}

/** 注册项目 + 建首个 Claude（Fake）会话 */
async function registerAndCreate(win: Page): Promise<void> {
  await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
  await expect(win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
  await openCreateMenu(win);
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

test("会话内五类错误卡呈现与动作流转（四类 + 未知兜底，fake 关键词脚本驱动）", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    const { app, win } = await launchApp(userData, repoDir);
    await registerAndCreate(win);
    const card = win.getByTestId("error-card");

    // 卡 1：CLI 进程异常退出（CLI_EXIT）—— 标题 + 不受影响说明 + 恢复动作（D4 同一动作文案）+ 知道了
    await send(win, "错误演示");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("CLI 进程异常退出");
    await expect(card).toContainText("已产生的对话与文件修改不受影响");
    await expect(card.getByRole("button", { name: "读取原生历史并恢复" })).toBeVisible();
    await win.getByRole("button", { name: "知道了", exact: true }).click();
    await expect(card).toHaveCount(0);

    // 卡 2：认证失效（AUTH_EXPIRED）—— 按 CLI（Claude）指引命令块 + 重试 + 打开 PTY 终端
    await send(win, "认证演示");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("登录已失效（Claude）");
    await expect(win.getByTestId("auth-cmd")).toContainText("/login");
    // 「重试」= 重发最近一条用户消息（消息流出现第二条同文回显；fake 脚本确定性复现错误卡）
    await win.getByRole("button", { name: "重试", exact: true }).click();
    await expect(win.getByText("认证演示", { exact: true }).nth(1)).toBeVisible({ timeout: 15_000 });
    await expect(card).toBeVisible({ timeout: 15_000 });
    // 「打开 PTY 终端」= 在会话 cwd 新建终端（登录指引命令在终端内运行）→ 侧栏出现 PTY 终端行并切到终端视图
    await win.getByRole("button", { name: "打开 PTY 终端" }).click();
    await expect(win.getByText(/终端 · /).first()).toBeVisible({ timeout: 15_000 });
    // 切回结构化会话继续驱动后续卡
    await win.getByText("新会话 · Claude").first().click();

    // 卡 3（会话内形态）：找不到 CLI 程序（SPAWN_NOT_FOUND）—— 安装/PATH/配置文件指引 + 复制配置路径
    await send(win, "找不到 CLI");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("找不到 CLI 程序（Claude）");
    await expect(card).toContainText("确认已安装并在 PATH 中");
    // 配置路径来自 AppInfo.configPath（Main 注入 <userData>/config.json）
    await expect(card).toContainText("config.json");
    await expect(card.getByRole("button", { name: "复制配置路径" })).toBeVisible();

    // 卡 4：协议断连（PROTOCOL_DISCONNECT）—— 原因说明 + 「恢复会话」触发与恢复条同一 resume 动作 → 卡消失
    await send(win, "断连演示");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("连接中断（Claude）");
    await expect(card).toContainText("恢复时将按需重新拉起 server");
    await card.getByRole("button", { name: "恢复会话" }).click();
    await expect(card).toHaveCount(0, { timeout: 15_000 });

    // 卡 5：未知错误（UNKNOWN 兜底）—— 原始 code 与 message 原文（不吞错）+ 复制错误详情
    await send(win, "未知错误演示");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("未知错误");
    await expect(card).toContainText("UNKNOWN");
    await expect(card).toContainText("某种未覆盖的错误形态（演示）");
    await expect(card.getByRole("button", { name: "复制错误详情" })).toBeVisible();

    await app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("spawn 创建失败侧栏卡：E_SPAWN_NOT_FOUND → 卡 3 形态呈现 → 重试创建成功收敛", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    // 第一次运行仅注册项目（占住「首个项目」判定，避免第二次运行的 boot 演示会话消耗失败注入）
    const first = await launchApp(userData, repoDir);
    await first.win.getByRole("button", { name: "＋ 注册", exact: true }).click();
    await expect(first.win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
    await first.app.close();

    // 第二次运行注入：Fake 前一次 createSession 抛 E_SPAWN_NOT_FOUND（协议级同码）→ 草稿提交失败卡（#59：草稿面板中央区）
    const second = await launchApp(userData, undefined, { KANBAN_FAKE_CREATE_FAIL_FIRST: "1" });
    const win = second.win;
    await openCreateMenu(win);
    await win.getByRole("button", { name: "Claude", exact: true }).click();
    // 草稿面板出现（不落库、侧栏无新行）；发送首条消息触发创建失败
    await expect(win.getByTestId("draft-hint")).toBeVisible({ timeout: 10_000 });
    await send(win, "要重试的首条");

    // 失败卡在草稿面板中央区呈现，对齐原型 d2 卡 3 信息结构；草稿与输入保留
    const card = win.getByTestId("create-error-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("找不到 CLI 程序（Claude）");
    await expect(card).toContainText("FakeAdapter 注入"); // AdapterError 消息原文保留（不吞错）
    await expect(card).toContainText("config.json"); // 配置路径指引（AppInfo.configPath）
    await expect(card.getByRole("button", { name: "重试发送" })).toBeVisible();
    await expect(card.getByRole("button", { name: "复制配置路径" })).toBeVisible();
    await expect(win.getByTestId("draft-hint")).toBeVisible(); // 草稿与输入保留（可重试）
    await expect(win.getByText("新会话 · Claude").first()).toHaveCount(0); // 不留空会话（无侧栏行）

    // 「重试发送」：重新执行创建+发送首条消息 → 成功后卡消失 + 会话登记 + 草稿丢弃
    await card.getByRole("button", { name: "重试发送" }).click();
    await expect(card).toHaveCount(0, { timeout: 15_000 });
    await expect(win.getByText("新会话 · Claude").first()).toBeVisible({ timeout: 10_000 });

    // #56（spec #52 验收 2 C 类）：spawn 失败在日志留 error 带关联标识（「文件含 error 条目」口径，非末条）——
    // Main 侧 command-failed 白名单摘要（kind=createSession + cli=claude；createSession 失败时尚无 sessionId，属实）；
    // renderer 侧「会话创建失败」条目带 code/cli（经真 log:write 桥，source 由 Main 强制）
    const pid = await second.app.evaluate(() => process.pid);
    await second.app.close();
    const entries = readRunEntries(userData, pid);
    const cmdFailed = entries.find((e) => e.level === "error" && e.scope === "cli-host" && e.message.includes("E_SPAWN_NOT_FOUND"));
    expect(cmdFailed).toBeTruthy();
    expect(cmdFailed?.message).toContain("kind=createSession");
    expect(cmdFailed?.message).toContain("cli=claude");
    const rendererFailed = entries.find((e) => e.source === "renderer" && e.message === "草稿提交失败（创建+发送首条消息）");
    expect(rendererFailed).toBeTruthy();
    expect(rendererFailed?.ctx?.code).toBe("E_SPAWN_NOT_FOUND");
    expect(rendererFailed?.ctx?.cli).toBe("claude");
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});
