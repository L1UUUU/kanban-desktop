// 用途：run-once Job Object 覆盖验证（#29 验收：宿主强杀后一次性进程无孤儿；t0-01 T1 方法的最小自动化形式，KANBAN_E2E=1 + win32 门控）—— 编排：node「宿主」进程按生产 cli-host-client 同款方式起 JobGuard（真实 JOB_GUARD_PS）并 fork「worker」（vite 打包的真实 RunOnceRunner；确认自身入 job 后 spawn 一次性子进程）→ taskkill /F 只杀宿主（无 /T，树杀会掩盖 Job 语义）→ 断言 guard 退出（句柄关）且 worker 与一次性子进程被 OS 全灭
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import { JOB_GUARD_PS } from "../../src/index";

const E2E = process.env.KANBAN_E2E === "1";
const IS_WIN = process.platform === "win32";

/** worker 自查是否已入 job 的 PS 探针（IsProcessInJob；worker 等 guard 完成成员登记后才 spawn 子进程，消除 guard Add-Type 编译期的入 job 竞态） */
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

/** 「宿主」harness：fork worker（node）→ 起 JobGuard（生产 JOB_GUARD_PS，等宿主死亡后退出）→ 落 info 文件 → 保活（角色等价 Electron main） */
const HOST_MJS = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [workerScript, bundleHref, specPath, infoPath, guardScript, probeScript, jobName] = process.argv.slice(2);
const worker = spawn(process.execPath, [workerScript, bundleHref, specPath, probeScript], { stdio: "ignore", windowsHide: true, shell: false, env: { ...process.env } });
const guard = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", guardScript, "-MemberPid", String(worker.pid), "-TargetPid", String(process.pid), "-JobName", jobName], { stdio: "ignore", windowsHide: true, shell: false });
writeFileSync(infoPath, JSON.stringify({ hostPid: process.pid, workerPid: worker.pid, guardPid: guard.pid }), "utf8");
setInterval(() => {}, 60000); // 保活直到被强杀
`;

/** 「worker」harness：轮询确认自身已入 job → 用真实 RunOnceRunner spawn 一次性子进程 → 落 ready 文件 → 保活（角色等价 utilityProcess worker） */
const WORKER_MJS = `
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const [bundleHref, specPath, probeScript] = process.argv.slice(2);
const inJob = () => {
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", probeScript, "-TargetPid_", String(process.pid)], { encoding: "utf8", windowsHide: true });
    return out.includes("INJOB");
  } catch {
    return false;
  }
};
const deadline = Date.now() + 45000;
while (!inJob()) {
  if (Date.now() > deadline) { writeFileSync(specPath + ".probe-error", "not in job after 45s", "utf8"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 1000));
}
const { RunOnceRunner } = await import(bundleHref); // vite 打包的真实执行器（同一 spawn 代码路径）
const { readFileSync } = await import("node:fs");
const runner = new RunOnceRunner();
const p = runner.run(JSON.parse(readFileSync(specPath, "utf8"))); // 一次性子进程：自动继承 job 成员身份
p.catch(() => {}); // 宿主被强杀时本进程随之消亡，结果无人消费
writeFileSync(specPath + ".worker-ready", String(process.pid), "utf8");
setInterval(() => {}, 60000);
`;

describe.skipIf(!E2E || !IS_WIN)("run-once Job Object 覆盖（宿主强杀无孤儿，t0-01 最小形式）", () => {
  let dir = "";
  let pids = { hostPid: 0, workerPid: 0, guardPid: 0 };

  /** 轮询断言（真实进程事件为异步流） */
  async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 200));
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

  /** 强杀兜底（失败路径清理；不走 /T 以免误杀测试进程树） */
  const forceKill = (pid: number): void => {
    if (!alive(pid)) return;
    try {
      spawn("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true, shell: false });
    } catch {
      /* 尽力 */
    }
  };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "kb-runonce-job-"));
    // 1) 真实 RunOnceRunner 打包为可被纯 node harness import 的 ESM（同一 spawn 代码路径）
    await build({
      configFile: false,
      logLevel: "warn",
      build: {
        lib: { entry: path.join(import.meta.dirname, "../../src/host/run-once.ts"), formats: ["es"], fileName: () => "run-once.mjs" },
        outDir: dir,
        rollupOptions: { external: [/^node:/] },
        minify: false,
        emptyOutDir: false,
      },
    });
    // 2) harness 与 guard/probe 脚本落盘
    const hostScript = path.join(dir, "host.mjs");
    const workerScript = path.join(dir, "worker.mjs");
    const guardScript = path.join(dir, "guard.ps1");
    const probeScript = path.join(dir, "probe.ps1");
    const bundleHref = pathToFileURL(path.join(dir, "run-once.mjs")).href;
    writeFileSync(hostScript, HOST_MJS, "utf8");
    writeFileSync(workerScript, WORKER_MJS, "utf8");
    writeFileSync(guardScript, `${JOB_GUARD_PS}\n`, "utf8"); // 生产 guard 脚本（ASCII-only，UTF-8 无 BOM）
    writeFileSync(probeScript, `${JOB_PROBE_PS}\n`, "utf8");
    // 3) 一次性执行 spec（fake CLI：落 pid 后长睡 120s——若 Job 失效将以孤儿形态存活并可被判死）
    const childPidFile = path.join(dir, "child.pid");
    const specPath = path.join(dir, "spec.json");
    const spec = {
      runId: "job-e2e-1",
      cli: "claude", // env KANBAN_CLAUDE_BIN=node.exe → 真实 exe 解析链
      args: [path.join(import.meta.dirname, "../fixtures/fake-cli.mjs"), "hang-with-pid", childPidFile],
      cwd: dir,
    };
    writeFileSync(specPath, JSON.stringify(spec), "utf8");
    // 4) 起「宿主」（detached 独立进程组，与 vitest 生命周期解耦）
    const infoPath = path.join(dir, "info.json");
    const host = spawn(
      process.execPath,
      [hostScript, workerScript, bundleHref, specPath, infoPath, guardScript, probeScript, `kanban-runonce-e2e-${Date.now()}`],
      { stdio: "ignore", detached: true, windowsHide: true, shell: false, env: { ...process.env, KANBAN_CLAUDE_BIN: process.execPath } },
    );
    host.unref();
    // 5) 等 worker 就绪（已入 job 且一次性子进程已 spawn）——宿主/worker/guard/child 四方在场
    await waitFor(() => existsSync(infoPath), 30_000, "宿主 info 文件");
    pids = JSON.parse(readFileSync(infoPath, "utf8")) as typeof pids;
    await waitFor(() => existsSync(`${specPath}.worker-ready`), 60_000, "worker 就绪（入 job 且已 spawn 子进程）");
    await waitFor(() => existsSync(childPidFile), 30_000, "一次性子进程 pid 文件");
    (globalThis as { __childPid?: number }).__childPid = Number(readFileSync(childPidFile, "utf8"));
    // 前置：四方全部存活（否则后续断言无意义）
    expect(alive(pids.hostPid)).toBe(true);
    expect(alive(pids.workerPid)).toBe(true);
    expect(alive(pids.guardPid)).toBe(true);
    expect(alive((globalThis as { __childPid?: number }).__childPid!)).toBe(true);
  }, 180_000);

  afterAll(() => {
    if (!dir) return;
    const childPid = (globalThis as { __childPid?: number }).__childPid ?? 0;
    for (const pid of [pids.hostPid, pids.workerPid, pids.guardPid, childPid]) forceKill(pid);
    for (let i = 0; i < 10; i += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        /* Windows 句柄延迟重试 */
      }
    }
  });

  it("taskkill /F 宿主（无 /T）→ guard 观察宿主死亡退出 → job 句柄关 → worker 与一次性子进程被 OS 全灭（无孤儿）", { timeout: 120_000 }, async () => {
    const childPid = (globalThis as { __childPid?: number }).__childPid ?? 0;
    // 强杀宿主：直连 taskkill.exe、不经 shell、不带 /T（t0-01 同款；树杀会掩盖 Job 语义）
    const kill = spawn("taskkill", ["/F", "/PID", String(pids.hostPid)], { stdio: "ignore", windowsHide: true, shell: false });
    await new Promise<void>((resolve) => kill.on("exit", () => resolve()));
    // 宿主死亡 → guard（WaitForSingleObject 返回）退出 → 句柄关 → OS 终止 job 全部成员（worker + 一次性子进程）
    await waitFor(() => !alive(pids.guardPid), 30_000, "guard 观察宿主死亡后退出");
    await waitFor(() => !alive(pids.workerPid), 30_000, "worker（job 成员）被 OS 终止");
    await waitFor(() => !alive(childPid), 30_000, "一次性子进程（worker 子进程，job 继承成员）被 OS 终止");
    expect(alive(pids.hostPid)).toBe(false);
    expect(alive(pids.workerPid)).toBe(false);
    expect(alive(childPid)).toBe(false);
  });
});
