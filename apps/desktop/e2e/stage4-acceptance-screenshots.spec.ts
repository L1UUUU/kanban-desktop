// 用途：阶段 4 验收截图编排（issue #50 / spec #40 I 节验证要求）—— Fake 链路注入目标状态后截图存 docs/acceptance/stage4/screenshots/，
// 逐条覆盖原型 stage4-polish-ui.prototype.html 四演示 tab 必须一致项（I-1 Diff 头部/文件行/行级红绿、I-2 错误卡五类、
// I-3 恢复条三态、I-4 残留通知条+进程表、I-5 侧栏第四入口激活态）；断言随截图进行，兼作关键交互实测记录；
// 深度交互断言引用既有 diff / error-cards / resume-banner / residue 四 spec 用例结果，本 spec 不重复造轮子。
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SHOT_DIR = resolve(__dirname, "../../../docs/acceptance/stage4/screenshots");

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

/** 在 dir 内执行一条 git 命令（禁 autocrlf 保证 LF 行尾稳定断言，与 diff.spec.ts 同款） */
function git(dir: string, ...args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
}

/** Diff 截图 fixture：真实 git 仓库，基线三文件 commit 后做 M/D/R/binary/U 五类未提交变更（与 diff.spec.ts 同口径，统计 +3 -2） */
function makeDiffRepo(): { repoDir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "kb-s4-shot-diff-"));
  const repoDir = join(root, "s4-shot-repo");
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init");
  git(repoDir, "config", "core.autocrlf", "false");
  git(repoDir, "config", "user.email", "e2e@kanban");
  git(repoDir, "config", "user.name", "e2e");
  writeFileSync(join(repoDir, "a.txt"), "line1\nline2\nline3\n", "utf8");
  writeFileSync(join(repoDir, "del.txt"), "bye\n", "utf8");
  writeFileSync(join(repoDir, "keep.txt"), "stable\n", "utf8");
  writeFileSync(join(repoDir, "logo.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-m", "base");
  writeFileSync(join(repoDir, "a.txt"), "line1\nline2-changed\nline3\nline4\n", "utf8");
  rmSync(join(repoDir, "del.txt"));
  git(repoDir, "mv", "keep.txt", "kept.txt");
  writeFileSync(join(repoDir, "logo.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x1a, 0x0a, 9, 9, 9]));
  mkdirSync(join(repoDir, "notes"), { recursive: true });
  writeFileSync(join(repoDir, "notes", "new.md"), "untracked\n", "utf8");
  return { repoDir, root };
}

/** 聊天类截图 fixture：独立 userData + 伪 git 主仓库目录（错误卡/恢复条驱动用） */
function makeChatFixture(name: string): { userData: string; repoDir: string; roots: string[] } {
  const userData = mkdtempSync(join(tmpdir(), "kb-s4-shot-user-"));
  const root = mkdtempSync(join(tmpdir(), `kb-s4-shot-${name}-`));
  const repoDir = join(root, name);
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  return { userData, repoDir, roots: [userData, root] };
}

/** 残留种子 JSON（与 residue.spec.ts 同形；pid 独立值避免与真实进程混淆；第三条为「疑似」回落行——不精确匹配、默认不勾选） */
const SEED_PROCESSES = [
  { pid: 31432, exePath: "C:\\fake-npm\\@openai\\codex\\codex.exe", startedAt: "2026-11-09T01:12:00.000Z", sessionTitle: "实现 Diff 解析" },
  { pid: 32004, exePath: "C:\\fake-npm\\opencode-ai\\bin\\opencode.exe", startedAt: null, sessionTitle: null },
  { pid: 32512, exePath: "C:\\fake-npm\\@openai\\codex\\codex.exe", startedAt: null, sessionTitle: null, suspectedSessionTitle: "修复启动崩溃" },
];

/** 建残留种子 fixture：种子 JSON 落独立临时目录 */
function makeResidueFixture(): { userData: string; seedPath: string; roots: string[] } {
  const userData = mkdtempSync(join(tmpdir(), "kb-s4-shot-user-"));
  const seedDir = mkdtempSync(join(tmpdir(), "kb-s4-shot-seed-"));
  const seedPath = join(seedDir, "residue.json");
  writeFileSync(seedPath, JSON.stringify(SEED_PROCESSES), "utf8");
  return { userData, seedPath, roots: [userData, seedDir] };
}

/** 启动应用（Fake 演示链路：真实 CLI 回落 Fake；userData 隔离；pickDir 可指定；extraEnv 透传注入钩子） */
async function launchApp(userData: string, pickDir?: string, extraEnv?: Record<string, string>): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await _electron.launch({
    args: [join(__dirname, "..")],
    env: {
      ...process.env,
      KANBAN_USER_DATA: userData,
      KANBAN_DISABLE_CLAUDE: "1",
      KANBAN_DISABLE_OPENCODE: "1",
      ...(pickDir ? { KANBAN_TEST_PICK_DIRECTORY: pickDir } : {}),
      ...extraEnv,
    },
  });
  const win = await app.firstWindow();
  return { app, win };
}

/** 截图到验收目录并断言可见性（截图本身即对照证据；断言兼作交互记录） */
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

/** 注册项目 + 建首个 Claude（Fake）会话 */
async function registerAndCreate(win: Page, projectName: string): Promise<void> {
  await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
  await expect(win.locator("aside").getByText(projectName, { exact: true })).toBeVisible({ timeout: 15_000 });
  await win.locator("aside").getByText(projectName, { exact: true }).hover();
  await win.getByRole("button", { name: "＋", exact: true }).click();
  await win.getByRole("button", { name: "Claude", exact: true }).click();
  await expect(win.getByText("新会话 · Claude").first()).toBeVisible({ timeout: 10_000 });
}

test("I-1/I-5 Diff 视图：入口激活态 + 头部统计 + 五类文件行 + 展开行级红绿/untracked 全文 + 折叠/刷新实测 + 空态", async () => {
  const { repoDir, root } = makeDiffRepo();
  const userData = mkdtempSync(join(tmpdir(), "kb-s4-shot-user-"));
  const { app, win } = await launchApp(userData, repoDir);
  try {
    // F9 交互记录：未注册项目（无当前项目）时 Diff 入口禁用
    await expect(win.getByRole("button", { name: "＋ 注册", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(win.getByTestId("diff-entry")).toBeDisabled();

    // 注册项目 → 进入 Diff 视图（第四态）：进入即自动读取，头部统计 + HEAD 对比口径（原型 d1 diff-head）
    await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
    await expect(win.locator("aside").getByText("s4-shot-repo", { exact: true })).toBeVisible({ timeout: 15_000 });
    const entry = win.getByTestId("diff-entry");
    await entry.click();
    await expect(win.getByTestId("diff-stat")).toHaveText("5 个文件 · +3 -2 · 未提交（HEAD 对比）", { timeout: 15_000 });

    // 文件行：五类徽标（M/R/D/U）+ 等宽路径 + 统计标注（原型 d1 diff-file-head；binary 行「二进制文件」）
    const row = (path: string) => win.locator('[data-testid="diff-file-head"]', { hasText: path });
    await expect(row("a.txt").getByTestId("diff-badge-M")).toBeVisible();
    await expect(row("kept.txt").getByTestId("diff-badge-R")).toBeVisible();
    await expect(row("del.txt").getByTestId("diff-badge-D")).toBeVisible();
    await expect(row("notes/new.md").getByTestId("diff-badge-U")).toBeVisible();
    await expect(row("notes/new.md")).toContainText("新文件（未跟踪）");
    await expect(row("logo.bin")).toContainText("二进制文件");
    // 截图 01：整窗含侧栏第四入口激活态（I-5）+ Diff 头部/文件行（I-1）
    await shot(win, "01-diff-head-and-file-list.png");

    // 展开区：hunk 头 + 新增绿行/删除红行/上下文灰字（原型 d1 diff-content 行级渲染）
    await row("a.txt").click();
    await expect(win.getByTestId("diff-line-hunk").first()).toContainText("@@");
    await expect(win.getByTestId("diff-line-add").first()).toHaveText("+line2-changed");
    await expect(win.getByTestId("diff-line-del").first()).toHaveText("-line2");
    await expect(win.getByTestId("diff-line-context").first()).toBeVisible();
    // 截图 02：行级红绿 diff 展开
    await shot(win, "02-diff-expanded-red-green.png");

    // 折叠实测：再点 a.txt 行头 → 行级内容收起（此刻无其他展开文件，全局 add 行归零）
    await row("a.txt").click();
    await expect(win.getByTestId("diff-line-add")).toHaveCount(0);

    // untracked 全文展示（US3）：untracked 新文件列出并展示全文（行数截断保护在 #47 密封测试覆盖）
    await row("notes/new.md").click();
    await expect(row("notes/new.md").locator("..").getByTestId("diff-line-add").first()).toHaveText("+untracked");
    // 截图 03：untracked 全文 + 二进制行标注同屏
    await shot(win, "03-diff-untracked-fulltext.png");

    // 刷新实测：手动刷新 → 统计保持最新一次结果
    await win.getByTestId("diff-refresh").click();
    await expect(win.getByTestId("diff-stat")).toHaveText("5 个文件 · +3 -2 · 未提交（HEAD 对比）");

    await app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(root);
  }

  // 空态（US7 / 票面 Diff 空态流程）：非 git 项目 → 居中空态说明（不弹窗报错）
  const plainRoot = mkdtempSync(join(tmpdir(), "kb-s4-shot-plain-"));
  const plainDir = join(plainRoot, "plain-dir");
  mkdirSync(plainDir, { recursive: true });
  const userData2 = mkdtempSync(join(tmpdir(), "kb-s4-shot-user-"));
  const second = await launchApp(userData2, plainDir);
  try {
    await second.win.getByRole("button", { name: "＋ 注册", exact: true }).click();
    await expect(second.win.locator("aside").getByText("plain-dir", { exact: true })).toBeVisible({ timeout: 15_000 });
    await second.win.getByTestId("diff-entry").click();
    await expect(second.win.getByTestId("diff-empty")).toContainText("当前项目不是 git 仓库", { timeout: 15_000 });
    await expect(second.win.getByTestId("diff-file-head")).toHaveCount(0);
    await shot(second.win, "04-diff-empty-not-a-repo.png");
    await second.app.close();
  } finally {
    await rmBestEffort(userData2);
    await rmBestEffort(plainRoot);
  }
});

test("I-2 错误卡五类呈现与动作（四类 + 未知兜底，原型 d2 信息结构逐张截图）", async () => {
  const { userData, repoDir, roots } = makeChatFixture("kb-s4-errcard");
  try {
    const { app, win } = await launchApp(userData, repoDir);
    await registerAndCreate(win, "kb-s4-errcard");
    const card = win.getByTestId("error-card");

    // 卡 1：CLI 进程异常退出（CLI_EXIT）—— 标题 + 不受影响说明 + 恢复动作（D4）+ 知道了
    await send(win, "错误演示");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("CLI 进程异常退出");
    await expect(card).toContainText("已产生的对话与文件修改不受影响");
    await expect(card.getByRole("button", { name: "读取原生历史并恢复" })).toBeVisible();
    await shot(win, "05-error-card-cli-exit.png");
    // 动作实测：「知道了」→ 卡消失
    await win.getByRole("button", { name: "知道了", exact: true }).click();
    await expect(card).toHaveCount(0);

    // 卡 2：认证失效（AUTH_EXPIRED）—— 按 CLI 指引命令块（等宽底色块）+ 重试 + 打开 PTY 终端
    await send(win, "认证演示");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("登录已失效（Claude）");
    await expect(win.getByTestId("auth-cmd")).toContainText("/login");
    await shot(win, "06-error-card-auth-expired.png");
    // 动作实测：「重试」= 重发最近一条用户消息（第二条同文回显 + 卡确定性复现）
    await win.getByRole("button", { name: "重试", exact: true }).click();
    await expect(win.getByText("认证演示", { exact: true }).nth(1)).toBeVisible({ timeout: 15_000 });
    await expect(card).toBeVisible({ timeout: 15_000 });

    // 卡 3（会话内形态）：找不到 CLI 程序（SPAWN_NOT_FOUND）—— 安装/PATH/配置文件指引 + 复制配置路径
    await send(win, "找不到 CLI");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("找不到 CLI 程序（Claude）");
    await expect(card).toContainText("确认已安装并在 PATH 中");
    await expect(card).toContainText("config.json");
    await expect(card.getByRole("button", { name: "复制配置路径" })).toBeVisible();
    await shot(win, "07-error-card-spawn-not-found.png");

    // 卡 4：协议断连（PROTOCOL_DISCONNECT）—— 原因说明 + 「恢复会话」（与恢复条同一动作，D4）
    await send(win, "断连演示");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("连接中断（Claude）");
    await expect(card).toContainText("恢复时将按需重新拉起 server");
    await shot(win, "08-error-card-protocol-disconnect.png");
    // 动作实测：「恢复会话」→ 卡消失（同一 resume 动作的快捷方式）
    await card.getByRole("button", { name: "恢复会话" }).click();
    await expect(card).toHaveCount(0, { timeout: 15_000 });

    // 卡 5：未知错误（UNKNOWN 兜底）—— 原始 code 与 message 原文（不吞错）+ 复制错误详情
    await send(win, "未知错误演示");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("未知错误");
    await expect(card).toContainText("UNKNOWN");
    await expect(card.getByRole("button", { name: "复制错误详情" })).toBeVisible();
    await shot(win, "09-error-card-unknown.png");

    await app.close();
  } finally {
    for (const r of roots) await rmBestEffort(r);
  }
});

test("I-2 补充：spawn 创建失败侧栏卡（F1 形态，无会话视图可挂时挂创建入口）→ 重试创建收敛", async () => {
  const { userData, repoDir, roots } = makeChatFixture("kb-s4-spawncard");
  try {
    // 第一次运行仅注册项目（占住「首个项目」判定，避免第二次运行的 boot 演示会话消耗失败注入）
    const first = await launchApp(userData, repoDir);
    await first.win.getByRole("button", { name: "＋ 注册", exact: true }).click();
    await expect(first.win.locator("aside").getByText("kb-s4-spawncard", { exact: true })).toBeVisible({ timeout: 15_000 });
    await first.app.close();

    // 第二次运行注入 E_SPAWN_NOT_FOUND → 侧栏创建入口错误卡（对齐原型 d2 卡 3 信息结构）
    const second = await launchApp(userData, undefined, { KANBAN_FAKE_CREATE_FAIL_FIRST: "1" });
    const win = second.win;
    await win.locator("aside").getByText("kb-s4-spawncard", { exact: true }).hover();
    await win.getByRole("button", { name: "＋", exact: true }).click();
    await win.getByRole("button", { name: "Claude", exact: true }).click();
    const card = win.getByTestId("create-error-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("找不到 CLI 程序（Claude）");
    await expect(card).toContainText("config.json");
    await expect(card.getByRole("button", { name: "重试创建" })).toBeVisible();
    await shot(win, "10-error-card-spawn-sidebar.png");
    // 动作实测：「重试创建」→ 以原参数重发 session:create → 卡消失 + 会话登记
    await card.getByRole("button", { name: "重试创建" }).click();
    await expect(card).toHaveCount(0, { timeout: 15_000 });
    await expect(win.getByText("新会话 · Claude").first()).toBeVisible({ timeout: 10_000 });
    await second.app.close();
  } finally {
    for (const r of roots) await rmBestEffort(r);
  }
});

test("I-3 恢复条成功流转：待恢复 → 恢复中（不可中断）→ 成功收敛（三态截图之两张）", async () => {
  const { userData, repoDir, roots } = makeChatFixture("kb-s4-resume-ok");
  try {
    // 第一次运行：注册 + 会话跑一个完整 turn（供重启后断开恢复）
    const first = await launchApp(userData, repoDir);
    await registerAndCreate(first.win, "kb-s4-resume-ok");
    await send(first.win, "拆类型");
    await expect(first.win.getByText("空闲").first()).toBeVisible({ timeout: 30_000 });
    await first.app.close();

    // 重启（同一 userData，注入 4s resume 延迟使「恢复中」态可截图）
    const second = await launchApp(userData, undefined, { KANBAN_FAKE_RESUME_DELAY_MS: "4000" });
    await expect(second.win.getByText("已断开").first()).toBeVisible({ timeout: 15_000 });
    await second.win.getByText("新会话 · Claude").first().click();

    // 待恢复态（原型 d3 banner 1）：会话名 + 缓存不替代原生历史说明 + 主按钮（文案保留，F12）
    const banner = second.win.getByTestId("resume-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("新会话 · Claude");
    await expect(banner).toContainText("缓存消息不替代原生历史");
    await shot(second.win, "11-resume-banner-pending.png");

    // 恢复中态（原型 d3 banner 2）：进行中说明 + 不可中断（D1：无任何按钮）
    await second.win.getByRole("button", { name: "读取原生历史并恢复" }).click();
    await expect(banner).toContainText("正在读取原生历史并恢复上下文", { timeout: 10_000 });
    await expect(banner).toContainText("不可中断");
    await expect(banner.getByRole("button")).toHaveCount(0);
    await shot(second.win, "12-resume-banner-resuming.png");

    // 成功收敛：banner 消失、状态徽标回空闲；恢复会话可续聊
    await expect(banner).toHaveCount(0, { timeout: 15_000 });
    await expect(second.win.getByText("空闲").first()).toBeVisible({ timeout: 15_000 });
    await send(second.win, "中断后继续");
    await expect(second.win.getByText("基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。")).toBeVisible({ timeout: 30_000 });
    await second.app.close();
  } finally {
    for (const r of roots) await rmBestEffort(r);
  }
});

test("I-3 恢复条失败流转：失败原因 + 重试 + 复制错误详情（三态截图之失败态）→ 重试成功收敛", async () => {
  const { userData, repoDir, roots } = makeChatFixture("kb-s4-resume-fail");
  try {
    // 第一次运行：注册 + 会话跑一个完整 turn
    const first = await launchApp(userData, repoDir);
    await registerAndCreate(first.win, "kb-s4-resume-fail");
    await send(first.win, "拆类型");
    await expect(first.win.getByText("空闲").first()).toBeVisible({ timeout: 30_000 });
    await first.app.close();

    // 重启（同一 userData，注入首次 resume 失败）
    const second = await launchApp(userData, undefined, { KANBAN_FAKE_RESUME_FAIL_FIRST: "1" });
    await expect(second.win.getByText("已断开").first()).toBeVisible({ timeout: 15_000 });
    await second.win.getByText("新会话 · Claude").first().click();

    // 失败态（原型 d3 banner 3）：原因 + 错误码 + 重试 + 复制错误详情，会话保持断开
    const banner = second.win.getByTestId("resume-banner");
    await expect(banner).toBeVisible();
    await second.win.getByRole("button", { name: "读取原生历史并恢复" }).click();
    await expect(banner).toContainText("恢复失败", { timeout: 10_000 });
    await expect(banner).toContainText("E_INTERNAL");
    await expect(banner.getByRole("button", { name: "重试" })).toBeVisible();
    await expect(banner.getByRole("button", { name: "复制错误详情" })).toBeVisible();
    await expect(second.win.getByText("已断开").first()).toBeVisible();
    await shot(second.win, "13-resume-banner-failed.png");

    // 重试（同一恢复动作）→ 成功收敛：banner 消失 + 空闲
    await banner.getByRole("button", { name: "重试" }).click();
    await expect(banner).toHaveCount(0, { timeout: 15_000 });
    await expect(second.win.getByText("空闲").first()).toBeVisible({ timeout: 15_000 });
    await second.app.close();
  } finally {
    for (const r of roots) await rmBestEffort(r);
  }
});

test("I-4 残留通知条 + 进程表：警示条 + 五列表 + 默认勾选 + 确认式清理实测", async () => {
  const { userData, seedPath, roots } = makeResidueFixture();
  try {
    const { app, win } = await launchApp(userData, undefined, { KANBAN_TEST_RESIDUE_JSON: seedPath });
    const banner = win.getByTestId("residue-banner");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText("检测到 3 个疑似残留 CLI 进程");
    await expect(banner).toContainText("清理前请确认它们不是你自己打开的");

    // 进程表（原型 d4 pid-table：勾选/PID/进程/启动时间/关联记录）+ 默认勾选规则（仅精确匹配勾、无记录与疑似回落不勾）
    const row1 = win.getByTestId("residue-row-31432");
    await expect(row1).toContainText("31432");
    await expect(row1).toContainText("codex.exe");
    await expect(row1).toContainText("会话「实现 Diff 解析」");
    const row2 = win.getByTestId("residue-row-32004");
    await expect(row2).toContainText("无会话记录");
    const row3 = win.getByTestId("residue-row-32512");
    await expect(row3).toContainText("疑似上次会话「修复启动崩溃」");
    await expect(win.getByLabel("勾选 PID 31432")).toBeChecked();
    await expect(win.getByLabel("勾选 PID 32004")).not.toBeChecked();
    await expect(win.getByLabel("勾选 PID 32512")).not.toBeChecked();
    await shot(win, "14-residue-banner-table.png");

    // 清理实测：补勾无记录与疑似回落行 → 「清理选中」→ fake kill 全 killed → 表清空、条消失
    // （「忽略本次」交互由 residue.spec.ts 用例 1 覆盖，此处不重复）
    await win.getByLabel("勾选 PID 32004").check();
    await win.getByLabel("勾选 PID 32512").check();
    await win.getByRole("button", { name: "清理选中" }).click();
    await expect(banner).toBeHidden({ timeout: 15_000 });
    await expect(win.getByTestId("residue-row-31432")).toHaveCount(0);
    await expect(win.getByTestId("residue-row-32004")).toHaveCount(0);
    await expect(win.getByTestId("residue-row-32512")).toHaveCount(0);
    await app.close();
  } finally {
    for (const r of roots) await rmBestEffort(r);
  }
});
