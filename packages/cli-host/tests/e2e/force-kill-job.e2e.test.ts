// 用途：强杀实证门控 e2e（#45 / spec #40 US23）—— 真实拉起 ≥2 个 CLI 会话（Claude ×1 + OpenCode server-per-project ×2，零 token：不发 turn）→ taskkill /F 只杀宿主（无 /T，树杀会掩盖 Job 语义）→ 断言 Job Object（KILL_ON_JOB_CLOSE）兜底终止全部 CLI 子孙进程、无孤儿。编排对齐 run-once-job 先例：node「宿主」+ 生产 JOB_GUARD_PS guard + 真实 CliHost worker（vite 打包生产 Adapter）。
// 已知限制（spec #40 D3 非目标）：PTY 子树不在覆盖范围——PTY 由 node-pty 在 Electron Main spawn、无 Job Object 绑定；本测试只覆盖 CliHost worker 内 spawn 的结构化 CLI 子孙。实证记录见 docs/acceptance/stage4/job-object-kill-evidence.md。
// 成本说明：Claude 会话仅 spawn + initialize 握手（不发 turn），OpenCode 仅 server 拉起 + POST /session（无模型调用），全程零 token；不经 codex（无需 KANBAN_CODEX_MODEL）。
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import { JOB_GUARD_PS } from "../../src/index";

const E2E = process.env.KANBAN_E2E === "1";
const IS_WIN = process.platform === "win32";

/** worker 自查是否已入 job 的 PS 探针（IsProcessInJob；worker 等 guard 完成成员登记后才 spawn CLI 子进程，消除 guard Add-Type 编译期的入 job 竞态） */
const JOB_PROBE_PS = [
  "param([int]$TargetPid_)",
  "$src = @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class JobProbe {",
  "  [DllImport(\"kernel32.dll\", SetLastError = true)] public static extern IntPtr OpenProcess(uint a, bool i, int p);",
  "  [DllImport(\"kernel32.dll\", SetLastError = true)] public static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool r);",
  "}",
  "'@",
  "Add-Type -TypeDefinition $src",
  "$p = [JobProbe]::OpenProcess(0x1000, $false, $TargetPid_)",
  "$r = $false",
  "if ($p -ne [IntPtr]::Zero) { [void][JobProbe]::IsProcessInJob($p, [IntPtr]::Zero, [ref]$r) }",
  "if ($r) { 'INJOB' } else { 'NOJOB' }",
].join("\n");

/** 按名查询 Job Object 的 PS 探针：LimitFlags（KILL_ON_JOB_CLOSE 是否布防）+ 成员 pid 清单（JobObjectBasicProcessIdList）——机制级实证：与运行环境自身的 job 无关，只看我方命名 job */
const JOB_QUERY_PS = [
  "param([string]$JobName_)",
  "$src = @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class JobQueryNative {",
  "  [DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr OpenJobObject(uint a, bool i, string n);",
  "  [DllImport(\"kernel32.dll\", SetLastError = true)] public static extern bool QueryInformationJobObject(IntPtr h, int c, byte[] i, int cb, out uint rl);",
  "}",
  "'@",
  "Add-Type -TypeDefinition $src",
  "$job = [JobQueryNative]::OpenJobObject(4, $false, $JobName_)", // JOB_OBJECT_QUERY（0x4；0x1 是 ASSIGN_PROCESS，查询会 err=5）
  "if ($job -eq [IntPtr]::Zero) { Write-Output 'NOTFOUND'; exit }",
  "$buf = New-Object byte[] 64",
  "$rl = [uint32]0",
  "if (-not [JobQueryNative]::QueryInformationJobObject($job, 2, $buf, 64, [ref]$rl)) { Write-Output 'QFAIL-LIMIT'; exit }", // JobObjectBasicLimitInformation
  "$flags = [BitConverter]::ToUInt32($buf, 16)", // LimitFlags 第 3 字段（两个 LARGE_INTEGER 之后；x64 偏移 16）
  "$buf2 = New-Object byte[] 8192",
  "if (-not [JobQueryNative]::QueryInformationJobObject($job, 3, $buf2, 8192, [ref]$rl)) { Write-Output 'QFAIL-PIDS'; exit }", // JobObjectBasicProcessIdList
  "$n = [BitConverter]::ToUInt32($buf2, 4)",
  "$pids = @()",
  "for ($i = 0; $i -lt $n; $i++) { $pids += [BitConverter]::ToUInt64($buf2, 8 + $i * 8) }",
  "Write-Output ('FLAGS=0x{0:X} PIDS={1}' -f $flags, ($pids -join ','))",
].join("\n");

/** 「宿主」harness：fork worker（node）→ 起 JobGuard（生产 JOB_GUARD_PS，等宿主死亡后退出）→ 落 info 文件 → 保活（角色等价 Electron main：worker 入 job，guard 持句柄观察 main） */
const HOST_MJS = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [workerScript, bundleHref, specPath, infoPath, guardScript, probeScript, jobName] = process.argv.slice(2);
const worker = spawn(process.execPath, [workerScript, bundleHref, specPath, probeScript], { stdio: "ignore", windowsHide: true, shell: false, env: { ...process.env } });
const guard = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", guardScript, "-MemberPid", String(worker.pid), "-TargetPid", String(process.pid), "-JobName", jobName], { stdio: "ignore", windowsHide: true, shell: false });
writeFileSync(infoPath, JSON.stringify({ hostPid: process.pid, workerPid: worker.pid, guardPid: guard.pid }), "utf8");
setInterval(() => {}, 60000); // 保活直到被强杀
`;

/** 「worker」harness：轮询确认自身已入 job → 真实 CliHost 建三会话（生产 Adapter；worker 内 spawn 的 CLI 进程自动入 job）→ 落 ready 文件 → 保活（角色等价 utilityProcess worker） */
const WORKER_MJS = `
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const [bundleHref, specPath, probeScript] = process.argv.slice(2);
const log = (m) => { try { appendFileSync(specPath + ".log", new Date().toISOString() + " " + m + "\\n", "utf8"); } catch {} };
const fail = (msg) => { try { writeFileSync(specPath + ".error", String(msg), "utf8"); } catch {} process.exit(1); };
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
try {
  log("worker start pid=" + process.pid);
  const inJob = () => {
    try {
      const out = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", probeScript, "-TargetPid_", String(process.pid)], { encoding: "utf8", windowsHide: true });
      return out.includes("INJOB");
    } catch { return false; }
  };
  const deadline = Date.now() + 45000;
  while (!inJob()) {
    if (Date.now() > deadline) fail("not in job after 45s"); // fail 内 process.exit（ESM 顶层不可 return）
    await new Promise((r) => setTimeout(r, 1000));
  }
  log("in job confirmed");
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const { CliHost, ClaudeAdapter, OpenCodeAdapter, FakeAdapter } = await import(bundleHref); // vite 打包的生产实现（同一 spawn 代码路径）
  log("bundle imported");
  const factory = (cli) =>
    cli === "claude" ? new ClaudeAdapter({ hookDir: spec.hookDir }) // hookDir 定位 --settings 路径 → CIM marker 可见
      : cli === "opencode" ? new OpenCodeAdapter({ registryPath: spec.registryPath, xdgRoot: spec.xdgRoot }) // 注册表落 server pid/port 台账
      : new FakeAdapter(); // 其余 CLI 不在编排内（AdapterRouter 构造期会对全 CLI 求能力合并，不能返回 null）
  const host = new CliHost(factory);
  const mk = (cli, cwd) => host.command({ kind: "createSession", payload: { cli, cwd } });
  const s1 = await mk("claude", spec.claudeCwd);
  log("claude session " + s1.sessionId);
  const s2 = await mk("opencode", spec.ocCwdA);
  log("opencode session A " + s2.sessionId);
  const s3 = await mk("opencode", spec.ocCwdB);
  log("opencode session B " + s3.sessionId);
  writeFileSync(specPath + ".ready", JSON.stringify({ workerPid: process.pid, sessions: [
    { cli: "claude", sessionId: s1.sessionId },
    { cli: "opencode", sessionId: s2.sessionId },
    { cli: "opencode", sessionId: s3.sessionId },
  ] }), "utf8");
  setInterval(() => {}, 60000); // 保活直到 Job Object 兜底终止
} catch (e) { fail(e && e.stack ? e.stack : String(e)); }
`;

/** CIM 进程记录（Win32_Process 快照；强杀前后清单对照的数据面） */
interface ProcRecord {
  pid: number;
  ppid: number;
  name: string;
  cmd: string;
}

/** OS 句柄级进程快照：全量 Win32_Process（PID/PPID/Name/CommandLine） */
function snapshotProcesses(): ProcRecord[] {
  const out = spawnSyncText(
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
  );
  if (!out) return [];
  const raw = JSON.parse(out) as Array<Record<string, unknown>> | Record<string, unknown>;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((r) => ({
    pid: Number(r.ProcessId),
    ppid: Number(r.ParentProcessId),
    name: String(r.Name ?? ""),
    cmd: String(r.CommandLine ?? ""),
  }));
}

/** 同步执行 PowerShell 并返回 stdout（trim；失败返回空串） */
function spawnSyncText(ps: string): string {
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  } catch {
    return "";
  }
}

/** 求快照中 rootPid 的全部严格后代（Windows 不重挂父：孤儿的 ParentProcessId 仍指向已死 worker，可被抓获） */
function descendantsOf(procs: ProcRecord[], rootPid: number): ProcRecord[] {
  const hit = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of procs) {
      if (p.pid !== rootPid && !hit.has(p.pid) && (p.ppid === rootPid || hit.has(p.ppid))) {
        hit.add(p.pid);
        changed = true;
      }
    }
  }
  return procs.filter((p) => hit.has(p.pid));
}

describe.skipIf(!E2E || !IS_WIN)("强杀实证：taskkill /F 宿主 → Job Object 兜底全灭 CLI 子孙进程（无孤儿，US23）", () => {
  let dir = "";
  let jobName = "";
  let queryScript = "";
  let markers: string[] = [];
  let pids = { hostPid: 0, workerPid: 0, guardPid: 0 };
  let cliPids: number[] = [];
  let cleanupPids: number[] = []; // 强杀前 worker 全部后代（含无 marker 的孙进程；清理期 /T 树杀的锚点）

  /** 轮询断言（真实进程事件为异步流） */
  async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`等待超时（${timeoutMs}ms）：${what}`);
  }

  const alive = (pid: number): boolean => {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** marker 进程计数（lifecycle.spec countMarkerProcesses 同款语义；marker = 测试根目录名 + opencode --port，宿主/worker/guard/claude(--settings)/opencode 全命中） */
  const countMarkerProcesses = (): number => snapshotProcesses().filter((p) => markers.some((m) => p.cmd.includes(m))).length;

  /** 按名查询我方 Job Object：null = 名字已消失（job 已销毁）；否则返回 LimitFlags 与成员 pid 清单 */
  const queryJob = (): { flags: number; pids: number[] } | null => {
    const out = spawnSyncText(
      `& '${queryScript.replace(/'/g, "''")}' -JobName_ '${jobName.replace(/'/g, "''")}'`,
    );
    if (!out || out.includes("NOTFOUND") || out.includes("QFAIL")) return null;
    const m = /^FLAGS=0x([0-9A-Fa-f]+) PIDS=([\d,]*)$/.exec(out.trim());
    if (!m) return null;
    return {
      flags: parseInt(m[1], 16),
      pids: m[2] ? m[2].split(",").map(Number) : [],
    };
  };

  beforeAll(async () => {
    // 1) 隔离根目录：所有 harness 脚本、CLI cwd、hook 目录、OpenCode XDG/注册表都在其下 → 根目录名即全局 marker
    dir = mkdtempSync(path.join(tmpdir(), "kb-fkjob-"));
    markers = [path.basename(dir)];
    const hookDir = path.join(dir, "hooks");
    const claudeCwd = path.join(dir, "claude-cwd");
    const ocCwdA = path.join(dir, "oc-a");
    const ocCwdB = path.join(dir, "oc-b");
    const xdgRoot = path.join(dir, "xdg");
    for (const d of [hookDir, claudeCwd, ocCwdA, ocCwdB, xdgRoot]) mkdirSync(d, { recursive: true });
    const registryPath = path.join(dir, "opencode-servers.json");
    // 2) 生产 cli-host 打包为可被纯 node harness import 的 ESM（CliHost + 三真实 Adapter 同一 spawn 代码路径）
    await build({
      configFile: false,
      logLevel: "warn",
      build: {
        lib: { entry: path.join(import.meta.dirname, "../../src/index.ts"), formats: ["es"], fileName: () => "cli-host.mjs" },
        outDir: dir,
        rollupOptions: { external: [/^node:/] },
        minify: false,
        emptyOutDir: false,
      },
    });
    // 3) harness 与 guard/probe/query 脚本落盘
    const hostScript = path.join(dir, "host.mjs");
    const workerScript = path.join(dir, "worker.mjs");
    const guardScript = path.join(dir, "guard.ps1");
    const probeScript = path.join(dir, "probe.ps1");
    queryScript = path.join(dir, "query.ps1");
    const bundleHref = pathToFileURL(path.join(dir, "cli-host.mjs")).href;
    writeFileSync(hostScript, HOST_MJS, "utf8");
    writeFileSync(workerScript, WORKER_MJS, "utf8");
    writeFileSync(guardScript, `${JOB_GUARD_PS}\n`, "utf8"); // 生产 guard 脚本（ASCII-only，UTF-8 无 BOM）
    writeFileSync(probeScript, `${JOB_PROBE_PS}\n`, "utf8");
    writeFileSync(queryScript, `${JOB_QUERY_PS}\n`, "utf8");
    // 4) worker 会话编排 spec（Claude ×1 + OpenCode server-per-project ×2：两 cwd → 两独立 server 进程，最暴露孤儿面）
    const specPath = path.join(dir, "spec.json");
    writeFileSync(
      specPath,
      JSON.stringify({ hookDir, claudeCwd, ocCwdA, ocCwdB, registryPath, xdgRoot }),
      "utf8",
    );
    // 5) 起「宿主」（detached 独立进程组，与 vitest 生命周期解耦）
    const infoPath = path.join(dir, "info.json");
    jobName = `kanban-fkjob-e2e-${Date.now()}`;
    const host = spawn(
      process.execPath,
      [hostScript, workerScript, bundleHref, specPath, infoPath, guardScript, probeScript, jobName],
      { stdio: "ignore", detached: true, windowsHide: true, shell: false, env: { ...process.env } },
    );
    host.unref();
    // 6) 等三方就绪：宿主 info → worker ready（已入 job 且三会话已建）
    await waitFor(() => existsSync(infoPath), 30_000, "宿主 info 文件");
    pids = JSON.parse(readFileSync(infoPath, "utf8")) as typeof pids;
    await waitFor(() => existsSync(`${specPath}.ready`) || existsSync(`${specPath}.error`), 120_000, "worker 就绪（入 job 且三会话已建）");
    if (existsSync(`${specPath}.error`)) {
      throw new Error(`worker 编排失败：${readFileSync(`${specPath}.error`, "utf8")}`);
    }
    const ready = JSON.parse(readFileSync(`${specPath}.ready`, "utf8")) as { workerPid: number; sessions: Array<{ cli: string; sessionId: string }> };
    expect(ready.sessions.filter((s) => s.cli === "opencode")).toHaveLength(2);
    expect(ready.sessions.filter((s) => s.cli === "claude")).toHaveLength(1);
    // 7) OpenCode 注册表台账：两项目各一条 server 记录（pid + port）——port 入 marker 集
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { entries: Array<{ cwd: string; pid: number; port: number }> };
    const ocEntries = registry.entries.filter((e) => e.cwd === ocCwdA || e.cwd === ocCwdB);
    expect(ocEntries).toHaveLength(2);
    for (const e of ocEntries) markers.push(`--port ${e.port}`);
    // 8) 强杀前进程清单（证据面）：worker 后代含 claude（--settings）与两个 opencode server；marker 全量命中宿主/guard/worker/CLI
    const beforeShot = snapshotProcesses();
    const beforeDesc = descendantsOf(beforeShot, pids.workerPid);
    const claudeDesc = beforeDesc.filter((p) => p.cmd.includes("--settings"));
    expect(claudeDesc.length).toBeGreaterThanOrEqual(1);
    for (const e of ocEntries) {
      expect(beforeDesc.some((p) => p.pid === e.pid)).toBe(true);
    }
    expect(beforeDesc.length).toBeGreaterThanOrEqual(3);
    cliPids = [...claudeDesc.map((p) => p.pid), ...ocEntries.map((e) => e.pid)];
    cleanupPids = beforeDesc.map((p) => p.pid);
    // 前置：宿主/guard/worker 与全部 CLI 子孙在场（否则后续断言无意义）
    expect(alive(pids.hostPid)).toBe(true);
    expect(alive(pids.workerPid)).toBe(true);
    expect(alive(pids.guardPid)).toBe(true);
    for (const pid of cliPids) expect(alive(pid)).toBe(true);
    expect(countMarkerProcesses()).toBeGreaterThanOrEqual(3 + cliPids.length); // 宿主+guard+worker（cmdline 含根目录名）+ 全部 CLI 子孙（claude --settings / opencode --port）
    // 机制级实证（与运行环境自身 job 无关，只看我方命名 job）：KILL_ON_JOB_CLOSE 已布防 + worker 与全部 CLI 子孙均为我方 job 成员
    const jobInfo = queryJob();
    expect(jobInfo, `命名 job ${jobName} 应存在（guard 创建并持有）`).not.toBeNull();
    expect(jobInfo!.flags & 0x2000, `KILL_ON_JOB_CLOSE 应已布防（实际 LimitFlags=0x${jobInfo!.flags.toString(16)}）`).toBe(0x2000);
    for (const pid of [pids.workerPid, ...cliPids]) {
      expect(jobInfo!.pids, `pid=${pid} 应为我方 job 成员`).toContain(pid);
    }
    console.log(`[fkjob] 我方 job ${jobName}：LimitFlags=0x${jobInfo!.flags.toString(16)}（含 KILL_ON_JOB_CLOSE），成员 ${jobInfo!.pids.length} 个（含 worker + 全部 CLI 子孙）`);
    console.log(
      `[fkjob] 强杀前进程清单（worker=${pids.workerPid} 后代 ${beforeDesc.length} 个；marker 命中 ${countMarkerProcesses()}）：\n` +
        beforeDesc.map((p) => `  pid=${p.pid} ppid=${p.ppid} name=${p.name} cmd=${p.cmd.slice(0, 160)}`).join("\n"),
    );
  }, 240_000);

  afterAll(() => {
    if (!dir) return;
    // 兜底清理（同步执行防 vitest 退出竞态）：已知 pid（含强杀前全部后代，/T 连带无 marker 的孙进程）+ marker 快照补漏（beforeAll 早期失败时 pids 缺位的宿主/guard 也按根目录名命中）
    const targets = new Set<number>([pids.hostPid, pids.workerPid, pids.guardPid, ...cliPids, ...cleanupPids]);
    for (const p of snapshotProcesses()) {
      if (markers.some((m) => p.cmd.includes(m))) targets.add(p.pid);
    }
    for (const pid of targets) {
      if (!pid || !alive(pid)) continue;
      try {
        execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
      } catch {
        /* 尽力 */
      }
    }
    for (let i = 0; i < 10; i += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        /* Windows 句柄延迟重试 */
      }
    }
  });

  it("taskkill /F 宿主（无 /T）→ guard 退出 → Job Object 兜底终止 worker 与全部 CLI 子孙进程（CIM 清单归零）", { timeout: 120_000 }, async () => {
    // 强杀宿主：直连 taskkill.exe、不经 shell、不带 /T（树杀会掩盖 Job 语义）
    const kill = spawn("taskkill", ["/F", "/PID", String(pids.hostPid)], { stdio: "ignore", windowsHide: true, shell: false });
    await new Promise<void>((resolve, reject) => {
      kill.on("exit", () => resolve());
      kill.on("error", (e) => reject(new Error(`taskkill 失败：${e.message}`)));
    });
    // 宿主死亡 → guard（WaitForSingleObject 返回）退出 → job 句柄关 → OS 终止 job 全部成员（worker + CLI 子孙）
    await waitFor(() => !alive(pids.guardPid), 30_000, "guard 观察宿主死亡后退出");
    // 命名 job 随 guard 退出销毁（名字消失）——兜底机制由我方 job 触发的直接证据，与运行环境自身 job 无关
    await waitFor(() => queryJob() === null, 30_000, "命名 job 随 guard 退出销毁（名字消失）");
    await waitFor(() => !alive(pids.workerPid), 30_000, "worker（job 成员）被 OS 终止");
    for (const pid of cliPids) {
      await waitFor(() => !alive(pid), 30_000, `CLI 子孙 pid=${pid} 被 OS 终止`);
    }
    // 无孤儿（清单级双口径）：worker 后代树归零（含 cmdline 无 marker 的孙子进程）+ marker 进程归零
    await expect
      .poll(() => descendantsOf(snapshotProcesses(), pids.workerPid).length, { timeout: 60_000, interval: 1000 })
      .toBe(0);
    await expect
      .poll(() => countMarkerProcesses(), { timeout: 30_000, interval: 1000 })
      .toBe(0);
    expect(alive(pids.hostPid)).toBe(false);
    expect(alive(pids.workerPid)).toBe(false);
    for (const pid of cliPids) expect(alive(pid)).toBe(false);
    console.log(`[fkjob] 强杀后进程清单：worker 后代 0 个，marker 命中 0 个（强杀前 ${cliPids.length} 个 CLI 子孙 + 宿主/guard/worker 全部消失）`);
  });
});
