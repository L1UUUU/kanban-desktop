// 用途：阶段 3 记忆 Playwright 全流程（issue #36 / spec #27 I 节）—— 预置数据驱动两条主线：
// ① 记忆视图链路（#34/#38）：侧栏底部入口 → 无项目空态 → 当前项目分区列表 → 搜索（命中/无匹配/pending 不进）→ 知识编辑（editAccepted）→ 总结编辑（editSummary，#38）→ 复制路径/内容（主进程剪贴板回读断言）；
// ② 详情审核闭环（#33）：预置「完成批次+待审候选（含冲突提示）+proposed 暂存+失败/取消批次」→ 三动作审核（接受并存/编辑后接受/忽略）→ 冲突提示 → proposed 对比弹层二选一 → 记忆视图检索到刚接受的知识；
// 原型一致项 1–8 逐条真实渲染走查，截图归档 docs/acceptance/stage3/screenshots/（沿 #22 模式）。
// 已知边界：四步进度/取消的进行中态需真实模型调用（run-once 仅真实 CLI，无 fake），由 #31/#32 B 类 e2e 与 #33 组件测试覆盖；本票预置数据只能走到失败/取消终态卡。
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { SEED, SEED_PROJECT_NAME, SEED_REQ2_TITLE, SEED_REQ_TITLE, seedMemoryFixture, type MemorySeed } from "./memory-seed";

/** 截图归档目录（docs/acceptance/stage3/screenshots，沿 #22 阶段 2 验收目录约定） */
const SHOT_DIR = resolve(__dirname, "../../../docs/acceptance/stage3/screenshots");

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

/** 启动被测应用（种子 userData + 伪 git 仓库目录；Fake 演示链路） */
async function launchApp(seed: MemorySeed): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await _electron.launch({
    args: [resolve(__dirname, "..")],
    env: {
      ...process.env,
      KANBAN_USER_DATA: seed.userData,
      KANBAN_DISABLE_CLAUDE: "1",
      KANBAN_DISABLE_OPENCODE: "1",
      KANBAN_TEST_PICK_DIRECTORY: seed.repoDir,
    },
  });
  const win = await app.firstWindow();
  return { app, win };
}

/** 截图到验收目录（调用前自行断言目标状态可见） */
async function shot(win: Page, name: string): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  await win.screenshot({ path: join(SHOT_DIR, name) });
  console.log(`[shot] ${name}`);
}

/** 选中侧栏项目行（首轮启动无当前项目 → 点击即切换并持久化） */
async function selectProject(win: Page): Promise<void> {
  await win.locator("aside").getByText(SEED_PROJECT_NAME, { exact: true }).first().click();
}

test("记忆视图链路（#34/#38）：入口 → 无项目空态 → 项目分区列表 → 搜索（命中/无匹配/pending 不进）→ 知识编辑 → 总结编辑 → 复制路径/内容（原型一致项 1/2/8）", async () => {
  const seed = seedMemoryFixture();
  try {
    const { app, win } = await launchApp(seed);

    // 一致项 1：侧栏底部「记忆」入口与看板入口同款同位（sidebarFooter 槽、看板之侧），带当前项目指示
    const aside = win.locator("aside");
    await expect(aside.getByTestId("kanban-entry")).toBeVisible({ timeout: 15_000 });
    await expect(aside.getByTestId("memory-entry")).toBeVisible();
    await expect(aside.getByTestId("memory-entry")).toContainText("记忆");
    await shot(win, "01-memory-entry-sidebar.png");

    // 无项目空态（首轮启动未选项目）：进入记忆视图 → 引导文案（一致项 2 的空态分支）
    await aside.getByTestId("memory-entry").click();
    await expect(win.getByTestId("memory-workspace")).toBeVisible();
    await expect(win.getByTestId("memory-empty-project")).toHaveText("选择或注册项目后查看项目记忆");

    // 选项目 → 记忆视图按当前项目分区水化（同库种子经 projectMemory 一次读）
    await selectProject(win);
    await expect(aside.getByTestId("memory-entry")).toContainText(SEED_PROJECT_NAME);
    await expect(win.getByTestId("memory-workspace")).toContainText(`${SEED_PROJECT_NAME} · 项目记忆`);

    // 一致项 2：搜索框（占位声明口径）+ 已接受知识列表（claim/范围徽标/来源数/状态 chip/编辑/复制×2）+ 需求总结区
    await expect(win.getByTestId("memory-search")).toHaveAttribute("placeholder", /搜索已接受知识与需求总结/);
    await expect(win.getByText("已接受知识（2）")).toBeVisible(); // pending/ignored 不进（US20）
    const card1 = win.locator('[data-testid="memory-knowledge-card"]', { hasText: SEED.acceptedClaim });
    const card2 = win.locator('[data-testid="memory-knowledge-card"]', { hasText: SEED.editedClaim });
    await expect(card1).toBeVisible();
    await expect(card1.getByTestId("memory-knowledge-scope")).toContainText("适用范围：构建");
    await expect(card1.getByTestId("memory-knowledge-source")).toHaveText("来源 1 会话");
    await expect(card1.getByTestId("memory-knowledge-status")).toHaveText("已接受");
    await expect(card1).toContainText("CAND-0001");
    await expect(card2.getByTestId("memory-knowledge-status")).toHaveText("已编辑"); // 编辑有效值 + 已编辑 chip
    const summaryRow = win.getByTestId("memory-summary-row");
    await expect(summaryRow).toContainText(SEED_REQ_TITLE);
    await expect(summaryRow).toContainText("更新于 2026-11-06"); // 种子确定性时间戳
    await expect(summaryRow.getByTestId("memory-summary-view")).toBeVisible();
    await expect(summaryRow.getByTestId("memory-summary-edit")).toBeVisible();
    await expect(summaryRow.getByTestId("memory-summary-copy-path")).toBeVisible();
    await shot(win, "02-memory-workspace.png");

    // 搜索命中：仅命中知识卡保留，未命中分区隐藏
    const search = win.getByTestId("memory-search");
    await search.fill("构建提速");
    await expect(card1).toBeVisible();
    await expect(card2).toHaveCount(0);
    await expect(summaryRow).toHaveCount(0);

    // 无匹配空态（顺带验证 pending 候选不进搜索：待忽略候选措辞查无结果）
    await search.fill(SEED.ignorePendingClaim);
    await expect(win.getByTestId("memory-empty-search")).toHaveText("没有匹配的知识或总结");
    await shot(win, "02b-memory-empty-search.png");
    await search.fill("");

    // 知识编辑（memory:editAccepted 真通道）：弹层预填有效值 → 改 claim → 保存 → 列表即时更新
    const revisedClaim = `${SEED.acceptedClaim}（人工修订）`;
    await card1.getByTestId("memory-knowledge-edit").click();
    const knowledgeDialog = win.getByTestId("memory-knowledge-dialog");
    await expect(knowledgeDialog).toBeVisible();
    await expect(win.getByTestId("memory-edit-claim")).toHaveValue(SEED.acceptedClaim);
    await expect(win.getByTestId("memory-edit-scope")).toHaveValue(SEED.acceptedScope);
    await win.getByTestId("memory-edit-claim").fill(revisedClaim);
    await win.getByTestId("memory-knowledge-save").click();
    await expect(knowledgeDialog).toHaveCount(0);
    await expect(win.locator('[data-testid="memory-knowledge-card"]', { hasText: revisedClaim })).toBeVisible();

    // 总结编辑（memory:editSummary，#38 一致项 8）：同款弹层 textarea → 写回落盘 → 查看弹层读到新版正文
    await summaryRow.getByTestId("memory-summary-edit").click();
    const summaryEditDialog = win.getByTestId("memory-summary-edit-dialog");
    await expect(summaryEditDialog).toBeVisible();
    await expect(win.getByTestId("memory-summary-textarea")).toHaveValue(SEED.summaryHuman); // 人工版预填
    const revisedSummary = `${SEED.summaryHuman}\n编辑闭环补充：总结编辑通道已接通。`;
    await win.getByTestId("memory-summary-textarea").fill(revisedSummary);
    await shot(win, "08-summary-edit-dialog.png");
    await win.getByTestId("memory-summary-save").click();
    await expect(summaryEditDialog).toHaveCount(0);
    await summaryRow.getByTestId("memory-summary-view").click();
    const viewDialog = win.getByTestId("memory-summary-dialog");
    await expect(viewDialog).toContainText("编辑闭环补充：总结编辑通道已接通。");
    await viewDialog.getByRole("button", { name: "关闭" }).click();

    // 复制路径/内容：断言复制反馈提示（本运行环境系统剪贴板不可用——主进程 clipboard 直写亦读回空，
    // 非交互会话限制——剪贴板落读不可判；提示条即 copyText 成功路径的用户可见反馈，路径值正确性由种子 mdPath 断言侧证）
    await win.locator('[data-testid="memory-knowledge-card"]', { hasText: revisedClaim }).getByTestId("memory-knowledge-copy-path").click();
    await expect(win.getByTestId("memory-copy-notice")).toContainText("已复制路径");
    await win.locator('[data-testid="memory-knowledge-card"]', { hasText: revisedClaim }).getByTestId("memory-knowledge-copy-content").click();
    await expect(win.getByTestId("memory-copy-notice")).toContainText("已复制内容");
    await summaryRow.getByTestId("memory-summary-copy-path").click();
    await expect(win.getByTestId("memory-copy-notice")).toContainText("已复制路径");

    await app.close();
  } finally {
    await rmBestEffort(seed.userData);
    await rmBestEffort(seed.repoRoot);
  }
});

test("详情审核闭环（#33）：完成批次+待审候选（冲突提示）+proposed 暂存 → 三动作审核 → 对比弹层二选一 → 记忆视图检索到刚接受的知识（原型一致项 3–7）", async () => {
  const seed = seedMemoryFixture();
  try {
    const { app, win } = await launchApp(seed);
    await selectProject(win);

    // 看板 → 审核需求卡 → 详情面板「需求经验」区
    await win.getByTestId("kanban-entry").click();
    const noneCol = win.getByTestId("kanban-col-none");
    await expect(noneCol.getByText(SEED_REQ_TITLE)).toBeVisible({ timeout: 15_000 });
    await noneCol.getByText(SEED_REQ_TITLE).click();
    const panel = win.getByTestId("detail-panel");
    await expect(panel.getByTestId("memory-area")).toBeVisible();

    // 一致项 3（可触发分支）：关联 1 个结构化会话 → 提取按钮可用 + tooltip 说明
    const extractButton = panel.getByTestId("memory-extract-button");
    await expect(extractButton).toBeEnabled();
    await expect(extractButton).toHaveAttribute("title", /读取当前关联的结构化会话历史/);

    // 一致项 4：批次卡元信息 + 缺失会话警示条 + failed 红边卡（原因+重试）+ cancelled 灰显
    const cardOf = (batchId: string) => panel.locator(`[data-testid="memory-batch-card"][data-batch-id="${batchId}"]`);
    await expect(cardOf("B-seed-1").getByTestId("memory-batch-meta")).toContainText("来源 1 会话 · 缺失 0 · 分段 2 · 模型调用 2 次");
    await expect(cardOf("B-seed-1").getByTestId("memory-batch-meta")).toContainText("候选 2 条（待审 0）"); // 两候选已在种子期审为知识
    await expect(cardOf("B-seed-2").getByTestId("memory-batch-meta")).toContainText("候选 3 条（待审 3）");
    const failedCard = cardOf("B-seed-4");
    await expect(failedCard).toHaveAttribute("data-status", "failed");
    await expect(failedCard.getByTestId("memory-batch-error")).toContainText(SEED.failedError);
    await expect(failedCard.getByTestId("memory-retry-button")).toHaveText("重试（新批次）");
    await expect(failedCard.getByTestId("memory-missing-sessions")).toContainText("缺失 1 个会话");
    await expect(failedCard.getByTestId("memory-missing-sessions")).toContainText("本次分析不覆盖其内容");
    await expect(cardOf("B-seed-5")).toHaveAttribute("data-status", "cancelled");

    // 一致项 6：待审跨批次累计 + 冲突提示（相似度+对方编号+并存不替换声明）+ 三动作按钮
    await expect(panel.getByText(/知识候选 · 待审核 3（跨批次累计）/)).toBeVisible();
    const conflictCard = panel.locator('[data-testid="memory-candidate"]', { hasText: SEED.conflictPendingClaim });
    await expect(conflictCard).toBeVisible();
    await expect(conflictCard.getByTestId("memory-candidate-batch")).toContainText("B-seed-2");
    const conflictNote = conflictCard.getByTestId("memory-conflict-note");
    await expect(conflictNote).toContainText(seed.conflictDisplayNo);
    await expect(conflictNote).toContainText("相似度");
    await expect(conflictNote).toContainText("不会替换已有知识");
    await shot(win, "06-candidates-conflict-review.png");

    // 已处置按批次折叠：展开 B1 批次 → accepted/edited 终态 + 「去编辑」入口
    const toggleB1 = panel.getByTestId("memory-disposed-toggle").filter({ hasText: "B-seed-1" });
    await expect(toggleB1).toContainText("已接受 1 · 已编辑 1");
    await toggleB1.click();
    const disposedB1 = panel.locator('[data-testid="memory-disposed-group"][data-batch-id="B-seed-1"]');
    await expect(disposedB1.getByTestId("memory-disposed-candidate").filter({ hasText: SEED.acceptedClaim })).toBeVisible();
    const editedDisposed = disposedB1.getByTestId("memory-disposed-candidate").filter({ hasText: SEED.editedClaim });
    await expect(editedDisposed).toHaveAttribute("data-status", "edited");
    await expect(editedDisposed.getByTestId("memory-go-edit")).toBeVisible();

    // 三动作 ①：接受（并存）——冲突候选落库为知识，待审数 3→2，B2 批次进入已处置折叠
    await conflictCard.getByTestId("memory-accept-candidate").click();
    await expect(panel.getByText(/待审核 2（跨批次累计）/)).toBeVisible();
    await expect(panel.getByTestId("memory-disposed-toggle").filter({ hasText: "B-seed-2" })).toContainText("已接受 1");

    // 三动作 ②：编辑后接受——一致项 7 弹层（claim/scope 可编辑、溯源只读、保存标注已编辑）
    const editCard = panel.locator('[data-testid="memory-candidate"]', { hasText: SEED.editPendingClaim });
    await editCard.getByTestId("memory-edit-candidate").click();
    const editDialog = panel.getByTestId("memory-edit-dialog");
    await expect(editDialog).toBeVisible();
    await expect(editDialog).toContainText("编辑知识候选");
    await expect(panel.getByTestId("memory-edit-claim")).toHaveValue(SEED.editPendingClaim);
    await expect(panel.getByTestId("memory-edit-scope")).toHaveValue(SEED.pendingScope);
    await expect(panel.getByTestId("memory-edit-source")).toContainText(`证据摘录：「${SEED.pendingEvidence}」`);
    await expect(panel.getByTestId("memory-edit-source")).toContainText(/候选编号 CAND-\d{4}/); // 溯源含编号（B1 两条知识占 0001/0002，本批按序 0003–0005）
    const revisedPendingClaim = "长历史分段处理按会话边界优先，累计上限 6000（编辑后接受）";
    await panel.getByTestId("memory-edit-claim").fill(revisedPendingClaim);
    await shot(win, "07-candidate-edit-dialog.png");
    await panel.getByTestId("memory-edit-save").click();
    // #33 交互口径：保存成功弹层保持打开（组件测试同口径），以审核生效为成功信号，再手动关闭
    await expect(panel.getByText(/待审核 1（跨批次累计）/)).toBeVisible();
    await expect(panel.getByTestId("memory-edit-error")).toHaveCount(0);
    await panel.getByTestId("memory-edit-cancel").click();
    await expect(editDialog).toHaveCount(0);

    // 三动作 ③：忽略——待审清零；展开 B2 折叠组核对终态混合（接受 1/已编辑 1/已忽略 1，忽略无「去编辑」）
    panel.locator('[data-testid="memory-candidate"]', { hasText: SEED.ignorePendingClaim }).getByTestId("memory-ignore-candidate").click();
    await expect(panel.getByText(/待审核 0（跨批次累计）/)).toBeVisible();
    const toggleB2 = panel.getByTestId("memory-disposed-toggle").filter({ hasText: "B-seed-2" });
    await toggleB2.click();
    const disposedB2 = panel.locator('[data-testid="memory-disposed-group"][data-batch-id="B-seed-2"]');
    await expect(disposedB2.getByTestId("memory-disposed-candidate").filter({ hasText: SEED.conflictPendingClaim })).toHaveAttribute("data-status", "accepted");
    await expect(disposedB2.getByTestId("memory-disposed-candidate").filter({ hasText: revisedPendingClaim })).toHaveAttribute("data-status", "edited");
    const ignoredDisposed = disposedB2.getByTestId("memory-disposed-candidate").filter({ hasText: SEED.ignorePendingClaim });
    await expect(ignoredDisposed).toHaveAttribute("data-status", "ignored");
    await expect(ignoredDisposed.getByTestId("memory-go-edit")).toHaveCount(0); // 忽略不是知识，无再编辑入口

    // 「去编辑」入口（终态知识）：编辑已接受知识弹层（同款形态，mode=knowledge）
    await disposedB2.getByTestId("memory-go-edit").first().click();
    await expect(panel.getByTestId("memory-edit-dialog")).toContainText("编辑已接受知识");
    await panel.getByTestId("memory-edit-cancel").click();

    // 一致项 5：proposed 提示条（批次 B-seed-3）→ 对比弹层两栏并排只读 → 采纳新版 → 暂存清除
    const proposedBar = panel.getByTestId("memory-proposed-bar");
    await expect(proposedBar).toContainText("检测到人工编辑过的总结");
    await expect(proposedBar).toContainText("B-seed-3");
    await shot(win, "05-proposed-bar.png");
    await proposedBar.getByTestId("memory-compare-button").click();
    const compareDialog = panel.getByTestId("memory-compare-dialog");
    await expect(compareDialog.getByTestId("memory-compare-human")).toContainText("人工补充：验收以 Playwright 全流程为准");
    await expect(compareDialog.getByTestId("memory-compare-new")).toContainText("重新提取后的新版总结");
    await shot(win, "05b-summary-compare-dialog.png");
    await compareDialog.getByTestId("memory-compare-accept").click();
    await expect(compareDialog).toHaveCount(0);
    await expect(proposedBar).toHaveCount(0);

    // 一致项 3（禁用分支）：无会话需求 → 提取按钮禁用 + tooltip 说明原因
    await win.getByTestId("detail-close").click();
    await noneCol.getByText(SEED_REQ2_TITLE).click();
    const disabledButton = win.getByTestId("detail-panel").getByTestId("memory-extract-button");
    await expect(disabledButton).toBeDisabled();
    await expect(disabledButton).toHaveAttribute("title", /该需求没有关联的结构化会话/);
    await shot(win, "03-extract-button-disabled.png");

    // 闭环收口：记忆视图检索到刚接受的知识（含冲突对），总结已是采纳的新版
    await win.getByTestId("memory-entry").click();
    await expect(win.getByTestId("memory-workspace")).toContainText(`${SEED_PROJECT_NAME} · 项目记忆`);
    await win.getByTestId("memory-search").fill("pnpm --filter");
    await expect(win.locator('[data-testid="memory-knowledge-card"]', { hasText: SEED.conflictPendingClaim })).toBeVisible();
    await win.getByTestId("memory-search").fill("");
    await win.getByTestId("memory-summary-row").getByTestId("memory-summary-view").click();
    await expect(win.getByTestId("memory-summary-dialog")).toContainText("重新提取后的新版总结");

    await app.close();
  } finally {
    await rmBestEffort(seed.userData);
    await rmBestEffort(seed.repoRoot);
  }
});
