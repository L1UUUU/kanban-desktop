// 用途：打包形态（NSIS 安装后 / 便携版 / win-unpacked）验收驱动 —— CDP 连接打包应用做功能冒烟与生命周期复验（退出无孤儿 marker 断言 + 重开恢复）；
// 用法 node packaged-smoke.cjs <exePath> [标签] [smoke|lifecycle]（缺省 smoke）
"use strict";

const { spawn, execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const exePath = process.argv[2];
const label = process.argv[3] || path.basename(exePath);
const mode = process.argv[4] || "smoke";
const CDP_PORT = Number(process.env.SMOKE_CDP_PORT || 9333);
const LIFECYCLE_MARKER = "kb-pkg-orphan-marker-3d";

if (!exePath || !existsSync(exePath)) {
  console.error("用法: node packaged-smoke.cjs <exePath> [标签] [smoke|lifecycle]");
  process.exit(2);
}

function fail(msg) {
  console.error(`[SMOKE-FAIL] ${msg}`);
  process.exit(1);
}

/** 进程计数：命令行含 marker 的存活进程（排除查询进程自身） */
function countMarkerProcesses() {
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${LIFECYCLE_MARKER}*' -and $_.ProcessId -ne $PID }).Count`],
      { encoding: "utf8" },
    ).trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : -1;
  } catch {
    return -1;
  }
}

/** 子进程存活数量：ParentProcessId 链上同 exe 名的子进程（utilityProcess fork 出的即此类） */
function childProcessCount(pid) {
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `@(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} -and $_.Name -like '*Kanban*' }).Count`],
      { encoding: "utf8" },
    ).trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : -1;
  } catch {
    return -1;
  }
}

/** 启动打包应用并等待 CDP 就绪；返回 child/browser/page 与收尾器 */
async function launchAppOnce(userData, repoDir, cdpPort) {
  const logFile = path.join(tmpdir(), `kb-smoke-${label}-${cdpPort}.log`);
  const logStream = require("node:fs").createWriteStream(logFile);
  const child = spawn(exePath, [`--remote-debugging-port=${cdpPort}`], {
    env: {
      ...process.env,
      KANBAN_USER_DATA: userData,
      KANBAN_TEST_PICK_DIRECTORY: repoDir,
      KANBAN_DISABLE_CODEX: "1",
      KANBAN_DISABLE_CLAUDE: "1",
      KANBAN_DISABLE_OPENCODE: "1",
      ELECTRON_ENABLE_LOGGING: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  let logs = "";
  const collect = (chunk) => (logs += chunk.toString("utf8"));
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  let version = null;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      if (res.ok) {
        version = await res.json();
        break;
      }
    } catch {}
    if (child.exitCode !== null) fail(`应用进程提前退出 code=${child.exitCode}（日志 ${logFile}）`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!version) fail(`CDP 60s 未就绪（日志 ${logFile}）`);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  // /json/version 就绪早于窗口目标注册（重启场景实测 ~1s 差）：轮询等页面出现，避免竞态性「未找到窗口页面」
  let page = null;
  for (let i = 0; i < 15 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages())[0] ?? null;
    if (!page) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!page) fail("未找到窗口页面");
  await page.waitForLoadState("domcontentloaded");
  return {
    child,
    browser,
    page,
    logs,
    /** 正常退出（renderer window.close → 有序退出序列），返回退出码或超时标记 */
    async closeAndWaitExit(timeoutMs = 30_000) {
      await this.page.evaluate(() => window.close());
      const code = await new Promise((resolve) => {
        const t = setTimeout(() => resolve("timeout"), timeoutMs);
        child.on("exit", (c) => { clearTimeout(t); resolve(c); });
      });
      await browser.close().catch(() => {});
      return code;
    },
    async kill() {
      if (child.exitCode === null) child.kill();
      await browser.close().catch(() => {});
    },
  };
}

/** 注册项目并等待项目行可见 */
async function registerProject(page) {
  await page.getByRole("button", { name: "＋ 注册", exact: true }).click();
  await page.locator("aside").getByText("smoke-repo", { exact: true }).waitFor({ timeout: 15_000 });
}

/** 建 Fake 会话并发送一轮，等待终文与回空闲 */
async function runFakeTurn(page, text) {
  await page.getByPlaceholder("输入消息，/ 开头触发 Skill…").fill(text);
  await page.getByRole("button", { name: "发送 ➤" }).click();
  await page.getByText("好的，我先跑一遍现有测试确认基线，然后开始拆分。").waitFor({ timeout: 30_000 });
  await page.getByText("空闲").first().waitFor({ timeout: 20_000 });
}

/** 功能冒烟：注册 → Fake 会话全链 → worker/PTY/userData/退出核验 */
async function smoke() {
  const userData = mkdtempSync(path.join(tmpdir(), "kb-smoke-user-"));
  const repoRoot = mkdtempSync(path.join(tmpdir(), "kb-smoke-repo-"));
  const repoDir = path.join(repoRoot, "smoke-repo");
  mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  const app = await launchAppOnce(userData, repoDir, CDP_PORT);
  try {
    const { page } = app;
    await registerProject(page);

    await page.locator("aside").getByText("smoke-repo", { exact: true }).hover();
    await page.getByRole("button", { name: "＋", exact: true }).click();
    await page.getByRole("button", { name: "Claude", exact: true }).click();
    // #59 草稿：点 CLI 只开草稿；首条消息（runFakeTurn 首轮）触发「创建+落库+发送」→ 会话行出现
    await runFakeTurn(page, "拆类型");
    await page.getByText("新会话 · Claude").first().waitFor({ timeout: 10_000 });
    await page.getByText("完成 · 3.6s").waitFor({ timeout: 30_000 });
    console.log("[smoke] Fake 会话全链 OK（多轮流式 + 工具卡终态 + 回空闲）");

    const kids = childProcessCount(app.child.pid);
    console.log(`[smoke] 子进程（utilityProcess 候选）数量=${kids}`);

    const created = await page.evaluate(async ({ cwd }) => {
      const api = window.api;
      if (!api) throw new Error("window.api 不可用");
      // #60：terminalId 由调用方预生成（uuid 同格式）
      return api.invoke({ channel: "terminal:create", terminalId: crypto.randomUUID(), cwd, command: { exe: "powershell.exe", args: ["-NoProfile", "-Command", "Write-Output pty-ok"] } });
    }, { cwd: repoDir });
    if (!created || created.ok !== true) fail(`terminal:create 失败: ${JSON.stringify(created)}`);
    console.log("[smoke] PTY 创建 OK（node-pty 自 asar.unpacked 加载）");

    for (const f of ["config.json", "kanban.db"]) {
      if (!existsSync(path.join(userData, f))) fail(`userData 缺 ${f}`);
    }
    console.log("[smoke] userData 落盘 OK（config.json + kanban.db）");

    console.log(`[smoke] utilityProcess 回退告警=${app.logs.includes("utilityProcess 托管不可用") ? "出现（已回退进程内）" : "未出现"}`);

    const exitCode = await app.closeAndWaitExit();
    if (exitCode === "timeout") fail("正常退出 30s 未结束（挂起）");
    console.log(`[smoke] 正常退出 OK（exit=${exitCode}）`);
  } finally {
    await app.kill();
  }
  console.log(`[SMOKE-PASS] ${label}`);
}

/** 生命周期复验（#14）：退出无孤儿（OS 句柄级 marker）+ 重开恢复（断开会话恢复可续聊） */
async function lifecycle() {
  const userData = mkdtempSync(path.join(tmpdir(), "kb-life-user-"));
  const repoRoot = mkdtempSync(path.join(tmpdir(), "kb-life-repo-"));
  const repoDir = path.join(repoRoot, "smoke-repo");
  mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  try {
    // 第一段：会话完整 turn + 带 marker 的长驻 PTY 子进程 → 正常退出 → marker 全消（无孤儿）
    const first = await launchAppOnce(userData, repoDir, CDP_PORT);
    await registerProject(first.page);
    await first.page.locator("aside").getByText("smoke-repo", { exact: true }).hover();
    await first.page.getByRole("button", { name: "＋", exact: true }).click();
    await first.page.getByRole("button", { name: "Claude", exact: true }).click();
    // #59 草稿：首条消息触发创建（runFakeTurn 首轮）→ 会话行出现
    await runFakeTurn(first.page, "拆类型");
    await first.page.getByText("新会话 · Claude").first().waitFor({ timeout: 10_000 });

    const created = await first.page.evaluate(async ({ cwd, marker }) => {
      const api = window.api;
      if (!api) throw new Error("window.api 不可用");
      // #60：terminalId 由调用方预生成（uuid 同格式）
      return api.invoke({ channel: "terminal:create", terminalId: crypto.randomUUID(), cwd, command: { exe: "powershell.exe", args: ["-NoProfile", "-Command", `Write-Output ${marker}; Start-Sleep -Seconds 120`] } });
    }, { cwd: repoDir, marker: LIFECYCLE_MARKER });
    if (!created || created.ok !== true) fail(`terminal:create 失败: ${JSON.stringify(created)}`);
    for (let i = 0; i < 15; i++) {
      if (countMarkerProcesses() >= 1) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const before = countMarkerProcesses();
    if (before < 1) fail(`marker 进程未见（count=${before}）`);
    console.log(`[lifecycle] marker 子进程在场 count=${before}`);

    const exitCode = await first.closeAndWaitExit();
    if (exitCode === "timeout") fail("正常退出 30s 未结束（挂起）");
    let after = -1;
    for (let i = 0; i < 15; i++) {
      after = countMarkerProcesses();
      if (after === 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (after !== 0) fail(`退出后 marker 孤儿残留 count=${after}`);
    console.log(`[lifecycle] 正常退出无孤儿 OK（exit=${exitCode}, marker 0/${before}）`);

    // 第二段：同 userData 重开 → 断开会话「读取原生历史并恢复」→ 空闲可续聊
    const second = await launchAppOnce(userData, repoDir, CDP_PORT + 1);
    try {
      await second.page.getByText("已断开").first().waitFor({ timeout: 15_000 });
      await second.page.getByText("新会话 · Claude").first().click();
      // #42 起恢复条文案为「📴 会话「title」来自上次运行（CLI 已退出）。缓存消息不替代原生历史。」——此处取无前缀子串
      await second.page.getByText("来自上次运行（CLI 已退出）。缓存消息不替代原生历史。").waitFor({ timeout: 10_000 });
      await second.page.getByRole("button", { name: "读取原生历史并恢复" }).click();
      await second.page.getByText("空闲").first().waitFor({ timeout: 15_000 });
      await runFakeTurn(second.page, "中断后继续");
      console.log("[lifecycle] 重开恢复 OK（断开 → 恢复 → 续聊完成）");
      const exit2 = await second.closeAndWaitExit();
      if (exit2 === "timeout") fail("第二次退出 30s 未结束（挂起）");
    } finally {
      await second.kill();
    }
  } finally {
    for (let i = 0; i < 10; i++) {
      try { rmSync(userData, { recursive: true, force: true }); rmSync(repoRoot, { recursive: true, force: true }); break; } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log(`[SMOKE-PASS] ${label} lifecycle`);
}

(mode === "lifecycle" ? lifecycle() : smoke()).catch((e) => fail(e && e.stack ? e.stack : String(e)));
