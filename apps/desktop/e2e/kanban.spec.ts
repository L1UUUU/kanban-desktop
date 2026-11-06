// 用途：看板视图 E2E（#18/#19/#20 验收）—— 侧栏「看板」入口 → 五列看板（Fake 全链）；verified design-feature 自动建卡实时出现；视图切换回聊天会话仍在；重启后 kanban:list 再水化看板与退出前一致（#18，对照原型一致项 1/2/3）；#19 详情面板全套操作往返（编辑/修正/确认/删除/建卡，对照原型一致项 4/5）；#20 关联管理往返（关联已有/解除/卡片建会话/跳转/会话徽标，对照原型一致项 4 关联区/6）
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

test("关联管理往返（#20）：卡片建会话自动关联 → 解除（会话数/徽标即时更新）→ 关联已有 → 跳转两方向（原型一致项 4 关联区/6）", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    const { app, win } = await launchApp(userData, repoDir);
    await registerAndCreate(win);
    await sendVerifiedDesignFeature(win);

    // 看板 → Design 列卡片（verified 自动建卡，关联触发会话）→ 打开详情面板
    await win.getByTestId("kanban-entry").click();
    const designCol = win.getByTestId("kanban-col-Design");
    await expect(designCol.getByText("待命名需求")).toBeVisible({ timeout: 15_000 });
    await expect(designCol.getByText("◍ 1 会话")).toBeVisible();
    await designCol.getByText("待命名需求").click();
    const panel = win.getByTestId("detail-panel");
    await expect(panel).toBeVisible();

    // 关联列表：CLI 色点行 + 状态徽标 + 跳转/解除（US18：活动状态只在会话行）
    const claudeRow = panel.locator('[data-testid="related-session"]', { hasText: "新会话 · Claude" });
    await expect(claudeRow).toBeVisible();
    await expect(claudeRow.getByText("空闲", { exact: true })).toBeVisible();
    await expect(claudeRow.getByTestId("related-jump")).toBeVisible();

    // ＋新建会话：四 CLI 菜单 + PTY 项标注「无 skill 信号」；OpenCode 创建即自动关联（session:create+requirementId）
    await panel.getByTestId("new-session-menu").click();
    for (const cli of ["codex", "claude", "opencode", "pty"]) {
      await expect(panel.getByTestId(`new-session-item-${cli}`)).toBeVisible();
    }
    await expect(panel.getByTestId("new-session-item-pty")).toContainText("无 skill 信号");
    await panel.getByTestId("new-session-item-opencode").click();
    const openRow = panel.locator('[data-testid="related-session"]', { hasText: "新会话 · OpenCode" });
    await expect(openRow).toBeVisible({ timeout: 15_000 });
    await expect(designCol.getByText("◍ 2 会话")).toBeVisible({ timeout: 10_000 });
    // 侧栏：新会话行出现 + 需求徽标（自动关联直达）
    const sidebarOpen = win.locator("aside").locator('[data-testid="session-row"]', { hasText: "新会话 · OpenCode" });
    await expect(sidebarOpen.getByTestId("req-badge")).toHaveText("REQ-001", { timeout: 10_000 });

    // 解除 OpenCode：会话数 2→1、侧栏徽标消失；阶段保持 Design（不回退）
    await openRow.getByTestId("related-unlink").click();
    await expect(designCol.getByText("◍ 1 会话")).toBeVisible({ timeout: 10_000 });
    await expect(sidebarOpen.getByTestId("req-badge")).toHaveCount(0, { timeout: 10_000 });
    await expect(designCol.getByText("待命名需求")).toBeVisible(); // 阶段保持

    // 关联已有：选择器仅列当前项目未关联会话（Claude 已关联不出列；OpenCode 可选）→ 选择即关联往返
    const linkSel = panel.getByTestId("link-existing-select");
    const optionTexts = await linkSel.locator("option").allTextContents();
    expect(optionTexts.some((t) => t.includes("新会话 · Claude"))).toBe(false); // 已关联排除
    expect(optionTexts.some((t) => t.includes("新会话 · OpenCode"))).toBe(true);
    await linkSel.selectOption({ label: "新会话 · OpenCode" });
    await expect(designCol.getByText("◍ 2 会话")).toBeVisible({ timeout: 10_000 });
    await expect(sidebarOpen.getByTestId("req-badge")).toHaveText("REQ-001", { timeout: 10_000 });

    // 跳转方向 A：面板会话「跳转」→ 切回聊天视图并选中该会话
    await claudeRow.getByTestId("related-jump").click();
    await expect(win.getByTestId("kanban-board")).toBeHidden();
    await expect(win.getByPlaceholder("输入消息，/ 开头触发 Skill…")).toBeVisible();
    const sidebarClaude = win.locator("aside").locator('[data-testid="session-row"]', { hasText: "新会话 · Claude" });
    await expect(sidebarClaude).toHaveAttribute("data-active", "true");

    // 跳转方向 B：侧栏 REQ 徽标点击 → 进入看板并选中该需求（详情面板打开）
    await sidebarClaude.getByTestId("req-badge").click();
    await expect(win.getByTestId("kanban-board")).toBeVisible();
    await expect(win.getByTestId("detail-panel")).toBeVisible();
    await expect(win.getByTestId("detail-title-input")).toHaveValue("待命名需求");

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

test("详情面板全套操作往返：建卡 → 编辑 → 修正移列 → uncertain 确认 → 删除；手动卡重启保留（#19，原型一致项 4/5）", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    const { app, win } = await launchApp(userData, repoDir);
    await registerAndCreate(win);

    // 「未开始」列头「＋」手动建卡（S2-09：归属当前项目、初始标题「待命名需求」）
    await win.getByTestId("kanban-entry").click();
    await win.getByTestId("kanban-col-none").getByTitle("手动新建需求（归属当前项目）").click();
    const noneCol = win.getByTestId("kanban-col-none");
    await expect(noneCol.getByText("待命名需求")).toBeVisible({ timeout: 10_000 });

    // 点卡片 → 详情滑出面板：标题行内编辑（rename 事件流，重启不回退）
    await noneCol.getByText("待命名需求").click();
    await expect(win.getByTestId("detail-panel")).toBeVisible();
    const titleInput = win.getByTestId("detail-title-input");
    await titleInput.fill("调研桌面端打包方案");
    await titleInput.press("Enter");
    await expect(noneCol.getByText("调研桌面端打包方案")).toBeVisible({ timeout: 10_000 });

    // 五段阶段修正条：Design 即时移列 + 当前依据（手动修正）；再回「未开始」
    await win.getByTestId("stage-seg-Design").click();
    const designCol = win.getByTestId("kanban-col-Design");
    await expect(designCol.getByText("调研桌面端打包方案")).toBeVisible({ timeout: 10_000 });
    await expect(win.getByText(/当前依据：手动修正/)).toBeVisible();
    await win.getByTestId("stage-seg-none").click();
    await expect(noneCol.getByText("调研桌面端打包方案")).toBeVisible({ timeout: 10_000 });
    await win.getByTestId("detail-close").click();
    await expect(win.getByTestId("detail-panel")).toBeHidden();

    // 自动建卡 → self_reported 驱动 uncertain → 面板「确认当前阶段」清徽标（S2-04）
    await win.getByTestId("kanban-entry").click(); // 切回聊天
    await sendVerifiedDesignFeature(win);
    await expect(win.getByText("已收到 /design-feature", { exact: false }).first()).toBeVisible({ timeout: 15_000 }); // 等上一轮结束再发
    await win.getByPlaceholder("输入消息，/ 开头触发 Skill…").fill("/implement-spec");
    await win.getByRole("button", { name: "发送 ➤" }).click();
    await win.getByTestId("kanban-entry").click();
    const implCol = win.getByTestId("kanban-col-Implement");
    await expect(implCol.getByTestId("uncertain-badge").first()).toBeVisible({ timeout: 15_000 });
    await implCol.getByText("待命名需求").click();
    await expect(win.getByTestId("uncertain-note")).toContainText("implement-spec");
    await win.getByTestId("confirm-stage-button").click();
    await expect(implCol.getByTestId("uncertain-badge")).toHaveCount(0, { timeout: 10_000 });
    await expect(win.getByTestId("uncertain-note")).toBeHidden();
    await expect(implCol.getByText("待命名需求")).toBeVisible(); // 阶段保持 Implement

    // 删除需求：二次确认弹层（原型文案）→ 确认后卡片实时消失
    await win.getByTestId("delete-requirement-button").click();
    const dialog = win.getByTestId("delete-confirm-dialog");
    await expect(dialog).toContainText("仅删除需求卡片与全部会话关联");
    await expect(dialog).toContainText("会话本身、聊天历史与事件日志保留");
    await expect(dialog).toContainText("不可撤销");
    await win.getByTestId("cancel-delete-button").click(); // 取消保留
    await expect(implCol.getByText("待命名需求")).toBeVisible();
    await win.getByTestId("delete-requirement-button").click();
    await win.getByTestId("confirm-delete-button").click();
    await expect(implCol.getByTestId("requirement-card")).toHaveCount(0, { timeout: 10_000 });

    // 重启：手动卡（人工标题）保留、被删卡不复活（墓碑 + kanban:list 再水化）
    await app.close();
    const second = await launchApp(userData);
    await second.win.getByTestId("kanban-entry").click();
    await expect(second.win.getByTestId("kanban-col-none").getByText("调研桌面端打包方案")).toBeVisible({ timeout: 15_000 });
    await expect(second.win.getByTestId("kanban-col-Implement").getByTestId("requirement-card")).toHaveCount(0);
    await second.app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});
