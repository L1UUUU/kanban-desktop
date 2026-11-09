// 用途：Diff 视图整机 E2E（#43，spec #40 G 节验收）—— 预置真实 git 仓库（init+commit+改/删/改名/二进制/untracked）经 KANBAN_TEST_PICK_DIRECTORY 注册项目驱动全流程：进入自动读取、头部统计、文件行徽标与标注、展开/折叠行级红绿 diff、手动刷新、返回聊天；非 git 项目居中空态；worktree 目录 diff 语义正常（spec E 节）
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** 在 dir 内执行一条 git 命令（禁 autocrlf 保证 LF 行尾稳定断言） */
function git(dir: string, ...args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
}

/** 预置 git 仓库：基线三文件 commit 后做 M/D/R/binary/U 五类未提交变更（统计 +3 -2：tracked +2/-2 + untracked 全文 1 行计入，#47） */
function makeRepoWithChanges(): { repoDir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "kb-diff-repo-"));
  const repoDir = join(root, "demo-repo");
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
  // 未提交变更：修改 a.txt（+2/-1）/ 删除 del.txt（-1）/ git mv 改名 keep.txt / 二进制覆盖 / untracked 新文件
  writeFileSync(join(repoDir, "a.txt"), "line1\nline2-changed\nline3\nline4\n", "utf8");
  rmSync(join(repoDir, "del.txt"));
  git(repoDir, "mv", "keep.txt", "kept.txt");
  writeFileSync(join(repoDir, "logo.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x1a, 0x0a, 9, 9, 9]));
  mkdirSync(join(repoDir, "notes"), { recursive: true });
  writeFileSync(join(repoDir, "notes", "new.md"), "untracked\n", "utf8");
  return { repoDir, root };
}

/** 启动应用（Fake 演示链路 + userData 隔离 + 固定注册目录） */
async function launchApp(userData: string, projectDir?: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await _electron.launch({
    args: [join(__dirname, "..")],
    env: {
      ...process.env,
      KANBAN_USER_DATA: userData,
      KANBAN_DISABLE_CLAUDE: "1",
      KANBAN_DISABLE_OPENCODE: "1",
      ...(projectDir ? { KANBAN_TEST_PICK_DIRECTORY: projectDir } : {}),
    },
  });
  const win = await app.firstWindow();
  return { app, win };
}

test.describe.configure({ mode: "serial" });

test("git 仓库全流程：进入读取/统计/徽标/展开折叠/刷新/返回", async () => {
  const { repoDir, root } = makeRepoWithChanges();
  const userData = mkdtempSync(join(tmpdir(), "kb-diff-user-"));
  const { app, win } = await launchApp(userData, repoDir);
  try {
    // 注册项目（KANBAN_TEST_PICK_DIRECTORY 固定目录）
    await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
    await expect(win.locator("aside").getByText("demo-repo", { exact: true })).toBeVisible({ timeout: 15_000 });

    // 进入 Diff 视图（第四态）：自动读取一次，头部统计 + HEAD 对比口径
    const entry = win.getByTestId("diff-entry");
    await expect(entry).toBeEnabled();
    await entry.click();
    await expect(win.getByTestId("diff-stat")).toHaveText("5 个文件 · +3 -2 · 未提交（HEAD 对比）", { timeout: 15_000 });

    // 文件行：五类行（M/R/D/U/binary）与标注
    const row = (path: string) => win.locator('[data-testid="diff-file-head"]', { hasText: path });
    await expect(row("a.txt").getByTestId("diff-badge-M")).toBeVisible();
    await expect(row("kept.txt").getByTestId("diff-badge-R")).toBeVisible();
    await expect(row("del.txt").getByTestId("diff-badge-D")).toBeVisible();
    await expect(row("notes/new.md").getByTestId("diff-badge-U")).toBeVisible();
    await expect(row("notes/new.md")).toContainText("新文件（未跟踪）");
    await expect(row("logo.bin")).toContainText("二进制文件");

    // 展开：hunk 头 + 新增绿行 / 删除红行；再点收起
    await row("a.txt").click();
    await expect(win.getByTestId("diff-line-hunk").first()).toContainText("@@");
    await expect(win.getByTestId("diff-line-add").first()).toHaveText("+line2-changed");
    await expect(win.getByTestId("diff-line-del").first()).toHaveText("-line2");
    await row("a.txt").click();
    await expect(win.getByTestId("diff-line-add")).toHaveCount(0);

    // 手动刷新：结果保持
    await win.getByTestId("diff-refresh").click();
    await expect(win.getByTestId("diff-stat")).toHaveText("5 个文件 · +3 -2 · 未提交（HEAD 对比）");

    // 再次点击入口返回聊天视图
    await entry.click();
    await expect(win.getByTestId("diff-stat")).toHaveCount(0);
  } finally {
    await app.close();
    await rmBestEffort(userData);
    await rmBestEffort(root);
  }
});

test("非 git 项目 → 居中空态（不弹窗报错）", async () => {
  const root = mkdtempSync(join(tmpdir(), "kb-diff-plain-"));
  const projectDir = join(root, "plain-dir");
  mkdirSync(projectDir, { recursive: true });
  const userData = mkdtempSync(join(tmpdir(), "kb-diff-user-"));
  const { app, win } = await launchApp(userData, projectDir);
  try {
    await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
    await expect(win.locator("aside").getByText("plain-dir", { exact: true })).toBeVisible({ timeout: 15_000 });
    await win.getByTestId("diff-entry").click();
    await expect(win.getByTestId("diff-empty")).toContainText("当前项目不是 git 仓库", { timeout: 15_000 });
    await expect(win.getByTestId("diff-file-head")).toHaveCount(0);
  } finally {
    await app.close();
    await rmBestEffort(userData);
    await rmBestEffort(root);
  }
});

test("worktree 目录 diff 语义正常（HEAD 对比口径不变，spec E 节）", async () => {
  const root = mkdtempSync(join(tmpdir(), "kb-diff-wt-"));
  const repoDir = join(root, "main-repo");
  const worktreeDir = join(root, "wt-demo");
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init");
  git(repoDir, "config", "core.autocrlf", "false");
  git(repoDir, "config", "user.email", "e2e@kanban");
  git(repoDir, "config", "user.name", "e2e");
  writeFileSync(join(repoDir, "a.txt"), "one\ntwo\n", "utf8");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-m", "base");
  git(repoDir, "worktree", "add", "../wt-demo", "-b", "wt-branch");
  writeFileSync(join(worktreeDir, "a.txt"), "one\ntwo-edited\n", "utf8");

  const userData = mkdtempSync(join(tmpdir(), "kb-diff-user-"));
  const { app, win } = await launchApp(userData, worktreeDir);
  try {
    await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
    await expect(win.locator("aside").getByText("wt-demo", { exact: true })).toBeVisible({ timeout: 15_000 });
    await win.getByTestId("diff-entry").click();
    await expect(win.getByTestId("diff-stat")).toHaveText("1 个文件 · +1 -1 · 未提交（HEAD 对比）", { timeout: 15_000 });
    await win.locator('[data-testid="diff-file-head"]', { hasText: "a.txt" }).click();
    await expect(win.getByTestId("diff-line-add").first()).toHaveText("+two-edited");
  } finally {
    await app.close();
    await rmBestEffort(userData);
    await rmBestEffort(root);
  }
});
