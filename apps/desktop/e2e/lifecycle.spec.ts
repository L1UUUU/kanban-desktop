// 用途：生命周期与退出治理 E2E（#13 验收 1/2/3/5）—— 切页/并行不停止（流式中回切增量无缝）、正常退出无孤儿进程（OS 句柄级断言）、重启恢复（断开会话读取原生历史并恢复→续聊）、主仓库并行冲突提示条出现/消失
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_NAME = "kb-lifecycle";
const ORPHAN_MARKER = "kb-lifecycle-orphan-7f3a";

/** 建隔离 fixture：独立 userData + 伪 git 主仓库目录 */
function makeFixture(): { userData: string; repoDir: string; repoRoot: string } {
  const userData = mkdtempSync(join(tmpdir(), "kb-life-user-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "kb-life-repo-"));
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
    args: [join(__dirname, "..")],
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

/** 注册项目 + 建首个 Claude（Fake）会话（#94：会话行标题=首条消息派生） */
async function registerAndCreate(win: Page): Promise<void> {
  await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
  await expect(win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
  await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
  await win.getByRole("button", { name: "＋", exact: true }).click();
  await win.getByRole("button", { name: "Claude", exact: true }).click();
  // #59 草稿：点 CLI 只开草稿，发出首条消息才创建会话（侧栏行出现）
  await expect(win.getByTestId("draft-hint")).toBeVisible({ timeout: 10_000 });
  await send(win, "首条消息（建立会话）");
  await expect(win.locator("aside").getByText("首条消息（建立会话）")).toBeVisible({ timeout: 10_000 }); // #94：标题=首条派生
}

/** 在 composer 输入并发送 */
async function send(win: Page, text: string): Promise<void> {
  await win.getByPlaceholder("输入消息，/ 开头触发 Skill…").fill(text);
  await win.getByRole("button", { name: "发送 ➤" }).click();
}

/** OS 句柄级进程计数：命令行含 marker 的存活进程数（CIM/Win32_Process；排除查询进程自身——其命令行同样含 marker） */
function countMarkerProcesses(): number {
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${ORPHAN_MARKER}*' -and $_.ProcessId -ne $PID }).Count`],
    { encoding: "utf8" },
  ).trim();
  const n = Number(out);
  return Number.isFinite(n) ? n : -1;
}

test("切页不停止（§6.1）：A 流式中切 B 再切回，增量无缝、两会话都完成（无重复无丢失）", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    const { app, win } = await launchApp(userData, repoDir);
    await registerAndCreate(win);

    // 会话 A 发送后立即进入流式 → 切到 B（再建）→ 切回 A
    await send(win, "拆类型");
    await expect(win.getByText("运行中").first()).toBeVisible({ timeout: 10_000 });
    await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
    await win.getByRole("button", { name: "＋", exact: true }).click();
    await win.getByRole("button", { name: "Claude", exact: true }).click();
    // #59 草稿：第二会话以「第二轮：再确认一遍导出面」为首条（随创建原子发出，行出现）
    await expect(win.getByTestId("draft-hint")).toBeVisible({ timeout: 10_000 });
    await send(win, "第二轮：再确认一遍导出面");
    await expect(win.locator("aside").getByText("第二轮：再确认一遍导出面")).toBeVisible({ timeout: 10_000 }); // B 行标题=其首条派生（#94）
    // 切回 A（流式中）：B 继续在后台跑（切页不停止）
    // .first()：A 两轮同文案（脚本固定），第二轮流式追平瞬间 DOM 有两份（完成版+▍流式版），取首份断言可见性（0 份=消息丢失仍失败）
    await win.locator("aside").getByText("首条消息（建立会话）").click(); // 切回 A（行标题=首条派生，#94）
    await expect(win.getByText("好的，我先跑一遍现有测试确认基线，然后开始拆分。").first()).toBeVisible({ timeout: 20_000 });
    await expect(win.getByText("基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。").first()).toBeVisible({ timeout: 20_000 });
    // A 完整收尾后切到 B：B 也在后台完成了（不因切走而停止/丢失）
    await win.locator("aside").getByText("第二轮：再确认一遍导出面").click(); // 切到 B
    await expect(win.getByText("基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。")).toBeVisible({ timeout: 20_000 });
    // 回切增量无缝：A 的首段回复恰出现两次——A 跑过两轮（#59 草稿首条消息 + 拆类型各一轮，同文案各一份）；
    // 若流式重复 delta 会多出第三份（回归断言语义：每轮恰一份）
    await win.locator("aside").getByText("首条消息（建立会话）").click(); // 回切 A
    await expect(win.getByText("好的，我先跑一遍现有测试确认基线，然后开始拆分。")).toHaveCount(2);
    await expect(win.getByText("空闲").first()).toBeVisible({ timeout: 20_000 });

    await app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("正常退出无孤儿（§6.1）：PTY 子进程随退出终止（OS 句柄级），应用退出不挂起", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    const { app, win } = await launchApp(userData, repoDir);
    await registerAndCreate(win);

    // 经 preload 桥直连 IPC：起一个带 marker 的长驻 PowerShell（退出治理的被观察对象）
    const created = await win.evaluate(
      async ({ cwd, marker }) => {
        const api = (window as { api?: { invoke(req: unknown): Promise<{ ok: boolean }> } }).api;
        if (!api) throw new Error("window.api 不可用");
        return api.invoke({
          channel: "terminal:create",
          // #60：terminalId 由调用方预生成（uuid 同格式；草稿语义下由渲染端生成，此处直连等价）
          terminalId: crypto.randomUUID(),
          cwd,
          command: { exe: "powershell.exe", args: ["-NoProfile", "-Command", `Write-Output ${marker}; Start-Sleep -Seconds 120`] },
        });
      },
      { cwd: repoDir, marker: ORPHAN_MARKER },
    );
    expect(created.ok).toBe(true);
    // marker 进程确在运行（CIM 句柄级可见）
    await expect
      .poll(() => countMarkerProcesses(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);

    // 正常退出（app.close → window-all-closed → 统一退出序列 → PTY killAll + CliHost dispose）
    await app.close();
    // 退出后无孤儿：marker 进程全部消失（Job Object + killAll 双保险的实测面）
    await expect
      .poll(() => countMarkerProcesses(), { timeout: 15_000 })
      .toBe(0);
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("重开恢复（§6.1）：项目/会话恢复 + 断开会话「读取原生历史并恢复」→ 空闲可续聊", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    // 第一次运行：注册 + 会话跑一个完整 turn
    const first = await launchApp(userData, repoDir);
    await registerAndCreate(first.win);
    await send(first.win, "拆类型");
    await expect(first.win.getByText("基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。")).toBeVisible({ timeout: 30_000 });
    await expect(first.win.getByText("空闲").first()).toBeVisible({ timeout: 20_000 });
    await first.app.close();

    // 重启（同一 userData）：项目与会话恢复（断开态），Main 侧已对结构化会话统一收养
    const second = await launchApp(userData);
    await expect(second.win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(second.win.locator("aside").getByText("首条消息（建立会话）")).toBeVisible({ timeout: 15_000 }); // 重启行标题=DB 派生值（#94）
    await expect(second.win.getByText("已断开").first()).toBeVisible();
    // 点会话 → 顶部恢复引导条（#42：会话名 + 缓存不替代原生历史 + 恢复入口；底部弱入口已移除）
    await second.win.locator("aside").getByText("首条消息（建立会话）").click();
    const resumeBanner = second.win.getByTestId("resume-banner");
    await expect(resumeBanner).toBeVisible();
    await expect(resumeBanner).toContainText("首条消息（建立会话）");
    await expect(resumeBanner).toContainText("缓存消息不替代原生历史");
    // 恢复：readHistory → resume → 空闲 → banner 收敛消失
    await second.win.getByRole("button", { name: "读取原生历史并恢复" }).click();
    await expect(second.win.getByText("空闲").first()).toBeVisible({ timeout: 15_000 });
    await expect(resumeBanner).toHaveCount(0);
    // 可续聊：恢复会话发新消息正常完成
    await send(second.win, "中断后继续");
    await expect(second.win.getByText("基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。")).toBeVisible({ timeout: 30_000 });
    await second.app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("冲突提示条（spec I-4）：主仓库两会话并行运行出现（列会话名/计数），完成后消失，不阻止输入", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    const { app, win } = await launchApp(userData, repoDir);
    await registerAndCreate(win);

    // 第二个会话（同项目同主仓库目录；#59 草稿：首条消息随创建发出，行出现）
    await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
    await win.getByRole("button", { name: "＋", exact: true }).click();
    await win.getByRole("button", { name: "Claude", exact: true }).click();
    await expect(win.getByTestId("draft-hint")).toBeVisible({ timeout: 10_000 });
    await send(win, "首条消息（建立会话）");
    await expect(win.locator("aside").getByText("首条消息（建立会话）").nth(1)).toBeVisible({ timeout: 10_000 }); // 两行同首条派生（#94）
    // #59 迁移补拍：两会话的首条 turn 几乎同时收尾（A 等发送键恢复期间 B 已空闲），无法构成并行——
    // 等 B 空闲后向 B（当前激活）再发一轮「拆类型」，随后立即切 A 发送，两会话并行窗口由 Fake turn ~4s 保证
    await expect(win.locator("aside [data-testid=\"session-row\"]").nth(1)).toContainText("空闲", { timeout: 15_000 });
    await send(win, "拆类型");
    await win.locator("aside").getByText("首条消息（建立会话）").nth(0).click(); // 切 A（同首条两行取首行）
    await send(win, "拆类型");
    const banner = win.getByTestId("conflict-banner");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText("主仓库并行会话（2 个）");
    await expect(banner).toContainText("首条消息（建立会话）、首条消息（建立会话）"); // 同首条派生同文（#94）
    // 仅提示不阻止：composer 仍可输入
    await expect(win.getByPlaceholder("输入消息，/ 开头触发 Skill…")).toBeEnabled();

    // 两会话完成（空闲）→ 提示条消失（会话数变化动态更新）
    await expect(banner).toBeHidden({ timeout: 30_000 });

    await app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});
