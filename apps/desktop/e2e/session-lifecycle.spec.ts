// 用途：会话生命周期全流程整机验收（issue #65 / spec #57）—— 草稿优先（结构化+PTY+单草稿替换）→ 首条消息成会话 →
// 归档移出默认列表 → 设置面板按项目分组 → 取消归档回列表并可恢复续聊 → 删除二次确认与激活切换（下一条/上一条/空态）→
// 重启后历史与配置正确；失败注入：Fake 创建失败可重试（KANBAN_FAKE_CREATE_FAIL_FIRST）与终端启动失败回删无孤儿行可重试。
// 草稿 UI 级失败重试（缓冲保留/继续输入即重试）由 A 类 terminal-draft.test.ts / ChatWorkspace.test.tsx 覆盖，本 spec 走 Main 编排面（直连 invoke 先例 lifecycle.spec）。
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_NAME = "kb-lc-repo";

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
  const userData = mkdtempSync(join(tmpdir(), "kb-lc-user-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "kb-lc-repo-"));
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

/** 经项目行「＋」→ 菜单选 CLI：#59 草稿语义——点 CLI 只开草稿，发出首条消息才创建会话（侧栏行出现；#94：行标题=首条消息派生，text 参数区分多会话） */
async function createSession(win: Page, cliLabel: string, nth = 0, text = "首条消息（建立会话）"): Promise<void> {
  await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
  await win.getByRole("button", { name: "＋", exact: true }).click();
  await win.getByRole("button", { name: cliLabel, exact: true }).click();
  await expect(win.getByTestId("draft-hint")).toBeVisible({ timeout: 10_000 });
  await send(win, text);
  await expect(win.locator("aside").getByText(text).nth(nth)).toBeVisible({ timeout: 10_000 });
}

/** 项目行悬浮「＋」打开新建菜单（hover 复用） */
async function openCreateMenu(win: Page): Promise<void> {
  await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
  await win.getByRole("button", { name: "＋", exact: true }).click();
}

/** 定位侧栏某标题的会话行容器（含 hover 操作区；div.group 同时匹配项目行，靠标题区分） */
function sessionRow(win: Page, title: string) {
  return win.locator("aside").locator("div.group").filter({ hasText: title });
}

/** 在终端面板键入文本并回车（点击 .xterm 聚焦后走键盘事件 → term.onData） */
async function typeInTerminal(win: Page, line: string): Promise<void> {
  await win.locator(".xterm").first().click();
  await win.keyboard.type(line);
  await win.keyboard.press("Enter");
}

test("草稿优先：点「＋」只开草稿（结构化与 PTY）→ 单草稿替换 → 首条消息才成会话", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    const { app, win } = await launchApp(userData, repoDir);
    await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
    await expect(win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });

    // 结构化草稿：点 CLI 后中央区出草稿提示，侧栏结构化分组仍空（不落库、不进列表）
    await openCreateMenu(win);
    await win.getByRole("button", { name: "Claude", exact: true }).click();
    await expect(win.getByTestId("draft-hint")).toBeVisible({ timeout: 10_000 });
    await expect(win.getByTestId("draft-hint")).toContainText("新会话 · Claude");
    await expect(win.locator("aside").getByText("暂无会话")).toBeVisible();

    // 结构化→结构化替换：明确提示「已替换上一个草稿：全局仅一个」
    await openCreateMenu(win);
    await win.getByRole("button", { name: "Codex", exact: true }).click();
    await expect(win.getByTestId("draft-hint")).toContainText("新会话 · Codex", { timeout: 10_000 });
    await expect(win.getByTestId("draft-hint")).toContainText("已替换上一个草稿：全局仅一个");

    // 结构化→PTY 替换：终端草稿占位中央区（面板整体切换即替换信号），PTY 分组仍空（不起进程、不落库）
    await openCreateMenu(win);
    await win.getByRole("button", { name: /PTY 终端/ }).click();
    await expect(win.getByText(/终端草稿 · 尚未启动进程/)).toBeVisible({ timeout: 15_000 });
    await expect(win.locator(".xterm").first()).toBeVisible({ timeout: 15_000 });
    await expect(win.getByText("暂无终端会话")).toBeVisible();
    await expect(win.getByTestId("draft-hint")).toHaveCount(0); // 结构化草稿已被替换

    // PTY→结构化替换（双向）：草稿面板回到中央区，终端面板卸载
    await openCreateMenu(win);
    await win.getByRole("button", { name: "Claude", exact: true }).click();
    await expect(win.getByTestId("draft-hint")).toBeVisible({ timeout: 10_000 });
    await expect(win.locator(".xterm")).toHaveCount(0);

    // 首条消息 = 创建+落库+发送原子链：侧栏出现会话行并激活
    await send(win, "首条消息（建立会话）");
    await expect(win.locator("aside").getByText("首条消息（建立会话）")).toBeVisible({ timeout: 10_000 }); // #94：标题=首条派生
    await expect(win.locator('aside [data-testid="session-row"][data-active="true"]')).toContainText("首条消息（建立会话）");

    // PTY 草稿首输入才创建：键入首个字符 → 终端行落库出现在 PTY 分组
    await openCreateMenu(win);
    await win.getByRole("button", { name: /PTY 终端/ }).click();
    await expect(win.getByText(/终端草稿 · 尚未启动进程/)).toBeVisible({ timeout: 15_000 });
    await typeInTerminal(win, "echo kb-lc-pty");
    await expect(win.getByText(/^终端 · /).first()).toBeVisible({ timeout: 15_000 });

    await app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("归档 → 设置面板按项目分组 → 取消归档回列表（已断开可恢复）→ 读取原生历史恢复续聊", async () => {
  test.setTimeout(150_000); // 单次运行内完成归档/取消归档/恢复/续聊全链，Fake 轮次 + 多次模态交互超 60s 默认预算
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    const { app, win } = await launchApp(userData, repoDir);
    await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
    await expect(win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
    await createSession(win, "Claude");
    await send(win, "拆类型");
    await expect(win.getByText("空闲").first()).toBeVisible({ timeout: 30_000 });

    // hover 归档：行移出默认列表（数据保留），结构化分组回空态
    const row = sessionRow(win, "首条消息（建立会话）"); // #94：行标题=首条派生
    await row.hover();
    await row.getByRole("button", { name: "归档", exact: true }).click();
    await expect(win.locator("aside").getByText("首条消息（建立会话）")).toHaveCount(0, { timeout: 10_000 });
    await expect(win.locator("aside").getByText("暂无会话")).toBeVisible();

    // 设置面板：已归档会话按项目分组可见（当前项目分组默认展开），条目含标题/CLI/最后活跃/归档时间
    await win.getByRole("button", { name: "设置", exact: true }).click();
    const modal = win.getByTestId("settings-modal");
    await expect(modal).toBeVisible({ timeout: 10_000 });
    const group = win.getByTestId("archived-group").filter({ hasText: PROJECT_NAME });
    await expect(group.getByTestId("archived-group-head")).toBeVisible();
    await expect(group.getByTestId("archived-group-head")).toContainText("1 条");
    const item = group.getByTestId("archived-item");
    await expect(item).toContainText("首条消息（建立会话）"); // #94：标题=首条派生
    await expect(item).toContainText("Claude · 最后活跃");
    await expect(item).toContainText("归档于");

    // 取消归档：行回默认列表（已断开·可恢复），归档列表回空态提示
    await item.getByTestId("archived-unarchive").click();
    await expect(win.getByTestId("archived-empty")).toBeVisible({ timeout: 10_000 });
    await modal.getByRole("button", { name: "完成" }).click();
    await expect(win.locator("aside").getByText("首条消息（建立会话）")).toBeVisible({ timeout: 10_000 });
    await expect(win.getByText("已断开").first()).toBeVisible();

    // 结构化行选中即出恢复引导条 → 读取原生历史并恢复 → 空闲可续聊
    await win.locator("aside").getByText("首条消息（建立会话）").click();
    const resumeBanner = win.getByTestId("resume-banner");
    await expect(resumeBanner).toBeVisible({ timeout: 10_000 });
    await expect(resumeBanner).toContainText("缓存消息不替代原生历史");
    await win.getByRole("button", { name: "读取原生历史并恢复" }).click();
    await expect(win.getByText("空闲").first()).toBeVisible({ timeout: 15_000 });
    await expect(resumeBanner).toHaveCount(0);
    await send(win, "中断后继续");
    await expect(win.getByText("基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。")).toBeVisible({ timeout: 30_000 });

    await app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("删除二次确认与激活切换：取消不发请求 → 删激活切相邻（下一条/上一条）→ 全删空态", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    const { app, win } = await launchApp(userData, repoDir);
    await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
    await expect(win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
    // 三会话按创建序 A(Codex) B(Claude) C(OpenCode)；创建后激活 = C（#94：各会话用不同首条消息区分派生标题）
    await createSession(win, "Codex", 0, "甲会话首条");
    await createSession(win, "Claude", 0, "乙会话首条");
    await createSession(win, "OpenCode", 0, "丙会话首条");
    const activeRow = win.locator('aside [data-testid="session-row"][data-active="true"]');
    await expect(activeRow).toContainText("丙会话首条");

    // hover 删除 → 二次确认（影响说明 + 不可撤销）；「取消」不发请求、行保留
    const rowA = sessionRow(win, "甲会话首条");
    await rowA.hover();
    await rowA.getByRole("button", { name: "删除", exact: true }).click();
    const dialog = win.getByTestId("delete-session-dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toContainText("确定删除『甲会话首条』吗？");
    await expect(dialog).toContainText("此操作不可撤销");
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(win.getByTestId("delete-session-overlay")).toHaveCount(0);
    await expect(win.locator("aside").getByText("甲会话首条")).toBeVisible();

    // 删除激活的 C（排序末位）→ 无下一条切上一条 B
    const rowC = sessionRow(win, "丙会话首条");
    await rowC.hover();
    await rowC.getByRole("button", { name: "删除", exact: true }).click();
    await win.getByTestId("delete-session-confirm").click();
    await expect(win.locator("aside").getByText("丙会话首条")).toHaveCount(0, { timeout: 10_000 });
    await expect(activeRow).toContainText("乙会话首条");

    // 删除 B（现为末位）→ 切上一条 A
    const rowB = sessionRow(win, "乙会话首条");
    await rowB.hover();
    await rowB.getByRole("button", { name: "删除", exact: true }).click();
    await win.getByTestId("delete-session-confirm").click();
    await expect(win.locator("aside").getByText("乙会话首条")).toHaveCount(0, { timeout: 10_000 });
    await expect(activeRow).toContainText("甲会话首条");

    // 全删 → 空态：侧栏与中央区均无会话
    await rowA.hover();
    await rowA.getByRole("button", { name: "删除", exact: true }).click();
    await win.getByTestId("delete-session-confirm").click();
    await expect(win.locator("aside").getByText("暂无会话")).toBeVisible({ timeout: 10_000 });
    await expect(win.locator("aside").locator('[data-testid="session-row"]')).toHaveCount(0);

    await app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("重启后历史与配置正确：会话恢复断开态 + autoArchive 开关/天数持久化 + 启动扫描反馈", async () => {
  test.setTimeout(150_000); // 两次启动 + 两轮设置面板交互，超 60s 默认预算
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    // 第一段：两会话（各跑完一轮）+ 设置面板开启自动归档（天数 45）→ 持久化
    const first = await launchApp(userData, repoDir);
    await first.win.getByRole("button", { name: "＋ 注册", exact: true }).click();
    await expect(first.win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
    await createSession(first.win, "Claude", 0, "重启可见的会话");
    await createSession(first.win, "Codex", 0, "码字会话首条");
    await expect(first.win.getByText("空闲").first()).toBeVisible({ timeout: 30_000 });

    await first.win.getByRole("button", { name: "设置", exact: true }).click();
    const modal1 = first.win.getByTestId("settings-modal");
    await expect(modal1).toBeVisible({ timeout: 10_000 });
    await first.win.getByTestId("auto-archive-switch").click();
    await expect(first.win.getByTestId("auto-archive-switch")).toHaveAttribute("aria-checked", "true");
    // 保存成功触发扫描：新会话均未超期 → 反馈「归档 0 条」（异步扫描，容忍短暂「尚未扫描」）
    await expect(first.win.getByTestId("auto-archive-feedback")).toContainText("上次扫描：归档 0 条会话。", { timeout: 15_000 });
    await first.win.getByTestId("auto-archive-days").fill("45");
    await first.win.getByTestId("auto-archive-days").blur();
    await expect(first.win.getByTestId("auto-archive-days")).toHaveValue("45", { timeout: 10_000 });
    await modal1.getByRole("button", { name: "完成" }).click();
    await first.app.close();

    // 第二段（同一 userData 重启）：会话恢复为已断开态（产生过对话的会话保留；无空会话行）
    const second = await launchApp(userData);
    await expect(second.win.getByText("已断开").first()).toBeVisible({ timeout: 15_000 });
    await expect(second.win.locator("aside").locator('[data-testid="session-row"]')).toHaveCount(2, { timeout: 10_000 });
    await expect(second.win.locator("aside").getByText("重启可见的会话")).toBeVisible(); // #94：重启行标题=DB 派生值
    await expect(second.win.locator("aside").getByText("码字会话首条")).toBeVisible();

    // 配置正确：开关仍开、天数 45 仍生效；启动扫描已跑（异步，反馈最终为上次扫描结果）
    await second.win.getByRole("button", { name: "设置", exact: true }).click();
    const modal2 = second.win.getByTestId("settings-modal");
    await expect(modal2).toBeVisible({ timeout: 10_000 });
    await expect(second.win.getByTestId("auto-archive-switch")).toHaveAttribute("aria-checked", "true");
    await expect(second.win.getByTestId("auto-archive-days")).toHaveValue("45");
    await expect(second.win.getByTestId("auto-archive-feedback")).toContainText("上次扫描：归档 0 条会话。", { timeout: 15_000 });
    await second.app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("失败注入：Fake 创建失败（E_SPAWN_NOT_FOUND）→ 草稿与输入保留 → 「重试发送」成功", async () => {
  test.setTimeout(120_000); // 两次启动（第二次带失败注入），超 60s 默认预算
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    // 第一次运行仅注册项目（占住「首个项目」判定，避免 boot 演示草稿消耗失败注入）
    const first = await launchApp(userData, repoDir);
    await first.win.getByRole("button", { name: "＋ 注册", exact: true }).click();
    await expect(first.win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
    await first.app.close();

    // 第二次运行注入：Fake 前一次 createSession 抛 E_SPAWN_NOT_FOUND → 首条消息触发「创建+发送」失败
    const second = await launchApp(userData, undefined, { KANBAN_FAKE_CREATE_FAIL_FIRST: "1" });
    const win = second.win;
    await openCreateMenu(win);
    await win.getByRole("button", { name: "Claude", exact: true }).click();
    await expect(win.getByTestId("draft-hint")).toBeVisible({ timeout: 10_000 });
    await send(win, "要重试的首条");

    // 失败可重试：失败卡 + 草稿保留 + 输入保留 + 不留空会话（侧栏无行）
    const card = win.getByTestId("create-error-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("找不到 CLI 程序（Claude）");
    await expect(win.getByTestId("draft-hint")).toBeVisible();
    await expect(win.getByPlaceholder("输入消息，/ 开头触发 Skill…")).toHaveValue("要重试的首条");
    await expect(win.locator("aside").getByText("暂无会话")).toBeVisible();

    // 重试发送：重新执行「创建+发送首条消息」→ 成功后卡消失 + 会话登记 + 草稿丢弃
    await card.getByRole("button", { name: "重试发送" }).click();
    await expect(card).toHaveCount(0, { timeout: 15_000 });
    await expect(win.locator("aside").getByText("要重试的首条")).toBeVisible({ timeout: 10_000 }); // #94：标题=首条派生
    await second.app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("失败注入：终端启动失败回删无孤儿行 → 重试（有效命令）成功 → 重启后仅成功创建的终端行", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    const { app, win } = await launchApp(userData, repoDir);
    await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
    await expect(win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });

    // 直连 IPC（与 lifecycle.spec 同款先例）：command 解析失败（PATH 无此命令）→ 先落库占位被回删，返回明确错误
    const failed = await win.evaluate(async (cwd) => {
      const api = (window as { api?: { invoke(req: unknown): Promise<{ ok: boolean; error?: { code: string; message: string } }> } }).api;
      if (!api) throw new Error("window.api 不可用");
      return api.invoke({
        channel: "terminal:create",
        terminalId: crypto.randomUUID(),
        cwd,
        command: { exe: "kb-e2e-missing-shell-xyz", args: [] },
        firstInput: "x",
      });
    }, repoDir);
    expect(failed.ok).toBe(false);
    expect(failed.error?.message).toContain("未找到命令");
    await expect(win.getByText("暂无终端会话")).toBeVisible(); // 回删占位：无孤儿行

    // 重试成功：同一链路换有效命令 → 创建成功（projectId 取自 project:list，重启后行随项目过滤可见）
    const ok = await win.evaluate(async ({ cwd, marker }) => {
      const api = (window as {
        api?: {
          invoke(req: unknown): Promise<{ ok: boolean; sessionId?: string; projects?: Array<{ id: string }> }>;
        };
      }).api;
      if (!api) throw new Error("window.api 不可用");
      const list = await api.invoke({ channel: "project:list" });
      const projectId = list.ok && list.projects?.[0] ? list.projects[0].id : undefined;
      return api.invoke({
        channel: "terminal:create",
        terminalId: crypto.randomUUID(),
        cwd,
        ...(projectId ? { projectId } : {}),
        command: { exe: "powershell.exe", args: ["-NoProfile", "-Command", `Write-Output ${marker}`] },
      });
    }, { cwd: repoDir, marker: "kb-lc-term-ok" });
    expect(ok.ok).toBe(true);
    await app.close();

    // 重启（同一 userData）：失败的创建未留任何记录（重启也不被恢复），仅成功创建的终端一行
    const second = await launchApp(userData);
    await expect(second.win.getByText(/^终端 · /).first()).toBeVisible({ timeout: 15_000 });
    await expect(second.win.locator("aside").locator('[data-testid="session-row"]').filter({ hasText: /终端 · / })).toHaveCount(1);
    await second.app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});
