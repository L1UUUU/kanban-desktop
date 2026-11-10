// 用途：阶段 1 验收截图编排（issue #14 / spec I 验证要求）—— Fake 链路注入目标状态后截图存 docs/acceptance/stage1/screenshots/，断言随截图进行，兼作关键交互实测记录；两测例分别覆盖单窗口状态集与徽标/断开恢复（需重启编排）
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PROJECT_NAME = "kb-shot-repo";
const SHOT_DIR = resolve(__dirname, "../../../docs/acceptance/stage1/screenshots");

/** 建隔离 fixture：独立 userData + 伪 git 主仓库目录（可选附带 worktree 形态目录） */
function makeFixture(): { userData: string; repoDir: string; repoRoot: string; worktreeDir: string } {
  const userData = mkdtempSync(join(tmpdir(), "kb-shot-user-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "kb-shot-repo-"));
  const repoDir = join(repoRoot, PROJECT_NAME);
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  // worktree 形态：.git 为文件，gitdir 指回主仓库（detectDirIdentity 按 cwd/.git 形态判定）
  const worktreeDir = join(repoRoot, "kb-shot-wt");
  mkdirSync(worktreeDir, { recursive: true });
  writeFileSync(join(worktreeDir, ".git"), `gitdir: ${join(repoDir, ".git", "worktrees", "kb-shot-wt")}\n`, "utf8");
  return { userData, repoDir, repoRoot, worktreeDir };
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

/** 启动应用（Fake 演示链路：真实 CLI 回落 Fake；userData 隔离；pickDirectory 可指定） */
async function launchApp(userData: string, pickDir?: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await _electron.launch({
    args: [join(__dirname, "..")],
    env: {
      ...process.env,
      KANBAN_USER_DATA: userData,
      KANBAN_DISABLE_CLAUDE: "1",
      KANBAN_DISABLE_OPENCODE: "1",
      ...(pickDir ? { KANBAN_TEST_PICK_DIRECTORY: pickDir } : {}),
    },
  });
  const win = await app.firstWindow();
  return { app, win };
}

/** 截图到验收目录并断言可见性（截图本身即证据；断言兼作交互记录） */
async function shot(win: Page, name: string): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  await win.screenshot({ path: join(SHOT_DIR, name) });
  console.log(`[shot] ${name}`);
}

/** 在 composer 输入并发送 */
async function send(win: Page, text: string): Promise<void> {
  await win.getByPlaceholder("输入消息，/ 开头触发 Skill…").fill(text);
  await win.getByRole("button", { name: "发送 ➤" }).click();
}

/** 经项目行「＋」新建指定 CLI 会话并等待会话行出现（nth 用于多会话场景）；exact 避免与会话行按钮名（含 Claude 子串）冲突 */
async function createSession(win: Page, cli: string, nth = 0): Promise<void> {
  await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
  await win.getByRole("button", { name: "＋", exact: true }).click();
  await win.getByRole("button", { name: cli, exact: true }).click();
  await expect(win.getByText("新会话 · Claude").nth(nth)).toBeVisible({ timeout: 10_000 });
}

test("原型一致项截图集：布局/新建菜单/聊天区三卡/composer/冲突条/取消/PTY", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    const { app, win } = await launchApp(userData, repoDir);

    // 一致项 1（三区布局）：空态引导 —— 顶栏（应用名+未注册徽标+设置）+ 左侧空列表 + 中央空态
    await expect(win.getByRole("button", { name: "＋ 注册", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(win.getByText("设置")).toBeVisible();
    await shot(win, "01-empty-state.png");

    // 注册项目后的默认三区布局：顶栏项目名徽标 + 左侧项目/会话分组 + 中央聊天区
    await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
    await expect(win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });

    // 一致项 2（项目行「＋」→ CLI 菜单）：悬浮出「＋」，点击弹菜单（Codex/Claude/OpenCode/PTY 终端）
    await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
    await win.getByRole("button", { name: "＋", exact: true }).click();
    for (const item of ["Codex", "Claude", "OpenCode", /PTY 终端/]) {
      await expect(win.getByRole("button", { name: item, exact: false }).first()).toBeVisible();
    }
    await shot(win, "02-new-session-menu.png");
    await win.getByRole("button", { name: "Claude", exact: true }).click();
    await expect(win.getByText("新会话 · Claude").first()).toBeVisible({ timeout: 10_000 });

    // 一致项 1 完整形态截图（已注册+会话行+空聊天区）
    await shot(win, "03-layout-three-panes.png");

    // 一致项 6（composer Running 态）：流式中发送键替换为「⏹ 停止输出」
    await send(win, "拆类型");
    await expect(win.getByRole("button", { name: "⏹ 停止输出" })).toBeVisible({ timeout: 10_000 });
    await shot(win, "09-composer-running-stop.png");

    // 一致项 5（聊天区消息流+工具卡）：多轮流式 + 工具卡终态（状态流转/输出/时长）
    await expect(win.getByText("好的，我先跑一遍现有测试确认基线，然后开始拆分。")).toBeVisible({ timeout: 30_000 });
    await expect(win.getByText("完成 · 3.6s")).toBeVisible({ timeout: 30_000 });
    await expect(win.getByText(/Tests\s+13 passed/)).toBeVisible();
    await expect(win.getByText("空闲").first()).toBeVisible({ timeout: 20_000 });

    // 一致项 6（权限 chip 三档）：菜单展开含档位与说明（截图），并实测切换（🔒 请求 → 恢复默认）
    await win.getByText("⚡ 权限：自动 ▾").click();
    await expect(win.getByText("所有工具调用前弹出审批卡片")).toBeVisible();
    await shot(win, "10-composer-permission-menu.png");
    await win.getByText("🔒 请求").click();
    await expect(win.getByText("🔒 权限：请求 ▾")).toBeVisible();
    await win.getByText("🔒 权限：请求 ▾").click();
    await win.getByText("⚡ 自动（推荐）").click();
    await expect(win.getByText("⚡ 权限：自动 ▾")).toBeVisible();

    // 一致项 5（审批卡）：等待审批态（请求命令+suggestions+三键）；上一轮工具卡同屏
    await send(win, "审批演示");
    await expect(win.getByText(/⚙ 需要审批：Edit packages\/ipc-schema\/src\/index\.ts/)).toBeVisible({ timeout: 20_000 });
    await expect(win.getByRole("button", { name: "允许一次" })).toBeVisible();
    await expect(win.getByRole("button", { name: "总是允许" })).toBeVisible();
    await expect(win.getByRole("button", { name: "拒绝" })).toBeVisible();
    await expect(win.getByText("等待审批").first()).toBeVisible();
    await shot(win, "05-chat-approval-card.png");
    // 审批交互实测：拒绝 → 工具被拒 + 回空闲
    await win.getByRole("button", { name: "拒绝" }).click();
    await expect(win.getByText("已拒绝")).toBeVisible({ timeout: 20_000 });
    await expect(win.getByText("空闲").first()).toBeVisible({ timeout: 20_000 });

    // 一致项 4（冲突提示条）：主仓库两会话并行 → 顶部提示条列出会话名
    await createSession(win, "Claude", 1);
    await send(win, "拆类型");
    await expect(win.getByRole("button", { name: "⏹ 停止输出" })).toBeVisible({ timeout: 10_000 });
    await win.getByText("新会话 · Claude").nth(0).click();
    await send(win, "拆类型");
    const banner = win.getByTestId("conflict-banner");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText("主仓库并行会话（2 个）");
    await shot(win, "04-conflict-banner.png");

    // 一致项 7（取消）：停止输出 → 「本轮已取消」+ 已中断，会话保留
    await createSession(win, "Claude", 2);
    await send(win, "默认演示");
    await win.getByRole("button", { name: "⏹ 停止输出" }).click({ timeout: 10_000 });
    await expect(win.getByText("— 本轮已取消，会话保留，可继续发消息 —")).toBeVisible({ timeout: 10_000 });
    await expect(win.getByText("已中断").first()).toBeVisible();
    await shot(win, "08-interrupted-cancelled.png");
    // 取消后可继续（实测记录）
    await send(win, "中断后继续");
    await expect(win.getByText("基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。")).toBeVisible({ timeout: 30_000 });

    // PTY 终端面板（可调整范围项，留档）：真实 ConPTY 回显
    await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
    await win.getByRole("button", { name: "＋", exact: true }).click();
    await win.getByRole("button", { name: /PTY 终端/ }).click();
    await expect(win.locator(".xterm").first()).toBeVisible({ timeout: 15_000 });
    await win.locator(".xterm").first().click();
    await win.keyboard.type("echo kb-shot-pty");
    await win.keyboard.press("Enter");
    await expect(win.getByText(/kb-shot-pty/).first()).toBeVisible({ timeout: 20_000 });
    await shot(win, "11-pty-terminal.png");

    await app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("徽标与断开恢复截图：主仓库绿/worktree 蓝 + 重开断开会话恢复", async () => {
  const { userData, repoDir, repoRoot, worktreeDir } = makeFixture();
  try {
    // 第一段：注册主仓库项目 + 一个会话跑完整 turn（供重启后断开恢复）
    const first = await launchApp(userData, repoDir);
    await first.win.getByRole("button", { name: "＋ 注册", exact: true }).click();
    await expect(first.win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
    await createSession(first.win, "Claude");
    await send(first.win, "拆类型");
    await expect(first.win.getByText("空闲").first()).toBeVisible({ timeout: 30_000 });
    await first.app.close();

    // 第二段：同 userData 换 pick 注册 worktree 项目 + 会话（会话行目录身份徽标：worktree 蓝）
    const second = await launchApp(userData, worktreeDir);
    await second.win.getByRole("button", { name: "＋ 注册", exact: true }).click();
    await expect(second.win.locator("aside").getByText("kb-shot-wt", { exact: true })).toBeVisible({ timeout: 15_000 });
    // 双项目并存：每项目行一个悬浮「＋」，须限定 kb-shot-wt 行内点击（strict mode；6ab2a88 悬浮按钮后引入）
    const wtRow = second.win.locator("aside").locator("div.group").filter({ hasText: "kb-shot-wt" });
    await wtRow.getByText("kb-shot-wt", { exact: true }).hover();
    await wtRow.getByRole("button", { name: "＋", exact: true }).click();
    await second.win.getByRole("button", { name: "Claude", exact: true }).click();
    await expect(second.win.getByText("新会话 · Claude").first()).toBeVisible({ timeout: 10_000 });
    // 一致项 3（会话行徽标）：CLI 色点+标题+目录身份徽标+状态徽标；侧栏按当前项目过滤，两形态各截一张
    await expect(second.win.getByText(/worktree: kb-shot-wt/).first()).toBeVisible({ timeout: 10_000 });
    await shot(second.win, "06-session-badges-worktree.png");
    await second.win.locator("aside").getByText(PROJECT_NAME, { exact: true }).click();
    await expect(second.win.getByText("主仓库", { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await shot(second.win, "06-session-badges-main.png");
    await second.app.close();

    // 第三段：重开（同一 userData）→ 断开会话顶部恢复引导条（#42）→ 恢复后可续聊
    const third = await launchApp(userData);
    await expect(third.win.getByText("已断开").first()).toBeVisible({ timeout: 15_000 });
    await third.win.getByText("新会话 · Claude").first().click();
    const resumeBanner = third.win.getByTestId("resume-banner");
    await expect(resumeBanner).toBeVisible();
    await expect(resumeBanner).toContainText("新会话 · Claude");
    await expect(resumeBanner).toContainText("缓存消息不替代原生历史");
    // 一致项 5（断开会话恢复入口，#42 顶部条形态）截图
    await shot(third.win, "07-disconnected-recovery.png");
    await third.win.getByRole("button", { name: "读取原生历史并恢复" }).click();
    await expect(third.win.getByText("空闲").first()).toBeVisible({ timeout: 15_000 });
    await expect(resumeBanner).toHaveCount(0); // 恢复成功 banner 收敛
    await send(third.win, "中断后继续");
    await expect(third.win.getByText("基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。")).toBeVisible({ timeout: 30_000 });
    await third.app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});
