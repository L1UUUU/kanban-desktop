// 用途：阶段 5 验收截图编排（issue #65 / spec #57）—— 对照 docs/prototypes/stage5-session-lifecycle.prototype.html 必须一致项，
// 截图存 docs/acceptance/stage5/screenshots/：草稿态/草稿提交失败卡/行 hover 归档删除/删除二次确认/断开恢复引导条/设置面板三区
// （日志两项 + 自动归档开关天数与扫描反馈 + 已归档按项目分组）/顶栏与侧栏三分组基线；断言随截图进行。
// 自动归档「归档 1 条」证据经直接写库造超期数据（last_active_at 改旧，#64 惯例）：重启后启动扫描归档，反馈行如实呈现。
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shot } from "./helpers/acceptance-artifacts";

const PROJECT_NAME = "kb-s5-repo";
const SHOT_DIR = resolve(__dirname, "../../../docs/acceptance/stage5/screenshots");

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
function makeFixture(): { userData: string; repoDir: string; repoRoot: string } {
  const userData = mkdtempSync(join(tmpdir(), "kb-s5-user-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "kb-s5-repo-"));
  const repoDir = join(repoRoot, PROJECT_NAME);
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  return { userData, repoDir, repoRoot };
}

/** 启动应用（三 CLI 全回落 Fake 演示模式；userData 隔离；pickDir 固定目录选择；extraEnv 透传注入钩子） */
async function launchApp(userData: string, pickDir?: string, extraEnv?: Record<string, string>): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await _electron.launch({
    args: [join(__dirname, "..")],
    env: {
      ...process.env,
      KANBAN_USER_DATA: userData,
      KANBAN_DISABLE_CODEX: "1",
      KANBAN_DISABLE_CLAUDE: "1",
      KANBAN_DISABLE_OPENCODE: "1",
      ...(pickDir ? { KANBAN_TEST_PICK_DIRECTORY: pickDir } : {}),
      ...extraEnv,
    },
  });
  const win = await app.firstWindow();
  return { app, win };
}

/** 在 composer/草稿输入框输入并发送 */
async function send(win: Page, text: string): Promise<void> {
  await win.getByPlaceholder("输入消息，/ 开头触发 Skill…").fill(text);
  await win.getByRole("button", { name: "发送 ➤" }).click();
}

/** 经项目行「＋」→ 菜单选 CLI：草稿语义——发出首条消息才创建会话（行出现） */
async function createSession(win: Page, cliLabel: string): Promise<void> {
  await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
  await win.getByRole("button", { name: "＋", exact: true }).click();
  await win.getByRole("button", { name: cliLabel, exact: true }).click();
  await expect(win.getByTestId("draft-hint")).toBeVisible({ timeout: 10_000 });
  await send(win, "首条消息（建立会话）");
  await expect(win.getByText(`新会话 · ${cliLabel}`).first()).toBeVisible({ timeout: 10_000 });
}

/** 定位侧栏某标题的会话行容器（含 hover 操作区；div.group 同时匹配项目行，靠标题区分） */
function sessionRow(win: Page, title: string) {
  return win.locator("aside").locator("div.group").filter({ hasText: title });
}

/** 直接写库把指定标题会话改为超期（应用须已关闭；#64 造数惯例：基准 COALESCE(last_active_at, created_at)） */
function seedExpired(userData: string, title: string, iso: string): void {
  const db = new DatabaseSync(join(userData, "kanban.db"));
  try {
    db.prepare("UPDATE sessions SET last_active_at = ? WHERE title = ?").run(iso, title);
  } finally {
    db.close();
  }
}

test("原型对照①②：草稿态 + 提交失败卡 + 行 hover 归档/删除 + 删除二次确认", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    // 第一次运行仅注册项目（占住「首个项目」判定，避免 boot 演示草稿消耗失败注入）
    const first = await launchApp(userData, repoDir);
    await first.win.getByRole("button", { name: "＋ 注册", exact: true }).click();
    await expect(first.win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
    await first.app.close();

    // 第二次运行注入创建失败：草稿提交失败卡（输入保留、重试发送）
    const second = await launchApp(userData, undefined, { KANBAN_FAKE_CREATE_FAIL_FIRST: "1" });
    const win = second.win;
    await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
    await win.getByRole("button", { name: "＋", exact: true }).click();
    await win.getByRole("button", { name: "Claude", exact: true }).click();

    // 草稿态：提示行（不落库、未启 CLI）+ 首条消息 composer；侧栏仍无行
    await expect(win.getByTestId("draft-hint")).toBeVisible({ timeout: 10_000 });
    await expect(win.getByTestId("draft-hint")).toContainText("尚未保存、未启动 CLI，发出第一条消息后才创建会话");
    await expect(win.locator("aside").getByText("暂无会话")).toBeVisible();
    await shot(win, SHOT_DIR, "01-draft-pane.png");

    // 提交失败卡：标题/影响说明/重试发送；草稿与输入保留
    await send(win, "要重试的首条");
    const card = win.getByTestId("create-error-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("找不到 CLI 程序（Claude）");
    await expect(card.getByRole("button", { name: "重试发送" })).toBeVisible();
    await expect(win.getByPlaceholder("输入消息，/ 开头触发 Skill…")).toHaveValue("要重试的首条");
    await shot(win, SHOT_DIR, "02-draft-submit-error.png");

    // 重试成功 → 会话行出现（供 hover 操作与删除确认截图）
    await card.getByRole("button", { name: "重试发送" }).click();
    await expect(win.getByText("新会话 · Claude").first()).toBeVisible({ timeout: 10_000 });
    await expect(win.getByText("空闲").first()).toBeVisible({ timeout: 20_000 });

    // 行 hover：归档/删除操作区（原型演示② .ops；常驻 pr 预留右缘，徽标不进入）
    const row = sessionRow(win, "新会话 · Claude");
    await row.hover();
    await expect(row.getByRole("button", { name: "归档", exact: true })).toBeVisible();
    await shot(win, SHOT_DIR, "03-session-hover-ops.png");

    // 删除二次确认：影响说明 + 不可撤销 + 取消/删除（原型演示② modal）；取消不发请求
    await row.getByRole("button", { name: "删除", exact: true }).click();
    const dialog = win.getByTestId("delete-session-dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toContainText("确定删除『新会话 · Claude』吗？");
    await expect(dialog).toContainText("CLI 原生历史文件不删除。此操作不可撤销。");
    await shot(win, SHOT_DIR, "04-delete-confirm.png");
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(win.getByTestId("delete-session-overlay")).toHaveCount(0);
    await second.app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("原型对照③⑤ + 布局基线：断开恢复引导条 + 设置面板三区 + 已归档分组 + 扫描反馈 + 顶栏/三分组/底部入口", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    // 第一段：A(Claude) 手动归档、B(Codex) 待自动归档、C(OpenCode) 留存、PTY 行留存；开启自动归档（天数 1）
    const first = await launchApp(userData, repoDir);
    await first.win.getByRole("button", { name: "＋ 注册", exact: true }).click();
    await expect(first.win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
    await createSession(first.win, "Claude");
    const rowA = sessionRow(first.win, "新会话 · Claude");
    await rowA.hover();
    await rowA.getByRole("button", { name: "归档", exact: true }).click();
    await expect(first.win.locator("aside").getByText("新会话 · Claude")).toHaveCount(0, { timeout: 10_000 });
    await createSession(first.win, "Codex");
    await createSession(first.win, "OpenCode");
    await first.win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
    await first.win.getByRole("button", { name: "＋", exact: true }).click();
    await first.win.getByRole("button", { name: /PTY 终端/ }).click();
    await first.win.locator(".xterm").first().click();
    await first.win.keyboard.type("echo kb-s5-pty");
    await first.win.keyboard.press("Enter");
    await expect(first.win.getByText(/^终端 · /).first()).toBeVisible({ timeout: 15_000 });

    await first.win.getByRole("button", { name: "设置", exact: true }).click();
    await expect(first.win.getByTestId("settings-modal")).toBeVisible({ timeout: 10_000 });
    await first.win.getByTestId("auto-archive-switch").click();
    await expect(first.win.getByTestId("auto-archive-switch")).toHaveAttribute("aria-checked", "true");
    await first.win.getByTestId("auto-archive-days").fill("1");
    await first.win.getByTestId("auto-archive-days").blur();
    await expect(first.win.getByTestId("auto-archive-days")).toHaveValue("1", { timeout: 10_000 });
    await first.win.getByTestId("settings-modal").getByRole("button", { name: "完成" }).click();
    await first.app.close();

    // 直接写库造超期：B(Codex) 最后活跃改为 3 天前（天数 1 即超期；C/PTY 为新近活跃不触发）
    seedExpired(userData, "新会话 · Codex", "2020-01-01T00:00:00.000Z");

    // 第二段（同一 userData 重启）：启动扫描归档 B；留存行断开态 + 恢复引导条 + 设置面板三区
    const second = await launchApp(userData);
    const win = second.win;
    await expect(win.getByText("已断开").first()).toBeVisible({ timeout: 15_000 });
    await expect(win.locator("aside").getByText("新会话 · Codex")).toHaveCount(0, { timeout: 10_000 }); // B 已被自动归档移出

    // 布局基线（必须一致项）：顶栏 42px + 应用名/项目徽标/设置入口；侧栏三分组 + 底部三入口；会话行 色点+主仓库徽标+状态徽标
    await expect(win.locator("header")).toHaveCSS("height", "42px");
    await expect(win.getByText("Kanban Desktop")).toBeVisible();
    await expect(win.getByText("设置")).toBeVisible();
    await expect(win.getByText("项目", { exact: true })).toBeVisible();
    await expect(win.getByText("结构化会话")).toBeVisible();
    await expect(win.getByText("PTY 终端")).toBeVisible();
    for (const entry of ["看板", "记忆", "Diff"]) {
      await expect(win.locator("aside").getByText(new RegExp(`^${entry}`))).toBeVisible();
    }
    await expect(win.getByText("主仓库", { exact: true }).first()).toBeVisible();
    await shot(win, SHOT_DIR, "08-layout-baseline.png");

    // 断开会话恢复引导条（必须一致项：文案与按钮与现网 ResumeBanner 一字不差）
    await win.locator("aside").getByText("新会话 · OpenCode").click();
    const resumeBanner = win.getByTestId("resume-banner");
    await expect(resumeBanner).toBeVisible({ timeout: 10_000 });
    await expect(resumeBanner).toContainText("📴 会话「新会话 · OpenCode」来自上次运行（CLI 已退出）。缓存消息不替代原生历史。");
    await expect(win.getByRole("button", { name: "读取原生历史并恢复" })).toBeVisible();
    await shot(win, SHOT_DIR, "05-disconnected-resume-banner.png");

    // 设置面板三区（必须一致项：保留两项日志动作）：日志区 + 自动归档（开关开/天数 1/扫描反馈「归档 1 条」）+ 已归档按项目分组
    await win.getByRole("button", { name: "设置", exact: true }).click();
    const modal = win.getByTestId("settings-modal");
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await expect(win.getByTestId("settings-log-section").getByRole("button", { name: "打开日志文件" })).toBeVisible();
    await expect(win.getByTestId("settings-log-section").getByRole("button", { name: "复制日志文件路径" })).toBeVisible();
    await expect(win.getByTestId("auto-archive-switch")).toHaveAttribute("aria-checked", "true");
    await expect(win.getByTestId("auto-archive-days")).toHaveValue("1");
    await expect(win.getByTestId("auto-archive-feedback")).toContainText("上次扫描：归档 1 条会话。", { timeout: 15_000 });
    await shot(win, SHOT_DIR, "06-settings-modal.png");

    // 已归档分组（原型演示③ .arch-group）：当前项目组默认展开，组头 名称+N 条，条目 色点/标题/CLI/最后活跃/归档时间/操作
    const group = win.getByTestId("archived-group").filter({ hasText: PROJECT_NAME });
    await expect(group.getByTestId("archived-group-head")).toContainText("2 条");
    await expect(group.getByTestId("archived-item").filter({ hasText: "新会话 · Claude" })).toContainText("最后活跃");
    await expect(group.getByTestId("archived-item").filter({ hasText: "新会话 · Codex" })).toContainText("归档于");
    await shot(win, SHOT_DIR, "07-archived-group.png");
    await second.app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});
