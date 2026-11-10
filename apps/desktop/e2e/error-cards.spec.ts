// 用途：错误提示五类卡整机 E2E（#46 验收 5 / spec I 一致项 2）—— Fake 驱动（KANBAN_DISABLE_* 三件套）：
// 四类 + 未知兜底卡呈现与动作流转（重试重发 / 打开 PTY 终端 / 恢复会话 / 知道了）+ spawn 创建失败侧栏卡（KANBAN_FAKE_CREATE_FAIL_FIRST 注入，重试创建成功收敛）
// + #56（spec #52 验收 2 C 类）：spawn 失败日志留痕断言（E_SPAWN_NOT_FOUND + kind/cli 关联标识）
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_NAME = "kb-errcard";

/** 日志条目读取形状（#56：logger.ts 落盘 JSONL 格式） */
interface LogEntry {
  level: "error" | "warn" | "info" | "debug";
  source: "main" | "worker" | "renderer";
  scope: string;
  message: string;
  ctx?: Record<string, string | number | boolean | null>;
}

/** 读指定启动组（<pid> 前缀，含 .1/.2 分片按序合并）全部日志条目（#56 N17/M9：同 userData 多次 launch 只读本组，禁跨启动拼接） */
function readRunEntries(userData: string, pid: number): LogEntry[] {
  const dir = join(userData, "logs");
  if (!existsSync(dir)) return [];
  const prefix = readdirSync(dir)
    .map((n) => /^(\d{8}-\d{6}-\d+)\.jsonl/.exec(n)?.[1])
    .find((p) => p?.endsWith(`-${pid}`));
  if (!prefix) return [];
  const names = readdirSync(dir).filter((n) => n === `${prefix}.jsonl` || n === `${prefix}.jsonl.1` || n === `${prefix}.jsonl.2`);
  const entries: LogEntry[] = [];
  for (const name of names) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (line.trim()) entries.push(JSON.parse(line) as LogEntry);
    }
  }
  return entries;
}

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

/** 注册项目 + 建首个 Claude（Fake）会话 */
async function registerAndCreate(win: Page): Promise<void> {
  await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
  await expect(win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
  await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
  await win.getByRole("button", { name: "＋", exact: true }).click();
  await win.getByRole("button", { name: "Claude", exact: true }).click();
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

    // 第二次运行注入：Fake 前一次 createSession 抛 E_SPAWN_NOT_FOUND（协议级同码）→ 侧栏创建入口错误卡
    const second = await launchApp(userData, undefined, { KANBAN_FAKE_CREATE_FAIL_FIRST: "1" });
    const win = second.win;
    await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
    await win.getByRole("button", { name: "＋", exact: true }).click();
    await win.getByRole("button", { name: "Claude", exact: true }).click();

    // 无会话视图可挂：卡在侧栏创建入口（info 槽）呈现，对齐原型 d2 卡 3 信息结构
    const card = win.getByTestId("create-error-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("找不到 CLI 程序（Claude）");
    await expect(card).toContainText("FakeAdapter 注入"); // AdapterError 消息原文保留（不吞错）
    await expect(card).toContainText("config.json"); // 配置路径指引（AppInfo.configPath）
    await expect(card.getByRole("button", { name: "重试创建" })).toBeVisible();
    await expect(card.getByRole("button", { name: "复制配置路径" })).toBeVisible();

    // 「重试创建」：以原参数重发 session:create → 成功后卡消失 + 会话登记（console.error 旧形态不复存在）
    await card.getByRole("button", { name: "重试创建" }).click();
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
    const rendererFailed = entries.find((e) => e.source === "renderer" && e.message === "会话创建失败");
    expect(rendererFailed).toBeTruthy();
    expect(rendererFailed?.ctx?.code).toBe("E_SPAWN_NOT_FOUND");
    expect(rendererFailed?.ctx?.cli).toBe("claude");
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});
