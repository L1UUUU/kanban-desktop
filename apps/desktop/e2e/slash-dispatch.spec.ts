// 用途：斜杠派发闭环整机 E2E（issue #92 / spec #82 E 块；ADR 0004 零内置）—— 真 preload/IPC/Main/FakeAdapter 全链：codex 匹配客户端展开（展开文本为用户气泡与 wire 载荷）、未匹配原样发送（/foo 与 claude 会话未匹配透传）、命令文件缺失 fail-closed 错误卡（不静默）
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FAKE_SUMMARY_TITLE } from "./helpers/fake-summary";

const PROJECT_NAME = "kb-slash-dispatch";
/** codex prompt fixture 正文（占位符 $ARGUMENTS/$1 随发送期展开替换） */
const PROBE_BODY = "目标：$ARGUMENTS，首参=$1，标记 KB-CODEX-PROMPT-EXECUTED";
const PROBE_EXPANDED = "目标：alpha beta，首参=alpha，标记 KB-CODEX-PROMPT-EXECUTED";

/** 建隔离 fixture：独立 userData + 伪 git 主仓库 + 项目级 codex prompts（kb-e2e-probe 展开用 / kb-e2e-gone 文件缺失用） */
function makeFixture(): { userData: string; repoDir: string; goneFile: string } {
  const userData = mkdtempSync(join(tmpdir(), "kb-slash-disp-user-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "kb-slash-disp-repo-"));
  const repoDir = join(repoRoot, PROJECT_NAME);
  const prompts = join(repoDir, ".codex", "prompts");
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  mkdirSync(prompts, { recursive: true });
  writeFileSync(join(prompts, "kb-e2e-probe.md"), `---\ndescription: 展开探针\nargument-hint: [说明]\n---\n${PROBE_BODY}`, "utf8");
  const goneFile = join(prompts, "kb-e2e-gone.md");
  writeFileSync(goneFile, "---\ndescription: 将被删除\n---\n正文", "utf8");
  return { userData, repoDir, goneFile };
}

async function launchApp(): Promise<{ app: ElectronApplication; win: Page; goneFile: string; cleanup(): Promise<void> }> {
  const { userData, repoDir, goneFile } = makeFixture();
  const app = await _electron.launch({
    args: [resolve(__dirname, "..")],
    // 三真实 CLI 全回落 Fake：codex 目录模拟（扫描项目 .codex/prompts）驱动展开链路；claude 用固定集驱动透传
    env: {
      ...process.env,
      KANBAN_USER_DATA: userData,
      KANBAN_TEST_PICK_DIRECTORY: repoDir,
      KANBAN_DISABLE_CLAUDE: "1",
      KANBAN_DISABLE_OPENCODE: "1",
      KANBAN_DISABLE_CODEX: "1",
    },
  });
  const win = await app.firstWindow();
  // 注册项目（斜杠命令目录与 PTY 草稿的 cwd 都挂项目）
  await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
  await expect(win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
  return {
    app,
    win,
    goneFile,
    cleanup: async () => {
      for (let i = 0; i < 20; i += 1) {
        try {
          rmSync(userData, { recursive: true, force: true });
          rmSync(join(repoDir, ".."), { recursive: true, force: true });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      console.warn(`[e2e] 临时目录仍被占用，跳过清理：${userData}`);
    },
  };
}

/** 在 composer 输入并发送（模型目录就绪前发送钮禁用，等待可用） */
async function send(win: Page, text: string): Promise<void> {
  const box = win.getByPlaceholder("输入消息，/ 开头触发 Skill…");
  await box.fill(text);
  const btn = win.getByRole("button", { name: "发送 ➤" });
  await expect(btn).toBeEnabled({ timeout: 10_000 });
  await btn.click();
}

/** 经项目行「＋」菜单打开指定 CLI 草稿（点 CLI 只开草稿；#59 语义） */
async function openDraft(win: Page, cliLabel: string): Promise<void> {
  await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
  await win.getByRole("button", { name: "＋", exact: true }).click();
  await win.getByRole("button", { name: cliLabel, exact: true }).click();
  await expect(win.getByTestId("draft-hint")).toBeVisible({ timeout: 10_000 });
}

test("codex 匹配展开 → 未匹配原样（codex /foo 与 claude 会话）→ 文件缺失 fail-closed 错误卡", async () => {
  const t = await launchApp();
  const { app, win, goneFile } = t;

  // —— codex 草稿：菜单选中命令 → 补实参 → 发送 = 客户端展开（气泡与 wire 均为展开文本）
  await openDraft(win, "Codex");
  const box = win.getByPlaceholder("输入消息，/ 开头触发 Skill…");
  await box.click();
  await box.pressSequentially("/kb-e2e-p");
  const menu = win.getByTestId("slash-menu");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect(menu.getByTestId("slash-menu-item").filter({ hasText: "/kb-e2e-probe" })).toBeVisible();
  await box.press("Enter"); // 接受置入（/kb-e2e-probe + 尾随空格进实参位）
  await expect(box).toHaveValue("/kb-e2e-probe ");
  await box.pressSequentially("alpha beta");
  await send(win, "/kb-e2e-probe alpha beta");
  // 会话创建 + 用户气泡 = 展开文本（frontmatter 已剥离、占位符已替换、无 $ 残留）
  await expect(win.locator("aside").getByText("目标：alpha beta，首参=alpha，标…")).toBeVisible({ timeout: 15_000 }); // #94：标题=展开文本派生截断
  await expect(win.getByText(PROBE_EXPANDED)).toBeVisible();
  await expect(win.getByText("$ARGUMENTS")).toHaveCount(0);
  await expect(win.getByText("description: 展开探针")).toHaveCount(0); // frontmatter 不入消息
  await expect(win.getByText("好的，我先跑一遍现有测试确认基线，然后开始拆分。")).toBeVisible({ timeout: 20_000 }); // turn 正常推进（adapter 收到展开文本）

  // —— 未匹配 /foo：原样发送（气泡=原文）
  await send(win, "/nope 任意参数");
  await expect(win.getByText("/nope 任意参数")).toBeVisible();
  await expect(win.getByText("基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件")).toBeVisible({ timeout: 20_000 });

  // —— 文件缺失 fail-closed：目录已列出 kb-e2e-gone（菜单缓存）但文件已删 → 展开失败走错误卡，输入保留
  await openDraft(win, "Codex");
  const box2 = win.getByPlaceholder("输入消息，/ 开头触发 Skill…");
  await box2.click();
  await box2.pressSequentially("/kb-e2e-g");
  const menu2 = win.getByTestId("slash-menu");
  await expect(menu2).toBeVisible({ timeout: 10_000 });
  await expect(menu2.getByTestId("slash-menu-item").filter({ hasText: "/kb-e2e-gone" })).toBeVisible();
  await box2.press("Escape"); // 关菜单（不改变已缓存的命令目录条目）
  unlinkSync(goneFile); // 发送前删除来源文件（renderer 命令源 10s TTL 内仍持 sourcePath）
  await send(win, "/kb-e2e-gone 参数");
  await expect(win.getByTestId("create-error-card")).toBeVisible({ timeout: 10_000 }); // 失败卡（不静默）
  await expect(win.getByTestId("create-error-card")).toContainText("不可读");
  await expect(box2).toHaveValue("/kb-e2e-gone 参数"); // 输入保留可重试
  await expect(win.locator("aside").getByText(FAKE_SUMMARY_TITLE)).toBeVisible(); // 首个会话仍在（#95：首轮后标题=摘要固定值）、第二个未创建（草稿保留，无原子提交）

  // —— claude 会话未匹配透传：fake 目录空集（ADR 0004）→ /fake-plan 未匹配原样发送（气泡=原文，降级判据）
  await openDraft(win, "Claude");
  await send(win, "/fake-plan 透传参数");
  await expect(win.locator("aside").getByText("/fake-plan 透传参数")).toBeVisible({ timeout: 15_000 }); // #94：标题=首条原文派生
  await expect(win.getByText("/fake-plan 透传参数").first()).toBeVisible(); // 未匹配：气泡=原文（未展开、未改写）

  await app.close();
  await t.cleanup();
});
