// 用途：阶段 2 验收截图编排（issue #22 / spec #15 H 节验证要求）—— Fake 链路注入目标状态后截图存 docs/acceptance/stage2/screenshots/，逐条覆盖原型 7 条必须一致项 + 无项目空板；断言随截图进行，兼作关键交互实测记录（建卡/关联/修正/确认/删除/卡片建会话/同名提示/视图切换）
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shot } from "./helpers/acceptance-artifacts";

const PROJECT_NAME = "kb-s2-shot-repo";
const SHOT_DIR = resolve(__dirname, "../../../docs/acceptance/stage2/screenshots");

/**
 * 建隔离 fixture：独立 userData + 伪 git 主仓库目录（预置项目级 .claude/skills/design-feature，
 * 与用户级 fixture 同名 → Claude 会话创建时同名 skill 提示条可被真实检测触发，原型一致项 7）
 */
function makeFixture(): { userData: string; repoDir: string; repoRoot: string; claudeCfg: string } {
  const userData = mkdtempSync(join(tmpdir(), "kb-s2-user-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "kb-s2-repo-"));
  const repoDir = join(repoRoot, PROJECT_NAME);
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  mkdirSync(join(repoDir, ".claude", "skills", "design-feature"), { recursive: true });
  // 用户级 Claude 基准目录（经 CLAUDE_CONFIG_DIR 注入，不触碰真实 ~/.claude）：skills/design-feature 同名目录
  const claudeCfg = mkdtempSync(join(tmpdir(), "kb-s2-claude-cfg-"));
  mkdirSync(join(claudeCfg, "skills", "design-feature"), { recursive: true });
  return { userData, repoDir, repoRoot, claudeCfg };
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

/** 启动应用（Fake 演示链路 + CLAUDE_CONFIG_DIR 指向隔离用户级基准 → 同名检测可触发且不污染真实用户目录） */
async function launchApp(userData: string, repoDir: string, claudeCfg: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await _electron.launch({
    args: [resolve(__dirname, "..")],
    env: {
      ...process.env,
      KANBAN_USER_DATA: userData,
      KANBAN_DISABLE_CLAUDE: "1",
      KANBAN_DISABLE_OPENCODE: "1",
      KANBAN_TEST_PICK_DIRECTORY: repoDir,
      CLAUDE_CONFIG_DIR: claudeCfg,
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

test("原型一致项截图集（spec #15 H 节 7 条 + S2-18 空板）：入口/五列/卡片/详情/删除弹层/REQ 徽标/同名提示", async () => {
  const { userData, repoDir, repoRoot, claudeCfg } = makeFixture();
  try {
    const { app, win } = await launchApp(userData, repoDir, claudeCfg);

    // S2-18（补充证据）：未挂项目上下文 → 看板空板 + 引导文案（视图切换交互：入口在聊天/看板间切换）
    await expect(win.getByTestId("kanban-entry")).toBeVisible({ timeout: 15_000 });
    await win.getByTestId("kanban-entry").click();
    await expect(win.getByTestId("kanban-board")).toBeVisible();
    await expect(win.getByTestId("kanban-empty-guide")).toHaveText("选择或注册项目后查看其需求");
    await shot(win, SHOT_DIR, "11-board-empty-guide.png");
    await win.getByTestId("kanban-entry").click(); // 切回聊天（无项目时入口显示「当前项目」）

    // 注册项目 + 建 Claude 会话（Fake）→ 同名 skill 检测触发提示条（一致项 7）
    await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
    await expect(win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
    await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
    await win.getByRole("button", { name: "＋", exact: true }).click();
    await win.getByRole("button", { name: "Claude", exact: true }).click();
    // #59 草稿：发首条消息才创建会话（行出现；banner 在会话视图）
    await expect(win.getByTestId("draft-hint")).toBeVisible({ timeout: 10_000 });
    await send(win, "看板联动的会话");
    await expect(win.locator("aside").getByText("看板联动的会话")).toBeVisible({ timeout: 10_000 }); // #94：标题=首条派生
    const banner = win.getByTestId("skill-conflict-banner");
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText("design-feature");
    await expect(banner).toContainText("项目级将优先生效");
    await shot(win, SHOT_DIR, "10-skill-conflict-banner.png");
    await banner.getByRole("button", { name: "知道了" }).click(); // 可关闭（非阻塞）
    await expect(banner).toHaveCount(0);

    // 一致项 1：侧栏底部「看板」入口按钮（带当前项目指示）—— 聊天视图整体（含会话行）
    await expect(win.getByTestId("kanban-entry")).toContainText(PROJECT_NAME);
    await shot(win, SHOT_DIR, "01-kanban-entry-sidebar.png");

    // 一致项 2：看板五列（未开始列头「＋」手动建卡）/ Design / Implement / PR / Retro
    await win.getByTestId("kanban-entry").click();
    await expect(win.getByTestId("kanban-board")).toBeVisible();
    for (const key of ["none", "Design", "Implement", "PR", "Retro"]) {
      await expect(win.getByTestId(`kanban-col-${key}`)).toBeVisible();
    }
    await expect(win.getByTestId("kanban-col-none").getByTitle("手动新建需求（归属当前项目）")).toBeVisible();
    await shot(win, SHOT_DIR, "02-board-five-columns.png");

    // 一致项 3a：verified design-feature 自动建卡 —— 标题/会话数/阶段依据行/verified 绿徽标（Design 列）
    await win.getByTestId("kanban-entry").click();
    await send(win, "/design-feature verified 阶段2验收截图");
    await win.getByTestId("kanban-entry").click();
    const designCol = win.getByTestId("kanban-col-Design");
    await expect(designCol.getByText("待命名需求")).toBeVisible({ timeout: 10_000 });
    await expect(designCol.getByText("◍ 1 会话")).toBeVisible();
    await expect(designCol.getByTestId("verified-badge").first()).toBeVisible();
    await expect(designCol.getByText(/design-feature/).first()).toBeVisible(); // 卡片阶段依据行
    await shot(win, SHOT_DIR, "03-card-verified-design.png");

    // 一致项 3b：self_reported implement-spec → Implement 列 + uncertain「待确认」黄徽标
    await win.getByTestId("kanban-entry").click();
    await send(win, "/implement-spec");
    await win.getByTestId("kanban-entry").click();
    const implCol = win.getByTestId("kanban-col-Implement");
    await expect(implCol.getByText("待命名需求")).toBeVisible({ timeout: 15_000 });
    await expect(implCol.getByTestId("uncertain-badge").first()).toBeVisible();
    await shot(win, SHOT_DIR, "04-card-uncertain-implement.png");

    // 一致项 4c：详情面板 uncertain 提示条 +「确认当前阶段」（暂不点确认，先截图）
    await implCol.getByText("待命名需求").click();
    await expect(win.getByTestId("detail-panel")).toBeVisible();
    await expect(win.getByTestId("uncertain-note")).toContainText("implement-spec");
    await expect(win.getByTestId("confirm-stage-button")).toBeVisible();
    await shot(win, SHOT_DIR, "07-detail-uncertain-confirm.png");

    // 一致项 4b：「＋新建会话」四 CLI 菜单（PTY 项标注「无 skill 信号」）→ 选 OpenCode 创建即自动关联
    await win.getByTestId("new-session-menu").click();
    for (const cli of ["codex", "claude", "opencode", "pty"]) {
      await expect(win.getByTestId(`new-session-item-${cli}`)).toBeVisible();
    }
    await expect(win.getByTestId("new-session-item-pty")).toContainText("无 skill 信号");
    await shot(win, SHOT_DIR, "06-detail-new-session-menu.png");
    await win.getByTestId("new-session-item-opencode").click();
    // #59 草稿：卡片入口只开草稿（切到聊天视图）——发首条消息才创建（requirementId 随之落自动关联），再回看板
    await expect(win.getByTestId("draft-hint")).toBeVisible({ timeout: 10_000 });
    await send(win, "首条消息（建立会话）");
    await expect(win.locator("aside").getByText("首条消息（建立会话）").first()).toBeVisible({ timeout: 10_000 });
    await win.getByTestId("kanban-entry").click(); // 回看板（详情面板保持）
    const openRow = win.getByTestId("detail-panel").locator('[data-testid="related-session"]', { hasText: "首条消息（建立会话）" });
    await expect(openRow).toBeVisible({ timeout: 15_000 });
    await expect(implCol.getByText("◍ 2 会话")).toBeVisible({ timeout: 10_000 });

    // 一致项 4a：详情面板全套 —— 标题行内编辑/五段修正条+当前依据/关联列表（状态徽标+跳转+解除）/关联已有选择器/删除
    await expect(win.getByTestId("detail-title-input")).toHaveValue("待命名需求");
    for (const key of ["none", "Design", "Implement", "PR", "Retro"]) {
      await expect(win.getByTestId(`stage-seg-${key}`)).toBeVisible();
    }
    await expect(win.getByText(/当前依据：/)).toBeVisible();
    await expect(openRow.getByText("空闲", { exact: true })).toBeVisible(); // 会话行活动状态徽标
    await expect(openRow.getByTestId("related-jump")).toBeVisible();
    await expect(openRow.getByTestId("related-unlink")).toBeVisible();
    await expect(win.getByTestId("link-existing-select")).toBeVisible();
    await expect(win.getByTestId("delete-requirement-button")).toBeVisible();
    await shot(win, SHOT_DIR, "05-detail-panel.png");

    // uncertain 手动确认交互：徽标清除、阶段保持
    await win.getByTestId("confirm-stage-button").click();
    await expect(implCol.getByTestId("uncertain-badge")).toHaveCount(0, { timeout: 10_000 });
    await expect(implCol.getByText("待命名需求")).toBeVisible();

    // 一致项 6：侧栏会话行需求徽标（REQ-id）—— 两会话（Claude/OpenCode）均挂 REQ-001
    await win.getByTestId("kanban-entry").click();
    const claudeRow = win.locator("aside").locator('[data-testid="session-row"]', { hasText: "看板联动的会话" });
    const openSideRow = win.locator("aside").locator('[data-testid="session-row"]', { hasText: "首条消息（建立会话）" });
    await expect(claudeRow.getByTestId("req-badge")).toHaveText("REQ-001");
    await expect(openSideRow.getByTestId("req-badge")).toHaveText("REQ-001");
    await shot(win, SHOT_DIR, "09-sidebar-req-badge.png");

    // 一致项 5：删除二次确认弹层（三要素文案）→ 确认后卡片实时消失（面板仍开着：activeRequirementId 未清）
    await win.getByTestId("kanban-entry").click();
    await expect(win.getByTestId("detail-panel")).toBeVisible();
    await win.getByTestId("delete-requirement-button").click();
    const dialog = win.getByTestId("delete-confirm-dialog");
    await expect(dialog).toContainText("仅删除需求卡片与全部会话关联");
    await expect(dialog).toContainText("会话本身、聊天历史与事件日志保留");
    await expect(dialog).toContainText("不可撤销");
    await shot(win, SHOT_DIR, "08-delete-confirm-dialog.png");
    await win.getByTestId("confirm-delete-button").click();
    await expect(win.getByTestId("requirement-card")).toHaveCount(0, { timeout: 10_000 });

    await app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
    await rmBestEffort(claudeCfg);
  }
});
