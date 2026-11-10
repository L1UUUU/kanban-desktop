// 用途：残留通知条整机 E2E（#49 spec #40 US19–22 / I-4）—— 预置 fake 检测结果（KANBAN_TEST_RESIDUE_JSON 种子 JSON，参照 memory-seed.ts 预置思路）驱动：通知条与进程表呈现（原型 d4 必须一致项）、「无会话记录」默认不勾选、勾选清理流程（fake kill 全 killed → 表清空条消失）、忽略本次；无种子（KANBAN_USER_DATA 隔离跳过机器级枚举）时不出现任何残留 UI（无残留不打扰）
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** fake 残留清单（与 jsdom 密封测试样本同形；pid 取独立值避免与真实进程混淆；第三条为「疑似」回落行——不精确匹配、默认不勾选） */
const SEED_PROCESSES = [
  { pid: 28432, exePath: "C:\\fake-npm\\@openai\\codex\\codex.exe", startedAt: "2026-11-09T01:12:00.000Z", sessionTitle: "实现 Diff 解析" },
  { pid: 29004, exePath: "C:\\fake-npm\\opencode-ai\\bin\\opencode.exe", startedAt: null, sessionTitle: null },
  { pid: 29512, exePath: "C:\\fake-npm\\@openai\\codex\\codex.exe", startedAt: null, sessionTitle: null, suspectedSessionTitle: "修复启动崩溃" },
];

/** 建隔离 fixture：独立 userData + 残留种子 JSON 文件（缺省无种子） */
function makeFixture(withSeed: boolean): { userData: string; seedPath?: string; roots: string[] } {
  const userData = mkdtempSync(join(tmpdir(), "kb-res-user-"));
  const roots = [userData];
  let seedPath: string | undefined;
  if (withSeed) {
    const seedDir = mkdtempSync(join(tmpdir(), "kb-res-seed-"));
    roots.push(seedDir);
    seedPath = join(seedDir, "residue.json");
    writeFileSync(seedPath, JSON.stringify(SEED_PROCESSES), "utf8");
  }
  return { userData, seedPath, roots };
}

/** 尽力删除目录：Windows 下 electron 子进程退出有延迟，重试后仍锁则告警放行 */
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

/** 主工作区（侧栏 + 中央区）须铺满顶部条之下的全部剩余高度：底部与视口齐平，不露应用底色 */
async function expectWorkspaceFillsViewport(win: Page): Promise<void> {
  const workspace = win.locator("#root > div > .grid.min-h-0").first();
  await expect.poll(async () => {
    const box = await workspace.boundingBox();
    return box ? Math.round(box.y + box.height) : -1;
  }).toBeGreaterThanOrEqual(await win.evaluate(() => innerHeight - 2));
}

/** 启动应用（Fake 演示链路 + userData 隔离；种子模式下 Main 检测直接返回种子清单、kill 统一回报 killed） */
async function launchApp(userData: string, seedPath?: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await _electron.launch({
    args: [join(__dirname, "..")],
    env: {
      ...process.env,
      KANBAN_USER_DATA: userData,
      KANBAN_DISABLE_CLAUDE: "1",
      KANBAN_DISABLE_OPENCODE: "1",
      ...(seedPath ? { KANBAN_TEST_RESIDUE_JSON: seedPath } : {}),
    },
  });
  const win = await app.firstWindow();
  return { app, win };
}

test("预置检测结果：通知条 + 进程表呈现，「无会话记录」默认不勾选，「忽略本次」条消失", async () => {
  const { userData, seedPath, roots } = makeFixture(true);
  try {
    const { app, win } = await launchApp(userData, seedPath);
    const banner = win.getByTestId("residue-banner");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText("检测到 3 个疑似残留 CLI 进程");
    await expect(banner).toContainText("清理前请确认它们不是你自己打开的");

    // 进程表行内容（原型 d4：勾选/PID/进程/启动时间/关联记录）
    const row1 = win.getByTestId("residue-row-28432");
    await expect(row1).toContainText("28432");
    await expect(row1).toContainText("codex.exe");
    await expect(row1).toContainText("会话「实现 Diff 解析」");
    const row2 = win.getByTestId("residue-row-29004");
    await expect(row2).toContainText("无会话记录");
    const row3 = win.getByTestId("residue-row-29512");
    await expect(row3).toContainText("疑似上次会话「修复启动崩溃」");
    // 默认勾选：仅精确匹配勾、无会话记录与疑似回落均不勾（防误杀，P2）
    await expect(win.getByLabel("勾选 PID 28432")).toBeChecked();
    await expect(win.getByLabel("勾选 PID 29004")).not.toBeChecked();
    await expect(win.getByLabel("勾选 PID 29512")).not.toBeChecked();
    await expectWorkspaceFillsViewport(win);

    // 忽略本次：条消失（下次启动重新检测），主工作区仍须铺满剩余高度（回归：条件渲染条消失后 1fr 行错位露底色）
    await win.getByRole("button", { name: "忽略本次" }).click();
    await expect(banner).toBeHidden();
    await expectWorkspaceFillsViewport(win);
    await app.close();
  } finally {
    for (const r of roots) await rmBestEffort(r);
  }
});

test("确认式清理：补勾无记录行 → 清理选中 → 逐 pid 终止（fake 全 killed）→ 表清空、条消失", async () => {
  const { userData, seedPath, roots } = makeFixture(true);
  try {
    const { app, win } = await launchApp(userData, seedPath);
    const banner = win.getByTestId("residue-banner");
    await expect(banner).toBeVisible({ timeout: 15_000 });

    // 补勾「无会话记录」与「疑似回落」行一起清理（确认式：仅勾选 pid 被终止）
    await win.getByLabel("勾选 PID 29004").check();
    await win.getByLabel("勾选 PID 29512").check();
    await win.getByRole("button", { name: "清理选中" }).click();
    // fake kill 逐 pid 全 killed：表清空 → 条消失
    await expect(banner).toBeHidden({ timeout: 15_000 });
    await expect(win.getByTestId("residue-row-28432")).toHaveCount(0);
    await expect(win.getByTestId("residue-row-29004")).toHaveCount(0);
    await expect(win.getByTestId("residue-row-29512")).toHaveCount(0);
    await app.close();
  } finally {
    for (const r of roots) await rmBestEffort(r);
  }
});

test("无残留不打扰：无种子（隔离环境跳过机器级枚举）不出现任何残留 UI", async () => {
  const { userData, roots } = makeFixture(false);
  try {
    const { app, win } = await launchApp(userData);
    // 等应用骨架就位后确认无通知条（无结果不推送任何事件、无 UI）
    await expect(win.getByText("未注册项目")).toBeVisible({ timeout: 15_000 });
    await expect(win.getByTestId("residue-banner")).toHaveCount(0);
    await app.close();
  } finally {
    for (const r of roots) await rmBestEffort(r);
  }
});
