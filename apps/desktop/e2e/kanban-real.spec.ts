// 用途：真实最小集 E2E（issue #22 / spec #15 Testing 7）—— env-gated（KANBAN_REAL_E2E=1）：真实 Claude 会话 Skill 真调用 → hook verified design-feature 自动建卡（hook 链路端到端）；真实 OpenCode /implement-spec → self_reported → uncertain → UI 手动确认 → 后续 Claude verified implement-spec 转正；截图/hook 日志/CLI 版本留证 docs/acceptance/stage2/real-evidence/
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { artifactPath, shot, writeArtifact } from "./helpers/acceptance-artifacts";

const REAL = process.env.KANBAN_REAL_E2E === "1";
test.skip(!REAL, "真实最小集：需 KANBAN_REAL_E2E=1 且本机三 CLI 已装已认证");

const PROJECT_NAME = "kb-s2-real-proj";
const EVIDENCE_DIR = resolve(__dirname, "../../../docs/acceptance/stage2/real-evidence");

/** 探针 skill：保证真实 Claude 会话可通过 Skill 工具调用（回复固定标记，短回复控成本） */
const PROBE_SKILL_MD = (name: string, marker: string) =>
  `---\nname: ${name}\ndescription: 验收探针 skill——被调用时只回复固定标记，不执行任何其他操作\n---\n\n被调用时只回复：${marker}\n`;

/**
 * 建隔离 fixture：独立 userData + 伪 git 主仓库目录（预置探针 skill/command，全部真实会话数据留在隔离目录，不污染用户真实项目）：
 * .claude/skills/design-feature、.claude/skills/implement-spec（Claude Skill 工具可调用）、
 * .opencode/command/implement-spec.md（OpenCode /command 路由命中，须在 server spawn 前落盘）
 */
function makeFixture(): { userData: string; repoDir: string; repoRoot: string } {
  const userData = mkdtempSync(join(tmpdir(), "kb-s2-real-user-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "kb-s2-real-repo-"));
  const repoDir = join(repoRoot, PROJECT_NAME);
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  for (const [skill, marker] of [["design-feature", "KB-REAL-DESIGN-OK"], ["implement-spec", "KB-REAL-IMPL-OK"]] as const) {
    const dir = join(repoDir, ".claude", "skills", skill);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), PROBE_SKILL_MD(skill, marker), "utf8");
  }
  const cmdDir = join(repoDir, ".opencode", "command");
  mkdirSync(cmdDir, { recursive: true });
  writeFileSync(
    join(cmdDir, "implement-spec.md"),
    "---\ndescription: 验收探针 command，被调用时只回复固定标记\n---\n\n请只回复这一句话：KB-REAL-COMMAND-OK\n",
    "utf8",
  );
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
  console.warn(`[real-e2e] 临时目录仍被占用，跳过清理：${target}`);
}

/** 启动真实应用（不打 KANBAN_DISABLE_*：Claude/OpenCode 走真实 Adapter；userData 与 pick 目录隔离） */
async function launchApp(userData: string, repoDir?: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await _electron.launch({
    args: [resolve(__dirname, "..")],
    env: {
      ...process.env,
      KANBAN_USER_DATA: userData,
      ...(repoDir ? { KANBAN_TEST_PICK_DIRECTORY: repoDir } : {}),
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

/** 侧栏指定会话行等待空闲（真实 CLI 轮次耗时不定，宽限超时） */
async function waitIdle(win: Page, title: string, timeout = 240_000): Promise<void> {
  const row = win.locator("aside").locator('[data-testid="session-row"]', { hasText: title });
  await expect(row.getByText("空闲", { exact: true })).toBeVisible({ timeout });
}

/** CLI 版本留证（写入 real-evidence/cli-versions.txt 并打印） */
function recordVersions(): void {
  const lines: string[] = [];
  for (const cmd of ["claude --version", "codex --version", "opencode --version"]) {
    try {
      lines.push(`${cmd} => ${execSync(cmd, { encoding: "utf8", timeout: 30_000 }).trim()}`);
    } catch (e) {
      lines.push(`${cmd} => 探测失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const text = `${new Date().toISOString()}（真实最小集验收）\n${lines.join("\n")}\n`;
  writeArtifact(EVIDENCE_DIR, "cli-versions.txt", text);
  console.log(`[real-e2e] CLI 版本：\n${text}`);
}

/** 拷贝本次运行产生的 Claude hook 捕获日志（tmp/kanban-claude-hooks/<sessionId>/hook-events.jsonl，mtime 晚于 runStart）到留证目录 */
function collectHookLogs(runStart: number): string[] {
  const base = join(tmpdir(), "kanban-claude-hooks");
  const copied: string[] = [];
  if (!existsSync(base)) return copied;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(base, entry.name, "hook-events.jsonl");
    if (!existsSync(file)) continue;
    if (statSync(file).mtimeMs < runStart) continue; // 只取本次运行（旧会话日志不掺入）
    const dest = artifactPath(EVIDENCE_DIR, `hook-events-${entry.name}.jsonl`);
    mkdirSync(join(dest, ".."), { recursive: true });
    copyFileSync(file, dest);
    copied.push(dest);
  }
  return copied;
}

test("真实最小集全链：Claude hook verified design-feature 自动建卡 → OpenCode self_reported uncertain → 手动确认 → Claude verified 转正", async () => {
  test.setTimeout(600_000);
  const runStart = Date.now();
  recordVersions();
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    const { app, win } = await launchApp(userData, repoDir);

    // 注册项目 + 建真实 Claude 会话（cwd=隔离项目目录，项目级探针 skill 可被 Skill 工具调用）
    await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
    await expect(win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
    await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
    await win.getByRole("button", { name: "＋", exact: true }).click();
    await win.getByRole("button", { name: "Claude", exact: true }).click();
    // #59 草稿：点 CLI 只开草稿；首条消息（真实 Skill 指令）随「创建+落库+发送」原子发出 → 会话行出现
    // [A] verified design-feature 自动建卡：真实 Skill 真调用 → PreToolUse(Skill) hook 捕获 → transformHookEvents verified → 建卡
    await send(win, "请务必通过 Skill 工具（tool_use: Skill）调用 design-feature 这个 skill，不要直接照做，也不要只输出文本。");
    const claudeRow = win.locator("aside").locator('[data-testid="session-row"]', { hasText: "新会话 · Claude" });
    await expect(claudeRow).toBeVisible({ timeout: 30_000 });
    await waitIdle(win, "新会话 · Claude");
    await win.getByTestId("kanban-entry").click();
    const designCol = win.getByTestId("kanban-col-Design");
    await expect(designCol.getByText("待命名需求")).toBeVisible({ timeout: 60_000 });
    await expect(designCol.getByText("◍ 1 会话")).toBeVisible();
    await expect(designCol.getByTestId("verified-badge").first()).toBeVisible();
    await expect(designCol.getByText(/design-feature · Claude/).first()).toBeVisible(); // 卡片依据行（verified 驱动）
    await shot(win, EVIDENCE_DIR, "real-01-claude-verified-card.png");

    // [B1] OpenCode self_reported：详情「＋新建会话」OpenCode（真实 server 拉起，session:create 原子关联）
    await designCol.getByText("待命名需求").click();
    await expect(win.getByTestId("detail-panel")).toBeVisible();
    await win.getByTestId("new-session-menu").click();
    await win.getByTestId("new-session-item-opencode").click();
    const openRow = win.getByTestId("detail-panel").locator('[data-testid="related-session"]', { hasText: "新会话 · OpenCode" });
    await expect(openRow).toBeVisible({ timeout: 60_000 });
    await expect(designCol.getByText("◍ 2 会话")).toBeVisible({ timeout: 15_000 });

    // [B2] /implement-spec（OpenCode /command 路由命中探针 command）→ self_reported → Implement + 待确认
    await win.getByTestId("kanban-entry").click();
    const openSideRow = win.locator("aside").locator('[data-testid="session-row"]', { hasText: "新会话 · OpenCode" });
    await openSideRow.click();
    await send(win, "/implement-spec");
    await waitIdle(win, "新会话 · OpenCode");
    await win.getByTestId("kanban-entry").click();
    const implCol = win.getByTestId("kanban-col-Implement");
    await expect(implCol.getByText("待命名需求")).toBeVisible({ timeout: 60_000 });
    await expect(implCol.getByTestId("uncertain-badge").first()).toBeVisible();
    await shot(win, EVIDENCE_DIR, "real-02-self-reported-uncertain.png");

    // [B3] UI 手动确认：详情「确认当前阶段」→ 待确认徽标清除、阶段保持 Implement（面板自 B1 起保持打开）
    await expect(win.getByTestId("detail-panel")).toBeVisible();
    await expect(win.getByTestId("uncertain-note")).toContainText("implement-spec");
    await win.getByTestId("confirm-stage-button").click();
    await expect(implCol.getByTestId("uncertain-badge")).toHaveCount(0, { timeout: 15_000 });
    await expect(implCol.getByText("待命名需求")).toBeVisible();
    await shot(win, EVIDENCE_DIR, "real-03-manual-confirmed.png");

    // [B4] 后续 Claude verified 转正：真实 Skill 调用 implement-spec → hook verified（更新发生）→ 依据转 verified、uncertain 保持 false
    await win.getByTestId("kanban-entry").click();
    await claudeRow.click();
    await send(win, "请务必通过 Skill 工具（tool_use: Skill）调用 implement-spec 这个 skill，不要直接照做，也不要只输出文本。");
    await waitIdle(win, "新会话 · Claude");
    await win.getByTestId("kanban-entry").click();
    await expect(implCol.getByText("待命名需求")).toBeVisible({ timeout: 60_000 });
    await expect(implCol.getByTestId("uncertain-badge")).toHaveCount(0); // 转正后无待确认
    await expect(implCol.getByTestId("verified-badge").first()).toBeVisible(); // verified 绿徽标回归
    await expect(implCol.getByText(/implement-spec · Claude/).first()).toBeVisible();
    await expect(win.getByTestId("detail-panel")).toBeVisible();
    await expect(win.getByText(/implement-spec · Claude · verified ·/)).toBeVisible(); // 详情当前依据：证据等级 verified
    await shot(win, EVIDENCE_DIR, "real-04-verified-promoted.png");

    // hook 捕获日志留证（verified 信号的真实来源：PreToolUse(Skill) JSONL）
    const logs = collectHookLogs(runStart);
    console.log(`[real-e2e] hook 日志留证：${logs.length ? logs.join("、") : "（未找到本次运行的 hook-events.jsonl）"}`);

    await app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});
