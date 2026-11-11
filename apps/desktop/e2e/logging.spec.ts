// 用途：日志系统整机验收 E2E（issue #56 / spec #52 验收 1/2/3/7 的 C 类证据）—— 读真实运行产出的 <userData>/logs/*.jsonl：
// 四来源汇聚（main/worker/renderer + CLI stderr run-once）与到达顺序、worker 意外退出 vs 正常停机假阳性回归、E_SCHEMA 入站非法请求、
// KANBAN_LOG_LEVEL 两态与 env 不回写 config、顶栏浮层两项截图 + getLogPath 主文件 + openLogDir、轮转分片合并读。
// 全部 Fake 注入驱动（KANBAN_DISABLE_*；CLI stderr 经 run-once 以 where.exe 假 exe 触发，不真实调用 codex/claude 模型、不设 KANBAN_CODEX_MODEL/KANBAN_REAL_E2E）。
// 多启动文件选取（N17）：按启动横幅 + <pid>（app.evaluate 取真主进程 pid，与文件名 pid 一致）选当前运行文件组，禁止跨启动拼接；
// 分片按 <pid> 前缀合并全部 .1/.2 再按到达顺序读取（M9：分片属同次运行续写）。
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readRunEntries, runPrefixOf, type LogEntry } from "./log-run";
import { shot } from "./helpers/acceptance-artifacts";

const PROJECT_NAME = "kb-logging";

/** 浮层展开态截图归档目录（沿用 stage4 截图惯例：docs/acceptance/ 下按主题建目录） */
const SHOT_DIR = resolve(__dirname, "../../../docs/acceptance/logging");

/** run-once 假 exe：Windows 自带 where.exe，对 claude headless 参数（-p --session-id <uuid>）必然写 stderr 且非零退出（本地化文本不定，断言只认 run-once[ 前缀） */
const FAKE_CLAUDE_EXE = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe");

/** 建隔离 fixture：独立 userData + 伪 git 主仓库目录 */
function makeFixture(): { userData: string; repoDir: string; repoRoot: string } {
  const userData = mkdtempSync(join(tmpdir(), "kb-logging-user-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "kb-logging-repo-"));
  const repoDir = join(repoRoot, PROJECT_NAME);
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  return { userData, repoDir, repoRoot };
}

/** 尽力删除目录：Windows 下 electron/Crashpad 子进程退出有延迟，重试后仍锁则告警放行（日志 appendFileSync 无常驻 fd，清理不被日志文件锁阻塞） */
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

/** 启动应用（Fake 演示链路：真实 CLI 回落 Fake；userData 隔离；extraEnv 透传 KANBAN_LOG_LEVEL / KANBAN_CLAUDE_BIN 等） */
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

/** 真主进程 pid（= 日志文件名 <pid>；app.process().pid 是外层 spawn 进程，与文件名 pid 不一致，实测以 Main 自报为准） */
function mainPid(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => process.pid);
}

/** worker 被外杀后收口 app.close()：事件驱动竞速，谁先到谁收口，不再无条件白等 5s。
 *  Electron utilityProcess 内部 teardown 挂死是平台限制，非产品缺陷（应用侧 CliHostClient.dispose() 已有
 *  3s 超时 + kill 兜底）。close 一发起立即挂双分支接住 reject；5s 兜底 timer 先到即 taskkill /T 强杀整树
 *  （Job guard 随 main 死亡全灭子孙，无孤儿；transport 断开使 close 立即 settle），随后仍 await close settle，
 *  不留悬挂 promise。 */
async function closeAfterWorkerKilled(app: ElectronApplication, pid: number): Promise<void> {
  await new Promise((r) => setTimeout(r, 1000));
  const closing = app.close().then(
    () => "closed" as const,
    () => "closed" as const,
  );
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), 5000);
  });
  const raced = await Promise.race([closing, timeout]);
  if (raced === "timeout") execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "pipe" });
  clearTimeout(timer!);
  await closing; // timer 先到时 close 可能仍未 settle：继续等到收口，杜绝悬挂 promise
}

/** 轮询等待条目出现（fire-and-forget renderer 条目 / 异步提取批次需要等落盘；读档口径见 ./log-run） */
async function waitForEntry(userData: string, pid: number, predicate: (e: LogEntry) => boolean, timeoutMs = 15_000): Promise<LogEntry> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = readRunEntries(userData, pid).find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`等待日志条目超时（userData=${userData} pid=${pid}）`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** 注册项目 + 建首个 Claude（Fake）会话 */
async function registerAndCreate(win: Page): Promise<void> {
  await win.getByRole("button", { name: "＋ 注册", exact: true }).click();
  await expect(win.locator("aside").getByText(PROJECT_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
  await win.locator("aside").getByText(PROJECT_NAME, { exact: true }).hover();
  await win.getByRole("button", { name: "＋", exact: true }).click();
  await win.getByRole("button", { name: "Claude", exact: true }).click();
  // #59 草稿：点 CLI 只开草稿，发出首条消息才创建会话（侧栏行出现）
  await expect(win.getByTestId("draft-hint")).toBeVisible({ timeout: 10_000 });
  await send(win, "首条消息（建立会话）");
  await expect(win.getByText("新会话 · Claude").first()).toBeVisible({ timeout: 10_000 });
}

/** 在 composer 输入并发送 */
async function send(win: Page, text: string): Promise<void> {
  await win.getByPlaceholder("输入消息，/ 开头触发 Skill…").fill(text);
  await win.getByRole("button", { name: "发送 ➤" }).click();
}

/** 经 preload 桥发一条 renderer 日志探针（真 log:write 通道，非 mock） */
async function sendRendererProbe(win: Page, level: "warn" | "debug" | "info", message: string): Promise<void> {
  await win.evaluate(
    ({ lv, msg }) => {
      const api = (window as unknown as { api?: { log: (l: string, s: string, m: string) => void } }).api;
      if (!api) throw new Error("window.api 不可用");
      api.log(lv, "e2e", msg);
    },
    { lv: level, msg: message },
  );
}

test("验收 1：四来源汇聚 —— 同一启动文件含 main/worker/renderer 三 source 与 CLI stderr 条目，按到达顺序排列", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    // KANBAN_CLAUDE_BIN 指 where.exe 假 exe：memory 提取的 run-once（claude headless）spawn 它必然写 stderr（不真实调用模型）
    const { app, win } = await launchApp(userData, repoDir, { KANBAN_CLAUDE_BIN: FAKE_CLAUDE_EXE });
    const pid = await mainPid(app);
    await registerAndCreate(win);

    // 会话跑一个完整 turn（transcript 非空，提取管线才有 chunk 可跑 run-once）
    await send(win, "拆类型");
    await expect(win.getByText("空闲").first()).toBeVisible({ timeout: 30_000 });

    // 经 preload 桥建需求 + 关联会话 + 触发提取 → worker 内 run-once spawn 假 exe → stderr 经 {log} 汇聚 Main
    const extractStarted = await win.evaluate(async () => {
      const api = (window as unknown as {
        api?: {
          invoke: (req: unknown) => Promise<{ ok: boolean; projects?: Array<{ id: string }>; currentProjectId?: string | null }>;
          invokeMemory: (req: unknown) => Promise<{ ok: boolean; reason?: string }>;
        };
      }).api;
      if (!api) throw new Error("window.api 不可用");
      const listed = await api.invoke({ channel: "project:list" });
      const projectId = listed.projects?.find((p) => p.id === listed.currentProjectId)?.id ?? listed.projects?.[0]?.id;
      if (!projectId) throw new Error("无项目");
      const created = (await api.invoke({ channel: "kanban:create", projectId, title: "日志验收需求" })) as { ok: boolean; requirementId: string };
      const sessions = (await api.invoke({ channel: "session:list", projectId })) as { ok: boolean; sessions: Array<{ id: string }> };
      const sessionId = sessions.sessions?.[0]?.id;
      if (!sessionId) throw new Error("无会话");
      const linked = (await api.invoke({ channel: "kanban:link", sessionId, requirementId: created.requirementId })) as { ok: boolean; linked: boolean };
      if (!linked.linked) throw new Error(`关联被拒绝：${JSON.stringify(linked)}`);
      return api.invokeMemory({ channel: "memory:extract", requirementId: created.requirementId });
    });
    expect(extractStarted.ok).toBe(true);

    // renderer 探针（真 log:write 通道 fire-and-forget）
    await sendRendererProbe(win, "warn", "renderer 探针条目");

    // CLI stderr 条目（worker {log} → Main kind=stderr → source=worker/scope=cli-host/level=warn；消息前缀 run-once[cli#runId]）
    const stderrHit = await waitForEntry(userData, pid, (e) => e.source === "worker" && e.scope === "cli-host" && e.message.includes("run-once[claude#"));
    expect(stderrHit.level).toBe("warn");

    await app.close();

    const entries = readRunEntries(userData, pid);
    // 启动横幅严格首条（spec #52 D 节）
    expect(entries[0]?.message).toBe("启动横幅");
    expect(entries[0]?.source).toBe("main");
    expect(entries[0]?.level).toBe("info");
    // 三 source + CLI stderr（Q2：CLI stderr 归 worker，由产生它的执行体归属）
    const sources = new Set(entries.map((e) => e.source));
    expect(sources.has("main")).toBe(true);
    expect(sources.has("worker")).toBe(true);
    expect(sources.has("renderer")).toBe(true);
    expect(entries.some((e) => e.source === "worker" && e.message.includes("run-once[claude#"))).toBe(true);
    // renderer 探针经真桥落盘（source 由 Main 强制）
    expect(entries.some((e) => e.source === "renderer" && e.scope === "e2e" && e.message === "renderer 探针条目")).toBe(true);
    // 每条带 level/scope/ts（Q4），且 ts 非严格递增（文件顺序 = 到达顺序；同毫秒相等）
    for (const e of entries) {
      expect(e.ts).toBeTruthy();
      expect(e.scope).toBeTruthy();
      expect(["error", "warn", "info", "debug"]).toContain(e.level);
    }
    for (let i = 1; i < entries.length; i += 1) expect(entries[i].ts >= entries[i - 1].ts).toBe(true);
    // 正常停机（app.close 走有序退出序列）不得记 worker 意外退出（M2 假阳性回归）
    expect(entries.some((e) => e.message.includes("CliHost worker 意外退出"))).toBe(false);
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("验收回归（Job guard 布防）：真实 utilityProcess 启动后日志无 job-guard 告警", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    const { app } = await launchApp(userData, repoDir);
    const pid = await mainPid(app);
    await waitForEntry(userData, pid, (e) => e.message === "启动横幅");
    // 布防失败告警在启动后 ~1.2s 落盘（实测）；等 3s 稳定覆盖后断言缺席。
    // 回归锚点：Electron 44 utilityProcess.fork() 返回瞬间 pid 尚未就绪，同 tick 读取曾把
    // "-MemberPid undefined" 传给 guard → PS 参数绑定失败 exit 1 → Job 布防从未生效（每次启动告警）。
    // A 类不可达（替身注入时 guard 旁路），force-kill-job B 类用 node 宿主 pid 同步就绪，故本 C 类真实整机为唯一回归位。
    await new Promise((r) => setTimeout(r, 3000));
    await app.close();
    const entries = readRunEntries(userData, pid);
    expect(entries.some((e) => e.message.includes("Job guard"))).toBe(false);
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("验收 2：worker 意外退出留 error（文件含 error 条目，非末条）", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    const { app } = await launchApp(userData, repoDir);
    const pid = await mainPid(app);

    // 枚举 Main 的 node.mojom.NodeService 子进程 = cli-host utilityProcess worker（实验实测唯一）
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} -and $_.CommandLine -like '*node.mojom.NodeService*' } | ForEach-Object { $_.ProcessId }`,
      ],
      { encoding: "utf8" },
    );
    const workerPid = parseInt(out.trim(), 10);
    expect(workerPid).toBeGreaterThan(0);
    execFileSync("taskkill", ["/F", "/PID", String(workerPid)], { stdio: "pipe" });

    const hit = await waitForEntry(userData, pid, (e) => e.message.includes("CliHost worker 意外退出"));
    expect(hit.level).toBe("error");
    expect(hit.source).toBe("main");
    expect(hit.scope).toBe("cli-host");
    await closeAfterWorkerKilled(app, pid);
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("验收 2：IPC 入站非法请求记 E_SCHEMA error（主动发一条非法 channel）", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    const { app, win } = await launchApp(userData, repoDir);
    const pid = await mainPid(app);

    // 非法请求：channel 不在 ipcRequestSchema 判别联合内 → Main safeParse 失败记 error + 返回 ok:false E_SCHEMA
    const rejected = await win.evaluate(async () => {
      const api = (window as unknown as { api?: { invoke: (req: unknown) => Promise<{ ok: boolean; error?: { code: string } }> } }).api;
      if (!api) throw new Error("window.api 不可用");
      return api.invoke({ channel: "session:nuke" });
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe("E_SCHEMA");

    const hit = await waitForEntry(userData, pid, (e) => e.level === "error" && e.scope === "kanban:ipc" && e.message.includes("E_SCHEMA"));
    expect(hit.source).toBe("main");
    await app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("验收 3：KANBAN_LOG_LEVEL 两态 —— debug 生效（debug 条目落盘、横幅记生效级别）、bogus 回退 info（debug 条目被滤）；env 不回写 config.json", async () => {
  // 态 A：debug 覆盖生效
  const a = makeFixture();
  try {
    const { app, win } = await launchApp(a.userData, a.repoDir, { KANBAN_LOG_LEVEL: "debug" });
    const pid = await mainPid(app);
    await sendRendererProbe(win, "debug", "debug 探针（应落盘）");
    const probe = await waitForEntry(a.userData, pid, (e) => e.message === "debug 探针（应落盘）");
    expect(probe.level).toBe("debug");
    expect(probe.source).toBe("renderer");
    await app.close();

    const entries = readRunEntries(a.userData, pid);
    expect(entries[0]?.ctx?.level).toBe("debug"); // 启动横幅记生效级别
    // config.json 不被 env 回写（M11：env 覆盖只进 effectiveLevel，不落 appConfig）
    const config = JSON.parse(readFileSync(join(a.userData, "config.json"), "utf8")) as { logging: { level: string } };
    expect(config.logging.level).toBe("info");
  } finally {
    await rmBestEffort(a.userData);
    await rmBestEffort(a.repoRoot);
  }

  // 态 B：非法值回退 config 级别（info）——debug 探针被过滤，info 探针仍落盘
  const b = makeFixture();
  try {
    const { app, win } = await launchApp(b.userData, b.repoDir, { KANBAN_LOG_LEVEL: "bogus" });
    const pid = await mainPid(app);
    await sendRendererProbe(win, "debug", "debug 探针（应被过滤）");
    await sendRendererProbe(win, "info", "info 探针（应落盘）");
    await waitForEntry(b.userData, pid, (e) => e.message === "info 探针（应落盘）");
    await new Promise((r) => setTimeout(r, 500)); // 给 debug 探针（若有泄漏）留落盘窗口
    await app.close();

    const entries = readRunEntries(b.userData, pid);
    expect(entries.some((e) => e.message === "debug 探针（应被过滤）")).toBe(false); // 级别过滤生效
    expect(entries.some((e) => e.message === "info 探针（应落盘）")).toBe(true);
    expect(entries[0]?.ctx?.level).toBe("info"); // 回退后横幅仍记 info
    const config = JSON.parse(readFileSync(join(b.userData, "config.json"), "utf8")) as { logging: { level: string } };
    expect(config.logging.level).toBe("info");
  } finally {
    await rmBestEffort(b.userData);
    await rmBestEffort(b.repoRoot);
  }
});

test("验收 7：浮层两项展开态截图 + getLogPath 返回含横幅主文件 + openLogDir 定位主文件", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    const { app, win } = await launchApp(userData, repoDir);
    const pid = await mainPid(app);

    // 顶栏「设置」点击 → 浮层含且仅含两项（spec #52 H 节：不新增其它入口）
    await win.getByRole("button", { name: "设置", exact: true }).click();
    await expect(win.getByRole("button", { name: "打开日志文件", exact: true })).toBeVisible();
    await expect(win.getByRole("button", { name: "复制日志文件路径", exact: true })).toBeVisible();
    await shot(win, SHOT_DIR, "01-settings-log-popover.png");

    // getLogPath：主文件（无分片后缀）、存在于盘、首条为启动横幅
    const logPath = await win.evaluate(async () => {
      const api = (window as unknown as { api?: { getLogPath: () => Promise<string> } }).api;
      if (!api) throw new Error("window.api 不可用");
      return api.getLogPath();
    });
    expect(logPath).toBe(join(userData, "logs", `${runPrefixOf(readdirSync(join(userData, "logs")), pid)}.jsonl`));
    expect(/^[0-9]{8}-[0-9]{6}-\d+\.jsonl$/.test(logPath.split(/[\\/]/).pop() ?? "")).toBe(true);
    const firstLine = readFileSync(logPath, "utf8").split("\n", 1)[0];
    expect((JSON.parse(firstLine) as LogEntry).message).toBe("启动横幅");

    // openLogDir：invoke 成功（Main 侧 shell.showItemInFolder 传主文件，在资源管理器中定位/选中）
    const opened = await win.evaluate(async () => {
      const api = (window as unknown as { api?: { openLogDir: () => Promise<void> } }).api;
      if (!api) throw new Error("window.api 不可用");
      await api.openLogDir();
      return true;
    });
    expect(opened).toBe(true);

    await app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});

test("验收 1/7：轮转分片 —— 超上限切 .1 续写、getLogPath 仍指主文件、分片合并读不丢条目", async () => {
  const { userData, repoDir, repoRoot } = makeFixture();
  try {
    // 预写小上限（防御下限 1024 之上）触发轮转
    writeFileSync(join(userData, "config.json"), JSON.stringify({ logging: { maxFileBytes: 2048 } }), "utf8");
    const { app, win } = await launchApp(userData, repoDir);
    const pid = await mainPid(app);

    // 逐条发大探针（每条行 ~700B）：累计超 2048B 切 .1；序号用于合并读的到达顺序断言
    const PROBES = 5;
    for (let i = 1; i <= PROBES; i += 1) {
      await sendRendererProbe(win, "info", `rotation-probe-${i}-${"x".repeat(600)}`);
    }
    // 等最后一条落盘（.1 已产生）
    await waitForEntry(userData, pid, (e) => e.message.startsWith(`rotation-probe-${PROBES}-`));

    // 分片产生且同属本启动组（<pid> 前缀）
    const logsDir = join(userData, "logs");
    const names = readdirSync(logsDir);
    expect(names.some((n) => new RegExp(`^\\d{8}-\\d{6}-${pid}\\.jsonl$`).test(n))).toBe(true);
    const slice1 = names.find((n) => new RegExp(`^\\d{8}-\\d{6}-${pid}\\.jsonl\\.1$`).test(n));
    expect(slice1).toBeTruthy();

    // getLogPath 仍返回主文件（M9：对外路径恒指含横幅主文件，分片不对外）
    const logPath = await win.evaluate(async () => {
      const api = (window as unknown as { api?: { getLogPath: () => Promise<string> } }).api;
      if (!api) throw new Error("window.api 不可用");
      return api.getLogPath();
    });
    expect(logPath.endsWith(".jsonl")).toBe(true);
    expect(logPath.endsWith(".jsonl.1")).toBe(false);

    // 合并读：主 + .1 全部条目中探针按发送顺序出现（到达顺序；不丢落在 .1 的条目）
    const merged = readRunEntries(userData, pid);
    const positions = [1, 2, 3, 4, 5].map((i) => merged.findIndex((e) => e.message.startsWith(`rotation-probe-${i}-`)));
    for (const p of positions) expect(p).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < positions.length; i += 1) expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    expect(merged[0]?.message).toBe("启动横幅"); // 主文件首条仍是横幅

    await app.close();
  } finally {
    await rmBestEffort(userData);
    await rmBestEffort(repoRoot);
  }
});
