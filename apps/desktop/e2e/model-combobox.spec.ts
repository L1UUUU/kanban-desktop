// 用途：模型 combobox 四状态整机 E2E（issue #81 / spec #75 收口）—— 真实 preload/IPC/worker 全链驱动 Fake 演示 CLI：
// 就绪（默认自动选中+角标+id 副行）/ 过滤（displayName·id 不分大小写）/ 加载中（列表未就绪阻塞首条发送，KANBAN_FAKE_MODELS_DELAY_MS 注入）/
// 拉取失败（原因行+手输 id 兜底发送，KANBAN_FAKE_MODELS_FAIL_FIRST 注入）；
// 「默认选中真实下发」以 KANBAN_FAKE_CREATE_FAIL_FIRST 失败卡原文携带 model=<id> 见证（所见即所发的整机证据）。
// 截图归档 docs/acceptance/model-combobox/（KANBAN_UPDATE_SCREENSHOTS=1 时写回）。
import { test, expect, _electron, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shot } from "./helpers/acceptance-artifacts";

const PROJECT_NAME = "kb-model-combo";
const SHOT_DIR = resolve(__dirname, "../../../docs/acceptance/model-combobox");

/** 建隔离 fixture：独立 userData + 伪 git 主仓库目录 */
function makeFixture(): { userData: string; repoDir: string; repoRoot: string } {
  const userData = mkdtempSync(join(tmpdir(), "kb-mc-user-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "kb-mc-repo-"));
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

/** 启动应用（Fake 演示链路：真实 CLI 回落 Fake；userData 隔离；extraEnv 透传模型链路注入钩子） */
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

/** 注册项目并等项目行出现 */
async function registerProject(win: Page): Promise<void> {
  await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
  await expect(win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
}

/** 经项目行「＋」打开 Claude 草稿（全局单草稿：替换 boot 演示草稿），返回草稿面板内的模型 combobox */
async function openClaudeDraft(win: Page): Promise<Locator> {
  await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
  await win.getByRole("button", { name: "＋", exact: true }).click();
  await win.getByRole("button", { name: "Claude", exact: true }).click();
  await expect(win.getByTestId("draft-hint")).toBeVisible({ timeout: 10_000 });
  await expect(win.getByTestId("draft-hint")).toContainText("新会话 · Claude");
  return win.getByTestId("draft-pane").getByRole("combobox");
}

/** 在 composer 输入并发送 */
async function send(win: Page, text: string): Promise<void> {
  await win.getByPlaceholder("输入消息，/ 开头触发 Skill…").fill(text);
  await win.getByRole("button", { name: "发送 ➤" }).click();
}

test("就绪：默认自动选中（角标+id 副行）→ 过滤命中/零命中 → 点选候选下发建会话", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    const { app, win } = await launchApp(userData, repoDir);
    await registerProject(win);

    // 草稿打开即预取；就绪后自动选中 isDefault 项（displayName 主行），有输入即发送可用（单一就绪态）
    const combo = await openClaudeDraft(win);
    await expect(combo).toHaveValue("Fake 标准模型", { timeout: 10_000 });
    await win.getByPlaceholder("输入消息，/ 开头触发 Skill…").fill("首条消息（建立会话）");
    await expect(win.getByRole("button", { name: "发送 ➤" })).toBeEnabled();

    // 下拉：默认项带「默认」角标 + 完整 id 副行；aria-selected 指向默认项
    await combo.focus();
    const listbox = win.getByRole("listbox", { name: "模型列表" });
    await expect(listbox).toBeVisible();
    await expect(listbox.getByText("默认", { exact: true })).toBeVisible();
    await expect(listbox.getByText("fake-standard")).toBeVisible();
    await expect(listbox.getByText("fake-lite")).toBeVisible();
    await expect(listbox.getByRole("option", { name: /Fake 标准模型/ })).toHaveAttribute("aria-selected", "true");
    await shot(win, SHOT_DIR, "01-combobox-ready-default.png");

    // 过滤：displayName/id 不分大小写包含匹配；零命中如数呈现
    await combo.fill("LITE");
    await expect(listbox.getByRole("option")).toHaveCount(1);
    await expect(listbox.getByRole("option").first()).toContainText("Fake 轻量模型");
    await expect(listbox).toContainText("匹配 1 项 · 回车使用输入内容");
    await shot(win, SHOT_DIR, "02-combobox-filter.png");
    await combo.fill("不存在的模型");
    await expect(listbox.getByRole("option")).toHaveCount(0);
    await expect(listbox).toContainText("匹配 0 项 · 回车使用输入内容");

    // 点选候选：回填 displayName 并收起；随首条消息真实下发 → 会话建立
    await combo.fill("lite");
    await listbox.getByRole("option", { name: /Fake 轻量模型/ }).click();
    await expect(combo).toHaveValue("Fake 轻量模型");
    await expect(listbox).toBeHidden();
    await win.getByRole("button", { name: "发送 ➤" }).click();
    await expect(win.locator("aside").getByText("首条消息（建立会话）")).toBeVisible({ timeout: 10_000 }); // #94：标题=首条派生
    // 已建会话 composer 不自动改选：chip 保持切换后的模型
    await expect(win.getByRole("combobox")).toHaveValue("Fake 轻量模型");

    await app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("默认选中真实下发（所见即所发）：创建失败卡原文携带 model=fake-standard 见证 → 换选重试收敛", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    // 前一次创建抛 E_SPAWN_NOT_FOUND；消息携带 FakeAdapter 实收 model（整机下发见证）
    const { app, win } = await launchApp(userData, repoDir, { KANBAN_FAKE_CREATE_FAIL_FIRST: "1" });
    await registerProject(win);

    const combo = await openClaudeDraft(win);
    await expect(combo).toHaveValue("Fake 标准模型", { timeout: 10_000 }); // 未动任何控件：默认选中

    await send(win, "首条消息（建立会话）");
    const card = win.getByTestId("create-error-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("找不到 CLI 程序（Claude）");
    // 整机下发见证：草稿未手改，创建请求到达 FakeAdapter 时携带的就是默认选中项 id
    await expect(card).toContainText("model=fake-standard");

    // 换选候选后重试：收敛为会话建立（失败不卡死草稿，模型可改可重发）
    await combo.focus();
    await win.getByRole("listbox", { name: "模型列表" }).getByRole("option", { name: /Fake 轻量模型/ }).click();
    await expect(combo).toHaveValue("Fake 轻量模型");
    await card.getByRole("button", { name: "重试发送" }).click();
    await expect(win.locator("aside").getByText("首条消息（建立会话）")).toBeVisible({ timeout: 10_000 }); // #94：标题=首条派生
    await expect(win.getByRole("combobox")).toHaveValue("Fake 轻量模型");

    await app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("加载中：列表未就绪阻塞首条发送（输入可编辑、发送禁用），就绪后默认选中放行", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    // listModels 前置延迟 4s：观察「加载中」阻塞窗口
    const { app, win } = await launchApp(userData, repoDir, { KANBAN_FAKE_MODELS_DELAY_MS: "4000" });
    await registerProject(win);

    const combo = await openClaudeDraft(win);
    await expect(combo).toHaveValue("模型列表加载中…", { timeout: 5_000 });
    await expect(combo).toHaveAttribute("readonly"); // 加载态只读（不展开、不过滤）

    // 草稿文本可编辑，但发送禁用（模型未选不得发——「我以为选了 A、实际用了 B」防线）
    await win.getByPlaceholder("输入消息，/ 开头触发 Skill…").fill("加载中想发的首条");
    await expect(win.getByRole("button", { name: "发送 ➤" })).toBeDisabled();
    await shot(win, SHOT_DIR, "03-combobox-loading.png");

    // 延迟到期就绪：默认选中自动完成，发送放行，链路收敛
    await expect(combo).toHaveValue("Fake 标准模型", { timeout: 15_000 });
    await expect(win.getByRole("button", { name: "发送 ➤" })).toBeEnabled();
    await send(win, "首条消息（建立会话）");
    await expect(win.locator("aside").getByText("首条消息（建立会话）")).toBeVisible({ timeout: 10_000 }); // #94：标题=首条派生

    await app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("拉取失败：原因行展示 + 手输列表外 id 兜底发送（列表外 id 原样展示）", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    // 前一次 listModels 抛 E_SPAWN_NOT_FOUND：驱动 combobox 失败态（boot 演示草稿消费 fake 实例，Claude 实例独立计数同样失败）
    const { app, win } = await launchApp(userData, repoDir, { KANBAN_FAKE_MODELS_FAIL_FIRST: "1" });
    await registerProject(win);

    const combo = await openClaudeDraft(win);
    // 失败态：聚焦展示原因行与手输指引（无「默认/自选」逃生项）
    await combo.focus();
    const listbox = win.getByRole("listbox", { name: "模型列表" });
    await expect(listbox).toBeVisible({ timeout: 10_000 });
    await expect(listbox).toContainText("模型列表获取失败：");
    await expect(listbox).toContainText("FakeAdapter 注入"); // 原因原文保留（不吞错）
    await expect(listbox).toContainText("手动输入模型 id 后回车");

    // 手输列表外 id：回车即采用（下发原样），发送放行
    await combo.fill("my-custom-model");
    await combo.press("Enter");
    await expect(combo).toHaveValue("my-custom-model"); // 不在列表：展示原始 id
    await shot(win, SHOT_DIR, "04-combobox-error-manual.png");
    await send(win, "首条消息（建立会话）");
    await expect(win.locator("aside").getByText("首条消息（建立会话）")).toBeVisible({ timeout: 10_000 }); // #94：标题=首条派生
    // 已建会话 chip 沿用手输 id（列表外原始展示）
    await expect(win.getByRole("combobox")).toHaveValue("my-custom-model");

    await app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});
