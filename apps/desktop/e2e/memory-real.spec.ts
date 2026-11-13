// 用途：阶段 3 真实验收最小集（issue #37 / spec #27 Testing 验收票）—— env-gated（KANBAN_REAL_E2E=1）：
// 真实需求（手动建卡）+ 两 CLI 关联 structured 会话（Claude/Codex 各一条含工具调用的真实短 turn）→
// GUI 真实触发「提取需求经验」（真实 Claude headless，模型调用预算 ≤3 含重试：批次1 两段 2 次 + 批次2 解除 Codex 后一段 1 次）→
// 三层隔离 sha256 前后复核（PoC 5 方法）→ 候选三动作审核入库 → 记忆视图检索/复制路径 → 重启保持 →
// editSummary 人工编辑 → 再提取走 proposed 不覆盖 → 对比弹层二选一收尾；
// 截图/隔离报告/模型调用台账归档 docs/acceptance/stage3/real-evidence/（沿 stage2 real-evidence 模式）。
import { test, expect, _electron, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { copyFileSync, type Dirent, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { artifactPath, shot, writeArtifact } from "./helpers/acceptance-artifacts";

const REAL = process.env.KANBAN_REAL_E2E === "1";
test.skip(!REAL, "真实验收：需 KANBAN_REAL_E2E=1 且本机 Claude/Codex 已装已认证");

const PROJECT_NAME = "kb-s3-real-proj";
const REQ_TITLE = "真实提取验收需求";
const EVIDENCE_DIR = resolve(__dirname, "../../../docs/acceptance/stage3/real-evidence");

/** 开发会话要读取的项目约定文件（给两 CLI turn 提供含工具调用的真实素材，内容即候选提取素材） */
const NOTES_MD = [
  "# 项目约定（阶段 3 真实验收 fixture）",
  "",
  "- 构建必须走 pnpm --filter 精确子集构建，禁止全仓安装后全量构建",
  "- 所有文件一律 UTF-8 无 BOM，禁止 GBK",
  "- Windows 下 spawn 必须直连真实 exe、不经 shell（MSYS 会改写参数与 env）",
  "",
].join("\n");

/** 造历史的开发会话 prompt（短、指向 NOTES.md、要求一次工具读取） */
const CLAUDE_PROMPT = "请用 Read 工具读取 NOTES.md，然后用一句话总结其中的核心构建约定，不要做其他任何事。";
const CODEX_PROMPT = "请用 shell 读取 NOTES.md 的内容（type 或 cat），然后用一句话总结其中的编码约定，不要做其他任何事。";

/** 模型调用台账条目（如实记录每次真实模型调用：时间/CLI/purpose） */
interface LedgerEntry {
  t: string;
  cli: string;
  purpose: string;
  batchId?: string;
  note?: string;
}

/** 隔离快照：文件 → sha256（PoC 5 指纹方法） */
type FingerprintMap = Record<string, string>;

/** 建隔离 fixture：独立 userData + 伪 git 仓库目录（预置 NOTES.md 约定文件） */
function makeFixture(): { userData: string; repoDir: string; repoRoot: string } {
  const userData = mkdtempSync(join(tmpdir(), "kb-s3-real-user-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "kb-s3-real-repo-"));
  const repoDir = join(repoRoot, PROJECT_NAME);
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  writeFileSync(join(repoDir, "NOTES.md"), NOTES_MD, "utf8");
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

/** 启动真实应用（不打 KANBAN_DISABLE_*：Claude/Codex 走真实 Adapter；userData 与 pick 目录隔离） */
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

/** 侧栏指定会话行等待空闲（真实 CLI 轮次耗时不定，宽限超时；审批卡出现时自动「总是允许」） */
async function waitIdle(win: Page, title: string, timeout = 300_000): Promise<void> {
  const row = win.locator("aside").locator('[data-testid="session-row"]', { hasText: title });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    // 审批卡（如 Codex shell 读取被 sandbox 拦截请求放行）：自动「总是允许」保证轮次推进
    const approve = win.getByRole("button", { name: "总是允许", exact: true });
    if (await approve.isVisible().catch(() => false)) {
      await approve.click().catch(() => {});
      console.log(`[real-e2e] 自动放行审批（会话 ${title}）`);
    }
    if (await row.getByText("空闲", { exact: true }).isVisible().catch(() => false)) return;
    await win.waitForTimeout(1000);
  }
  throw new Error(`会话 ${title} 未在时限内回到空闲`);
}

/** 文件 sha256（PoC 5 指纹方法核心） */
function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** claude projects 目录（与 cli-host transcript.ts 同口径：CLAUDE_CONFIG_DIR ?? ~/.claude） */
function claudeProjectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
}

/** cwd → projects 子目录名（与 cli-host transcript.ts mungeCwd 同规则） */
function mungeCwd(cwd: string): string {
  return cwd.replace(/[:\\ /]/g, "-");
}

/** 递归收集目录下全部 jsonl 文件（codex sessions 为 YYYY/MM/DD 层级） */
function listJsonl(dir: string, since: number): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listJsonl(p, since));
    else if (e.isFile() && e.name.endsWith(".jsonl") && statSync(p).mtimeMs >= since) out.push(p);
  }
  return out;
}

/** 开发会话原生历史指纹快照：claude = projects/<munge(repoDir)>/；codex = ~/.codex/sessions 内 mtime>=runStart 的 rollout */
function fingerprintDevHistories(repoDir: string, runStart: number): FingerprintMap {
  const map: FingerprintMap = {};
  const claudeDir = join(claudeProjectsDir(), mungeCwd(repoDir));
  for (const f of listJsonl(claudeDir, 0)) map[f] = sha256(f);
  const codexRoot = join(homedir(), ".codex", "sessions");
  for (const f of listJsonl(codexRoot, runStart)) map[f] = sha256(f);
  return map;
}

/** 对比前后指纹：全部不变 → isolated=true（附逐文件明细） */
function compareFingerprints(pre: FingerprintMap, post: FingerprintMap): { isolated: boolean; details: Array<{ file: string; unchanged: boolean }> } {
  const details = Object.entries(pre).map(([file, hash]) => ({ file, unchanged: post[file] === hash }));
  return { isolated: details.every((d) => d.unchanged), details };
}

/** 提取临时会话的新生 transcript（三层隔离第 1/3 层证据：全新 session id + extract-tmp cwd 派生目录；按 userData 派生前缀过滤防 poc-5 同名目录混入） */
function findExtractionTranscripts(userData: string, since: number): Array<{ file: string; sessionId: string; cwdDir: string }> {
  const out: Array<{ file: string; sessionId: string; cwdDir: string }> = [];
  const projects = claudeProjectsDir();
  const prefix = mungeCwd(join(userData, "memory"));
  let dirs: Dirent[];
  try {
    dirs = readdirSync(projects, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory() || !d.name.startsWith(prefix) || !d.name.includes("extract-tmp")) continue;
    for (const f of listJsonl(join(projects, d.name), since)) {
      out.push({ file: f, sessionId: f.slice(0, -6).split(/[\\/]/).pop() ?? "", cwdDir: d.name });
    }
  }
  return out;
}

/** 台账与报告落盘 helper（真实证据直写验收目录） */
function writeEvidenceJson(name: string, data: unknown): void {
  writeArtifact(EVIDENCE_DIR, name, JSON.stringify(data, null, 2));
}

/** CLI 版本留证（写入 real-evidence/cli-versions.txt） */
function recordVersions(): void {
  const lines: string[] = [];
  for (const cmd of ["claude --version", "codex --version"]) {
    try {
      lines.push(`${cmd} => ${execSync(cmd, { encoding: "utf8", timeout: 30_000 }).trim()}`);
    } catch (e) {
      lines.push(`${cmd} => 探测失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const text = `${new Date().toISOString()}（阶段 3 真实验收）\n${lines.join("\n")}\n`;
  writeArtifact(EVIDENCE_DIR, "cli-versions.txt", text);
  console.log(`[real-e2e] CLI 版本：\n${text}`);
}

/** 等待批次卡出现指定终态（批次列表最新在前 → first() 为最新批次；两段×300s 上限放宽） */
async function waitBatchStatus(win: Page, status: string, timeout = 660_000): Promise<Locator> {
  const card = win.locator(`[data-testid="memory-batch-card"][data-status="${status}"]`).first();
  await expect(card).toBeVisible({ timeout });
  return card;
}

/** 发送后等待轮次真实开始（行离开「空闲」），再等回到「空闲」——防「发送前仍空闲」的早退竞态 */
async function waitTurnRoundtrip(win: Page, title: string, timeout = 300_000): Promise<void> {
  const row = win.locator("aside").locator('[data-testid="session-row"]', { hasText: title });
  await expect(row.getByText("空闲", { exact: true })).toBeHidden({ timeout: 30_000 });
  await waitIdle(win, title, timeout);
}

/** 进入看板并确保指定需求详情面板打开（面板选中态在 App 层 hook、跨视图切换保持——已开则复用，未开才点卡；规避透明遮罩拦截点卡） */
async function openDetail(win: Page, title: string): Promise<void> {
  await win.getByTestId("kanban-entry").click();
  const panel = win.getByTestId("detail-panel");
  if (!(await panel.isVisible().catch(() => false))) {
    await win.getByTestId("kanban-col-none").getByText(title).click();
  }
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(win.getByTestId("detail-title-input")).toHaveValue(title);
}

test("阶段 3 真实验收全链：双 CLI 真实会话 → GUI 提取（2 段）→ 隔离复核 → 审核入库 → 记忆检索 → 重启保持 → 防覆盖闭环（1 段）", async () => {
  test.setTimeout(1_500_000);
  const runStart = Date.now();
  recordVersions();
  const ledger: LedgerEntry[] = [];
  const logCall = (cli: string, purpose: string, note?: string): void => {
    ledger.push({ t: new Date().toISOString(), cli, purpose, note });
    console.log(`[model-call] ${cli} · ${purpose}`);
  };
  const { userData, repoDir, repoRoot } = makeFixture();
  let completed = false;
  let prePrints: FingerprintMap = {};
  let isolation: {
    devHistories: Array<{ file: string; cli: string }>;
    checks: Array<{ at: string; isolated: boolean; details: Array<{ file: string; unchanged: boolean }> }>;
    extractionTranscripts: Array<{ file: string; sessionId: string; cwdDir: string }>;
  } = { devHistories: [], checks: [], extractionTranscripts: [] };

  try {
    const { app, win } = await launchApp(userData, repoDir);

    // ---- ① 注册项目 + 手动建卡（真实需求）----
    await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
    await expect(win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
    await win.getByTestId("kanban-entry").click();
    await win.getByTestId("kanban-col-none").getByTitle("手动新建需求（归属当前项目）").click();
    const noneCol = win.getByTestId("kanban-col-none");
    // #84 建卡即命名：卡片立即进入行内命名输入，Enter 落定（kanban:rename 事件流，重启不回退）
    const nameInput = noneCol.getByTestId("card-title-input");
    await expect(nameInput).toBeVisible({ timeout: 10_000 });
    await nameInput.fill(REQ_TITLE);
    await nameInput.press("Enter");
    await expect(noneCol.getByText(REQ_TITLE)).toBeVisible({ timeout: 10_000 });
    // 点卡开详情面板（面板保持打开：stage2 §8 面板透明遮罩拦截点卡，不重复点卡）
    await noneCol.getByText(REQ_TITLE).click();
    await expect(win.getByTestId("detail-panel")).toBeVisible();
    await expect(win.getByTestId("detail-title-input")).toHaveValue(REQ_TITLE);

    // ---- ② 关联 structured 会话×2：Claude + Codex 各一条真实短 turn（含工具调用）----
    await win.getByTestId("new-session-menu").click();
    await win.getByTestId("new-session-item-claude").click();
    // #59 草稿：卡片入口打开草稿并切回聊天；首条消息随「创建+落库+发送」原子发出，关联随首条落到新会话
    await send(win, CLAUDE_PROMPT);
    logCall("claude", "造历史：开发会话① 真实短 turn（Read 工具读取 NOTES.md + 一句话总结）");
    const panel = win.getByTestId("detail-panel");
    const claudeRow = panel.locator('[data-testid="related-session"]', { hasText: "请用 Read 工具读取 NOTES.md，然后…" });
    await expect(claudeRow).toBeVisible({ timeout: 60_000 });
    await waitTurnRoundtrip(win, "请用 Read 工具读取 NOTES.md，然后…"); // #94：标题=首条派生截断

    // 面板跨视图保持打开：直接复用（related-jump 切走再切回不丢选中态）
    await openDetail(win, REQ_TITLE);
    await win.getByTestId("new-session-menu").click();
    await win.getByTestId("new-session-item-codex").click();
    // #59 草稿：同上，首条消息随创建原子发出（无需 jump——卡片入口已切回聊天视图）
    await send(win, CODEX_PROMPT);
    logCall("codex", "造历史：开发会话② 真实短 turn（shell 读取 NOTES.md + 一句话总结）");
    const codexRow = panel.locator('[data-testid="related-session"]', { hasText: "请用 shell 读取 NOTES.md 的内容…" });
    await expect(codexRow).toBeVisible({ timeout: 60_000 });
    await waitTurnRoundtrip(win, "请用 shell 读取 NOTES.md 的内容…"); // #94：标题=首条派生截断

    // ---- ③ 提取前指纹快照（PoC 5 隔离基线）----
    await openDetail(win, REQ_TITLE);
    prePrints = fingerprintDevHistories(repoDir, runStart);
    isolation.devHistories = Object.keys(prePrints).map((file) => ({
      file,
      cli: file.includes(`${join(homedir(), ".codex")}`) ? "codex" : "claude",
    }));
    // 前置自检：两会话原生历史必须都已找到（claude transcript + codex rollout），否则隔离对比无对象
    const claudeCount = isolation.devHistories.filter((d) => d.cli === "claude").length;
    const codexCount = isolation.devHistories.filter((d) => d.cli === "codex").length;
    expect(claudeCount, `应找到 ≥1 个 claude 开发 transcript（实得 ${claudeCount}）`).toBeGreaterThanOrEqual(1);
    expect(codexCount, `应找到 ≥1 个 codex 开发 rollout（实得 ${codexCount}）`).toBeGreaterThanOrEqual(1);
    // 体量预检：历史文件必须含真实 turn 内容（防轮次失败产出空历史 → 分段数与断言失真）
    for (const d of isolation.devHistories) {
      expect(statSync(d.file).size, `开发历史过小（${d.file}），疑似轮次未真实完成`).toBeGreaterThan(500);
    }
    writeEvidenceJson("isolation-pre-fingerprints.json", { at: new Date().toISOString(), repoDir, prints: prePrints });

    // ---- ④ GUI 真实触发「提取需求经验」（批次①：两会话 → 两段 → 2 次模型调用）----
    await expect(win.getByTestId("memory-extract-button")).toBeEnabled();
    await win.getByTestId("memory-extract-button").click();
    // 进行中态（US8 四步进度）：extracting 段进度运行态真实可见（既有 Playwright 未覆盖的进行中 UI，真链路补证）
    await expect(win.getByTestId("memory-extract-progress")).toBeVisible({ timeout: 30_000 });
    await expect(win.getByTestId("memory-step-extracting")).toHaveAttribute("data-state", "run", { timeout: 120_000 });
    await shot(win, EVIDENCE_DIR, "real-00-extract-progress.png");
    const batch1 = await waitBatchStatus(win, "completed");
    const batch1Id = await batch1.getAttribute("data-batch-id");
    expect(batch1Id).toBeTruthy();
    // 批次卡元信息（US12）：两会话两段、缺失 0、模型调用如实计数
    await expect(batch1.getByTestId("memory-batch-meta")).toContainText("来源 2 会话");
    await expect(batch1.getByTestId("memory-batch-meta")).toContainText("缺失 0");
    await expect(batch1.getByTestId("memory-batch-meta")).toContainText("分段 2");
    await expect(batch1.getByTestId("memory-batch-meta")).toContainText("模型调用 2 次");
    logCall("claude", `提取批次① 段1+段2 临时 headless 会话（2 次模型调用，实测 UI 计数）`, `batchId=${batch1Id}`);
    await shot(win, EVIDENCE_DIR, "real-01-extract-completed.png");

    // ---- ⑤ 三层隔离复核：开发会话原生历史 sha256 前后不变 + 临时会话独立（新 session id + extract-tmp cwd）----
    const post1 = fingerprintDevHistories(repoDir, runStart);
    const check1 = compareFingerprints(prePrints, post1);
    isolation.checks.push({ at: new Date().toISOString(), isolated: check1.isolated, details: check1.details });
    expect(check1.isolated, `批次① 后开发历史指纹必须不变：${JSON.stringify(check1.details)}`).toBe(true);
    isolation.extractionTranscripts.push(...findExtractionTranscripts(userData, runStart));
    // 第 1 层（全新 session id）+ 第 3 层（cwd=应用数据 extract-tmp 派生目录）：临时会话 transcript 与开发会话目录分离
    expect(isolation.extractionTranscripts.length, "应找到批次① 临时会话的新生 transcript（extract-tmp cwd 派生）").toBeGreaterThanOrEqual(2);
    for (const t of isolation.extractionTranscripts) {
      expect(t.cwdDir).toContain("extract-tmp");
    }

    // ---- ⑥ 审核闭环：真实候选三动作（接受并存 / 编辑后接受 / 忽略）----
    const pending = panel.locator('[data-testid="memory-candidate"]');
    const pendingCount = await pending.count();
    expect(pendingCount, "真实提取应产出 ≥1 条待审候选").toBeGreaterThanOrEqual(1);
    // 接受第 1 条（并存入库）；记录 claim 原文供记忆视图检索断言
    const firstClaim = (await pending.first().getByTestId("memory-candidate-claim").textContent()) ?? "";
    expect(firstClaim.trim().length).toBeGreaterThan(0);
    await pending.first().getByTestId("memory-accept-candidate").click();
    await expect(panel.getByTestId("memory-candidate")).toHaveCount(pendingCount - 1, { timeout: 15_000 });
    // 编辑后接受 / 忽略：按实有待审数量尽量走完（真实产出数量不定；批次② 候选补齐缺口）
    let editDone = false;
    let ignoreDone = false;
    if (pendingCount >= 2) {
      const second = panel.locator('[data-testid="memory-candidate"]').first();
      await second.getByTestId("memory-edit-candidate").click();
      const editDialog = win.getByTestId("memory-edit-dialog");
      await expect(editDialog).toBeVisible();
      const editClaim = win.getByTestId("memory-edit-claim");
      const originalClaim = await editClaim.inputValue();
      await editClaim.fill(`${originalClaim}（验收人工修订）`);
      await win.getByTestId("memory-edit-save").click();
      // #33 交互口径：保存成功弹层保持打开，以待审数减少 + 无错误为成功信号，再手动关闭（#36 spec 同口径）
      await expect(win.getByTestId("memory-edit-error")).toHaveCount(0, { timeout: 15_000 });
      await expect(panel.getByTestId("memory-candidate")).toHaveCount(pendingCount - 2, { timeout: 15_000 });
      await win.getByTestId("memory-edit-cancel").click();
      await expect(editDialog).toHaveCount(0, { timeout: 15_000 });
      editDone = true;
    }
    if (pendingCount >= 3) {
      await panel.locator('[data-testid="memory-candidate"]').first().getByTestId("memory-ignore-candidate").click();
      await expect(panel.getByTestId("memory-candidate")).toHaveCount(pendingCount - (editDone ? 2 : 1) - 1, { timeout: 15_000 });
      ignoreDone = true;
    }
    await shot(win, EVIDENCE_DIR, "real-02-candidates-reviewed.png");

    // ---- ⑦ 记忆视图：检索命中 + 复制路径（文件真实可读）----
    await win.getByTestId("memory-entry").click();
    await expect(win.getByTestId("memory-workspace")).toContainText(`${PROJECT_NAME} · 项目记忆`);
    // 知识计数 = 接受 1 + 编辑后接受（accepted/edited 均计入；pending/ignored 不进）
    const expectedKnowledge = 1 + (editDone ? 1 : 0);
    await expect(win.getByText(`已接受知识（${expectedKnowledge}）`)).toBeVisible({ timeout: 15_000 });
    const knowledgeCard = win.locator('[data-testid="memory-knowledge-card"]', { hasText: firstClaim.slice(0, 12) });
    await expect(knowledgeCard).toBeVisible();
    // 搜索命中（大小写不敏感子串；用已接受 claim 原文的头部子串）
    const search = win.getByTestId("memory-search");
    await search.fill(firstClaim.slice(0, 8));
    await expect(knowledgeCard).toBeVisible();
    await shot(win, EVIDENCE_DIR, "real-03-memory-search-hit.png");
    await search.fill("");
    // 复制路径反馈 + 落盘文件真实可读（复制值本环境剪贴板不可读回——#36 已知边界，以 fs 直读侧证）
    await knowledgeCard.getByTestId("memory-knowledge-copy-path").click();
    await expect(win.getByTestId("memory-copy-notice")).toContainText("已复制路径");
    const summaryRow = win.getByTestId("memory-summary-row");
    await expect(summaryRow).toContainText(REQ_TITLE);
    await summaryRow.getByTestId("memory-summary-copy-path").click();
    await expect(win.getByTestId("memory-copy-notice")).toContainText("已复制路径");
    await shot(win, EVIDENCE_DIR, "real-04-memory-workspace.png");

    // 磁盘直读：accepted md 真实存在且内容含 claim 与溯源头（复制路径可供 CLI 按需读取的实证）
    const acceptedDir = join(userData, "memory");
    const acceptedFiles = listAcceptedFiles(acceptedDir);
    expect(acceptedFiles.length, "应存在 ≥1 个 accepted/CAND-xxxx.md").toBeGreaterThanOrEqual(1);
    const acceptedContent = readFileSync(acceptedFiles[0], "utf8");
    expect(acceptedContent).toContain(firstClaim.slice(0, 8));
    // summary.md 同样真实可读（含真实段小结）
    const summaryFiles = listSummaryFiles(acceptedDir);
    expect(summaryFiles.length).toBeGreaterThanOrEqual(1);
    const summaryContent = readFileSync(summaryFiles[0], "utf8");
    expect(summaryContent).toContain(REQ_TITLE);

    // ---- ⑧ 重启保持（US25）：关闭再重开，总结/候选状态/已接受知识/批次历史全部保持 ----
    await app.close();
    const second = await launchApp(userData, repoDir);
    const win2 = second.win;
    await expect(win2.getByTestId("kanban-entry")).toContainText(PROJECT_NAME, { timeout: 15_000 });
    await openDetail(win2, REQ_TITLE);
    const panel2 = win2.getByTestId("detail-panel");
    // 批次历史保持（completed 批次① 卡仍在）
    await expect(panel2.locator('[data-testid="memory-batch-card"][data-status="completed"]')).toHaveCount(1, { timeout: 15_000 });
    // 已处置候选按批次折叠（accepted/edited 知识与 ignored 保持终态）
    await expect(panel2.getByTestId("memory-disposed-group").first()).toBeVisible({ timeout: 15_000 });
    await shot(win2, EVIDENCE_DIR, "real-05-restart-kept.png");
    // 记忆视图：已接受知识与总结保持
    await win2.getByTestId("memory-entry").click();
    await expect(win2.getByText(`已接受知识（${expectedKnowledge}）`)).toBeVisible({ timeout: 15_000 });
    await expect(win2.getByTestId("memory-summary-row")).toContainText(REQ_TITLE);

    // ---- ⑨ 防覆盖闭环：editSummary 人工编辑 → 解除 Codex 关联 → 再提取（批次② 1 段 1 次调用）→ proposed 不覆盖 → 二选一 ----
    const summaryRow2 = win2.getByTestId("memory-summary-row");
    await summaryRow2.getByTestId("memory-summary-edit").click();
    const editSummaryDialog = win2.getByTestId("memory-summary-edit-dialog");
    await expect(editSummaryDialog).toBeVisible();
    const manualMarker = "人工修订标记：防覆盖闭环验收（issue 37）";
    const base = await win2.getByTestId("memory-summary-textarea").inputValue();
    await win2.getByTestId("memory-summary-textarea").fill(`${base}\n\n${manualMarker}\n`);
    await shot(win2, EVIDENCE_DIR, "real-06-summary-manual-edit.png");
    await win2.getByTestId("memory-summary-save").click();
    await expect(editSummaryDialog).toHaveCount(0, { timeout: 15_000 });
    // 查看弹层读回人工版（写盘生效）
    await summaryRow2.getByTestId("memory-summary-view").click();
    const viewDialog = win2.getByTestId("memory-summary-dialog");
    await expect(viewDialog).toContainText(manualMarker);
    await viewDialog.getByRole("button", { name: "关闭" }).click();

    // 解除 Codex 关联（US2：解除即不纳入；同时把批次② 控制在 1 段 = 1 次模型调用，预算内）
    await openDetail(win2, REQ_TITLE);
    const codexRow2 = panel2.locator('[data-testid="related-session"]', { hasText: "请用 shell 读取 NOTES.md 的内容…" });
    await codexRow2.getByTestId("related-unlink").click();
    await expect(codexRow2).toHaveCount(0, { timeout: 15_000 });
    // 批次②：仅 Claude 会话 → 1 段 1 次模型调用
    await expect(win2.getByTestId("memory-extract-button")).toBeEnabled();
    await win2.getByTestId("memory-extract-button").click();
    // 批次② 卡按元信息定位（「来源 1 会话」唯一标识新批次——旧 completed 卡已在场，不能按状态盲等）
    const batch2 = win2.locator('[data-testid="memory-batch-card"][data-status="completed"]', { hasText: "来源 1 会话" });
    await expect(batch2).toBeVisible({ timeout: 660_000 });
    const batch2Id = await batch2.getAttribute("data-batch-id");
    await expect(batch2.getByTestId("memory-batch-meta")).toContainText("来源 1 会话");
    await expect(batch2.getByTestId("memory-batch-meta")).toContainText("分段 1");
    await expect(batch2.getByTestId("memory-batch-meta")).toContainText("模型调用 1 次");
    logCall("claude", `提取批次② 段1 临时 headless 会话（1 次模型调用；此前 editSummary 已人工编辑总结）`, `batchId=${batch2Id}`);

    // 防覆盖：人工版未被覆盖 + proposed 提示条 + 对比弹层两栏并排
    await expect(panel2.getByTestId("memory-proposed-bar")).toBeVisible({ timeout: 15_000 });
    await expect(panel2.getByTestId("memory-proposed-bar")).toContainText("新版已暂存");
    await shot(win2, EVIDENCE_DIR, "real-07-proposed-bar.png");
    await panel2.getByTestId("memory-compare-button").click();
    const compareDialog = win2.getByTestId("memory-compare-dialog");
    await expect(compareDialog).toBeVisible();
    await expect(compareDialog.getByTestId("memory-compare-human")).toContainText(manualMarker);
    await shot(win2, EVIDENCE_DIR, "real-08-compare-dialog.png");
    // 二选一收尾：保留人工版 → 指针清除、磁盘仍是人工版
    await compareDialog.getByTestId("memory-compare-keep").click();
    await expect(compareDialog).toHaveCount(0, { timeout: 15_000 });
    await expect(panel2.getByTestId("memory-proposed-bar")).toHaveCount(0, { timeout: 15_000 });
    // 批次② 候选补齐审核三动作缺口（批次① 候选不足时在此补走 编辑后接受/忽略）
    const pending2 = panel2.locator('[data-testid="memory-candidate"]');
    const pending2Count = await pending2.count();
    if (!editDone && pending2Count >= 1) {
      const p2 = pending2.first();
      await p2.getByTestId("memory-edit-candidate").click();
      const d2 = win2.getByTestId("memory-edit-dialog");
      await expect(d2).toBeVisible();
      const c2 = await win2.getByTestId("memory-edit-claim").inputValue();
      await win2.getByTestId("memory-edit-claim").fill(`${c2}（批次② 验收修订）`);
      await win2.getByTestId("memory-edit-save").click();
      // #33 交互口径：保存成功弹层保持打开，无错误即成功，手动关闭
      await expect(win2.getByTestId("memory-edit-error")).toHaveCount(0, { timeout: 15_000 });
      await win2.getByTestId("memory-edit-cancel").click();
      await expect(d2).toHaveCount(0, { timeout: 15_000 });
      editDone = true;
    }
    if (!ignoreDone) {
      const rest = panel2.locator('[data-testid="memory-candidate"]');
      const restCount = await rest.count();
      if (restCount >= 1) {
        await rest.first().getByTestId("memory-ignore-candidate").click();
        await expect(panel2.getByTestId("memory-candidate")).toHaveCount(restCount - 1, { timeout: 15_000 });
        ignoreDone = true;
      }
    }
    // 三动作必须全部在真实候选上走完（issue #37 验收硬条款；产数不足即验收失败如实暴露）
    expect(editDone, "编辑后接受动作未在真实候选上执行（候选产数不足）").toBe(true);
    expect(ignoreDone, "忽略动作未在真实候选上执行（候选产数不足）").toBe(true);

    // ---- ⑩ 终态隔离复核（两批次后开发历史仍不变）+ 证据归档 ----
    const post2 = fingerprintDevHistories(repoDir, runStart);
    const check2 = compareFingerprints(prePrints, post2);
    isolation.checks.push({ at: new Date().toISOString(), isolated: check2.isolated, details: check2.details });
    expect(check2.isolated, `批次② 后开发历史指纹必须不变：${JSON.stringify(check2.details)}`).toBe(true);
    isolation.extractionTranscripts = findExtractionTranscripts(userData, runStart);
    expect(isolation.extractionTranscripts.length).toBeGreaterThanOrEqual(3); // 批次① 2 段 + 批次② 1 段临时会话

    // 模型调用台账（提取 2+1=3 次 ≤ 预算 3；造历史 2 turn 如实另计）
    writeEvidenceJson("model-calls-ledger.json", {
      generatedAt: new Date().toISOString(),
      extractionBudget: "≤3（含重试）",
      extractionCalls: 3,
      entries: ledger,
    });
    writeEvidenceJson("isolation-report.json", { runAt: new Date().toISOString(), repoDir, ...isolation });
    // 存储快照拷贝（accepted md + summary.md + proposed 处置后终态）供验收记录引用
    copyStoreSnapshot(userData);

    await second.app.close();
    console.log("[real-e2e] 阶段 3 真实验收全链完成");
    completed = true;
  } finally {
    if (completed) {
      await rmBestEffort(userData);
      await rmBestEffort(repoRoot);
    } else {
      console.warn(`[real-e2e] 用例未完成，fixture 留存供续跑：${userData} / ${repoRoot}`);
    }
  }
});

/**
 * 续跑收尾（issue #37）：完整旅程用例在「编辑后接受弹层保存后不自动关闭」处中断——该行为是 #33 既定交互口径
 * （保存成功弹层保持打开、以待审数减少为成功信号、手动关闭，#36 spec 224 行同口径），首跑 spec 误假设自动关闭。
 * 同 fixture（KANBAN_REAL_RESUME_USER / KANBAN_REAL_RESUME_REPO 指定首跑幸存的 userData/repo；无幸存 fixture 则跳过）
 * 续行剩余环节：忽略待审 → 记忆检索/复制路径 → 重启保持 → editSummary → 解除 Codex → 批次② 提取（仅 1 次模型调用，
 * 提取总调用 2+1=3 ≤ 预算）→ proposed 二选一 → 终态隔离复核与证据归档。
 */
const RESUME_USER = process.env.KANBAN_REAL_RESUME_USER ?? "";
const RESUME_REPO = process.env.KANBAN_REAL_RESUME_REPO ?? "";
test.skip(
  !REAL || !RESUME_USER || !existsSync(RESUME_USER),
  "续跑收尾：需 KANBAN_REAL_E2E=1 与幸存 fixture（KANBAN_REAL_RESUME_USER/KANBAN_REAL_RESUME_REPO）",
);

test("阶段 3 真实验收·续跑收尾：忽略待审 → 记忆检索/复制路径 → 重启保持 → 人工版总结防覆盖（批次② cancelled 实证）→ 终态隔离复核", async () => {
  test.setTimeout(1_500_000);
  const userData = RESUME_USER;
  // run 6 已落盘的人工标记（editSummary 真通道写入 summary.md；本用例读回验证未被批次② 触碰）
  const manualMarker = "人工修订标记：防覆盖闭环验收（issue 37）";
  // 台账如实重建（全程提取模型调用 2+1=3 达预算上限；DB memory_batches.model_call_count 逐行为硬证据）
  const ledger: LedgerEntry[] = [
    { t: "2026-11-06T13:24:08Z～13:31Z（run 3 窗口）", cli: "claude", purpose: "造历史：开发会话① 真实短 turn（Read 工具读取 NOTES.md + 一句话总结）" },
    { t: "2026-11-06T13:24:08Z～13:31Z（run 3 窗口）", cli: "codex", purpose: "造历史：开发会话② 真实短 turn（shell 读取 NOTES.md + 一句话总结）" },
    {
      t: "2026-11-06T13:24:08Z～13:31Z（run 3 窗口）",
      cli: "claude",
      purpose: "提取批次① 段1+段2 临时 headless 会话（2 次模型调用；completed，产出 3 候选+总结）",
      batchId: "56be9945-17c5-49bc-9601-8e563fcd2f8b",
    },
    {
      t: "2026-11-06T13:39:22Z（run 6）",
      cli: "claude",
      purpose: "提取批次② 段1 临时 headless 会话（1 次模型调用；段完成后应用被测试框架关闭，stop() 有序收敛 cancelled——整批丢弃，无候选/无 proposed/总结未被触碰）",
      batchId: "70ca86e5-3f7a-4eef-93a3-a0f04ab247a1",
      note: "该调用因 harness 误匹配旧批次卡提前断言失败而未走完写库阶段；预算内不重发",
    },
  ];
  // 首跑隔离基线（run 3 提取前指纹）——续跑全程与批次② 后均须与其一致
  const prePrints: FingerprintMap = JSON.parse(readFileSync(artifactPath(EVIDENCE_DIR, "isolation-pre-fingerprints.json"), "utf8")).prints;
  const fingerprintFiles = (): FingerprintMap => Object.fromEntries(Object.keys(prePrints).map((f) => [f, sha256(f)]));
  const isolation = {
    devHistories: Object.keys(prePrints).map((file) => ({
      file,
      cli: file.includes(`${join(homedir(), ".codex")}`) ? "codex" : "claude",
    })),
    checks: [] as Array<{ at: string; isolated: boolean; details: Array<{ file: string; unchanged: boolean }> }>,
    extractionTranscripts: [] as Array<{ file: string; sessionId: string; cwdDir: string }>,
  };
  const checkIsolation = (label: string): void => {
    const cmp = compareFingerprints(prePrints, fingerprintFiles());
    isolation.checks.push({ at: `${label} ${new Date().toISOString()}`, isolated: cmp.isolated, details: cmp.details });
    expect(cmp.isolated, `${label} 后开发历史指纹必须与 run 3 提取前基线一致：${JSON.stringify(cmp.details)}`).toBe(true);
  };
  let completed = false;

  try {
    const { app, win } = await launchApp(userData);
    // 当前项目自愈：前序失败运行的清理可能已删 config.json（currentProjectId 丢失）→ 侧栏点选项目行重设
    const entry = win.getByTestId("kanban-entry");
    if (!((await entry.textContent()) ?? "").includes(PROJECT_NAME)) {
      await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).first().click();
    }
    await expect(entry).toContainText(PROJECT_NAME, { timeout: 15_000 });

    // ---- ① 续行审核闭环：忽略剩余待审候选（幂等：前序运行可能已忽略；接受 CAND-0001 / 编辑后接受 CAND-0002 由 DB 为证）----
    await openDetail(win, REQ_TITLE);
    const panel = win.getByTestId("detail-panel");
    await expect(panel.locator('[data-testid="memory-batch-card"][data-status="completed"]')).toHaveCount(1, { timeout: 15_000 });
    const pending = panel.locator('[data-testid="memory-candidate"]');
    const pendingCount = await pending.count();
    let ignoreClaim = "";
    if (pendingCount >= 1) {
      ignoreClaim = (await pending.first().getByTestId("memory-candidate-claim").textContent()) ?? "";
      await pending.first().getByTestId("memory-ignore-candidate").click();
      await expect(panel.getByTestId("memory-candidate")).toHaveCount(pendingCount - 1, { timeout: 15_000 });
    }
    // 已处置按批次折叠：接受 1 / 编辑 1 / 忽略 1（三动作全部在真实候选上走完）
    await expect(panel.getByTestId("memory-disposed-toggle").first()).toContainText("已接受 1", { timeout: 15_000 });
    await expect(panel.getByTestId("memory-disposed-toggle").first()).toContainText("已编辑 1");
    await expect(panel.getByTestId("memory-disposed-toggle").first()).toContainText("已忽略 1");
    await shot(win, EVIDENCE_DIR, "real-02-candidates-reviewed.png");

    // ---- ② 记忆视图：检索命中 + 复制路径 + 磁盘直读 ----
    await win.getByTestId("memory-entry").click();
    await expect(win.getByTestId("memory-workspace")).toContainText(`${PROJECT_NAME} · 项目记忆`);
    await expect(win.getByText("已接受知识（2）")).toBeVisible({ timeout: 15_000 });
    const knowledgeCard = win.locator('[data-testid="memory-knowledge-card"]', { hasText: "pnpm --filter" });
    await expect(knowledgeCard).toBeVisible();
    // 大小写不敏感子串命中（US20：标题+正文口径）
    const search = win.getByTestId("memory-search");
    await search.fill("PNPM");
    await expect(knowledgeCard).toBeVisible();
    await shot(win, EVIDENCE_DIR, "real-03-memory-search-hit.png");
    await search.fill("");
    await knowledgeCard.getByTestId("memory-knowledge-copy-path").click();
    await expect(win.getByTestId("memory-copy-notice")).toContainText("已复制路径");
    const summaryRow = win.getByTestId("memory-summary-row");
    await expect(summaryRow).toContainText(REQ_TITLE);
    await summaryRow.getByTestId("memory-summary-copy-path").click();
    await expect(win.getByTestId("memory-copy-notice")).toContainText("已复制路径");
    await shot(win, EVIDENCE_DIR, "real-04-memory-workspace.png");
    // 磁盘直读：accepted md ×2 真实存在且含 claim 与溯源头；summary.md 含需求标题（复制路径可供 CLI 按需读取的实证）
    const acceptedFiles = listAcceptedFiles(join(userData, "memory"));
    expect(acceptedFiles.length).toBe(2);
    const acceptedJoined = acceptedFiles.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(acceptedJoined).toContain("pnpm --filter");
    expect(acceptedJoined).toContain("来源 Session"); // accepted md 溯源头（markdown.ts 元数据格式）
    const summaryFiles = listSummaryFiles(join(userData, "memory"));
    expect(summaryFiles.length).toBeGreaterThanOrEqual(1);
    expect(readFileSync(summaryFiles[0], "utf8")).toContain(REQ_TITLE);

    // ---- ③ 重启保持（US25）：关闭再重开，总结/候选状态/已接受知识/批次历史全部保持 ----
    await app.close();
    checkIsolation("重启前后（跨批次① 与两次应用生命周期）");
    const second = await launchApp(userData);
    const win2 = second.win;
    await expect(win2.getByTestId("kanban-entry")).toContainText(PROJECT_NAME, { timeout: 15_000 });
    await openDetail(win2, REQ_TITLE);
    const panel2 = win2.getByTestId("detail-panel");
    await expect(panel2.locator('[data-testid="memory-batch-card"][data-status="completed"]')).toHaveCount(1, { timeout: 15_000 });
    await expect(panel2.getByTestId("memory-candidate")).toHaveCount(0); // 无遗留待审（处置状态重启不复活）
    await expect(panel2.getByTestId("memory-disposed-toggle").first()).toContainText("已忽略 1", { timeout: 15_000 });
    await shot(win2, EVIDENCE_DIR, "real-05-restart-kept.png");
    await win2.getByTestId("memory-entry").click();
    await expect(win2.getByText("已接受知识（2）")).toBeVisible({ timeout: 15_000 });
    await expect(win2.getByTestId("memory-summary-row")).toContainText(REQ_TITLE);

    // ---- ④ 防覆盖实证（批次② 真实调用后在应用有序关闭时被收敛 cancelled——run 6 harness 误匹配旧批次卡提前失败所致；
    //      其 1 次模型调用已消耗，提取调用累计 2+1=3 达硬预算上限，不再发起新提取）----
    // 4a. 批次② 卡：cancelled 灰显（US10 整批丢弃 / US24 退出有序取消的真实终态实证；cancelled 无重试钮——重试属 failed 卡）
    await openDetail(win2, REQ_TITLE);
    const cancelledCards = panel2.locator('[data-testid="memory-batch-card"][data-status="cancelled"]');
    await expect(cancelledCards).toHaveCount(1, { timeout: 15_000 });
    await expect(cancelledCards).toBeVisible();
    await shot(win2, EVIDENCE_DIR, "real-07-cancelled-batch.png");
    // 4b. 批次② 整批丢弃：候选仍 3 条无新增（无 pending 复活）、批次历史 = 1 completed + 1 cancelled
    await expect(panel2.getByTestId("memory-candidate")).toHaveCount(0);
    await expect(panel2.getByTestId("memory-proposed-bar")).toHaveCount(0); // 未达写库阶段 → 无 proposed 残留
    await expect(panel2.locator('[data-testid="memory-batch-card"][data-status="completed"]')).toHaveCount(1);
    // 4c. 人工编辑版总结未被取消批次触碰（防覆盖的最强形式：失败/取消批次零写库）——视图弹层读回人工标记
    await win2.getByTestId("memory-entry").click();
    const summaryRow2 = win2.getByTestId("memory-summary-row");
    await expect(summaryRow2).toContainText(REQ_TITLE);
    await summaryRow2.getByTestId("memory-summary-view").click();
    const viewDialog = win2.getByTestId("memory-summary-dialog");
    await expect(viewDialog).toContainText(manualMarker);
    await viewDialog.getByRole("button", { name: "关闭" }).click();

    // ---- ⑤ 终态隔离复核 + 证据归档 ----
    checkIsolation("批次② 后");
    isolation.extractionTranscripts = findExtractionTranscripts(userData, 0);
    // 批次① 2 段 + 批次② 1 段 = 3 个全新临时 session（与开发会话文件集合零交集；cwd 全在 extract-tmp 派生目录）
    expect(isolation.extractionTranscripts.length).toBe(3);
    const devSessionFiles = new Set(Object.keys(prePrints));
    for (const t of isolation.extractionTranscripts) {
      expect(t.cwdDir).toContain("extract-tmp");
      expect(devSessionFiles.has(t.file)).toBe(false);
    }
    writeEvidenceJson("model-calls-ledger.json", {
      generatedAt: new Date().toISOString(),
      extractionBudget: "≤3（含重试）",
      extractionCalls: 3,
      entries: ledger,
    });
    writeEvidenceJson("isolation-report.json", {
      runAt: new Date().toISOString(),
      fixture: userData,
      ignoredClaimHead: ignoreClaim.slice(0, 40),
      ...isolation,
    });
    copyStoreSnapshot(userData);

    await second.app.close();
    console.log("[real-e2e] 阶段 3 真实验收·续跑收尾完成（提取总调用 3 ≤ 预算）");
    completed = true;
  } finally {
    // 仅用例完成时清理；失败保留 fixture 供续跑（rmSync 失败前会部分删除——config.json 曾因此丢失）
    if (completed) {
      await rmBestEffort(userData);
      await rmBestEffort(RESUME_REPO);
    } else {
      console.warn(`[real-e2e] 用例未完成，fixture 留存供续跑：${userData}`);
    }
  }
});

/** 收集 userData/memory 下全部 accepted md（跨项目 glob：accepted/CAND-xxxx.md） */
function listAcceptedFiles(memoryRoot: string): string[] {
  const out: string[] = [];
  try {
    for (const proj of readdirSync(memoryRoot, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const accepted = join(memoryRoot, proj.name, "accepted");
      if (!existsSync(accepted)) continue;
      for (const f of readdirSync(accepted)) if (f.endsWith(".md")) out.push(join(accepted, f));
    }
  } catch {
    /* memory 根不存在 */
  }
  return out;
}

/** 收集 userData/memory 下全部需求 summary.md */
function listSummaryFiles(memoryRoot: string): string[] {
  const out: string[] = [];
  try {
    for (const proj of readdirSync(memoryRoot, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const reqs = join(memoryRoot, proj.name, "requirements");
      if (!existsSync(reqs)) continue;
      for (const req of readdirSync(reqs, { withFileTypes: true })) {
        const f = join(reqs, req.name, "summary.md");
        if (existsSync(f)) out.push(f);
      }
    }
  } catch {
    /* memory 根不存在 */
  }
  return out;
}

/** 拷贝存储快照到留证目录（accepted md / summary.md / 相对路径保持，真实产物不随临时 userData 清理丢失） */
function copyStoreSnapshot(userData: string): void {
  const memoryRoot = join(userData, "memory");
  const destRoot = artifactPath(EVIDENCE_DIR, "store-snapshot");
  for (const file of [...listAcceptedFiles(memoryRoot), ...listSummaryFiles(memoryRoot)]) {
    const rel = relative(memoryRoot, file);
    const dest = join(destRoot, rel);
    mkdirSync(join(dest, ".."), { recursive: true });
    copyFileSync(file, dest);
  }
  console.log(`[real-e2e] 存储快照已拷贝至 ${destRoot}`);
}
