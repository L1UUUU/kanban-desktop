// 用途：RunOnceRunner 契约测试（#29 C5 演进）—— fake node CLI 直连（KANBAN_CLAUDE_BIN 指向 node.exe，走 resolveClaudeExe 真实解析链）覆盖四分支（正常输出/非零退出/超时/取消）及缺省超时、stdin 透传、重复 runId、未知 cli、CliHost 命令路由与 shutdown 处置
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_RUN_ONCE_TIMEOUT_MS, RunOnceRunner, type RunOnceResult } from "./run-once";

/** fake CLI 绝对路径（node.exe 直连 spawn；经 env KANBAN_CLAUDE_BIN 注入 claude 解析链） */
const FAKE_CLI = path.join(import.meta.dirname, "../../tests/fixtures/fake-cli.mjs");
const nodeRun = (behavior: string, ...rest: string[]): string[] => [FAKE_CLI, behavior, ...rest];

/** 轮询等待文件出现（子进程已启动的确定性信号；setImmediate 轮询不受 fake timers 影响） */
async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`等待文件超时：${file}`);
}

/** 轮询等待 pid 消亡（进程级终止断言；Windows 无僵尸态） */
async function waitPidGone(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`等待进程退出超时：pid=${pid}`);
}

describe("RunOnceRunner（C5 演进 run-once）", () => {
  let cwd: string;

  beforeAll(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "kb-runonce-"));
    // exe 解析链 env 分支 → node.exe（真实 exe 直连不经 shell；与 CliHostClient 传参方式一致）
    process.env.KANBAN_CLAUDE_BIN = process.execPath;
  });

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
    delete process.env.KANBAN_CLAUDE_BIN;
  });

  it("正常输出：exit 0 → status=completed，stdout/stderr 回传", async () => {
    const runner = new RunOnceRunner();
    const r = await runner.run({ runId: "r-ok", cli: "claude", args: nodeRun("ok", "M1"), cwd });
    expect(r.status).toBe("completed");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("fake-out:M1");
    expect(r.stderr).toContain("fake-err:M1");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("非零退出：exit 3 → status=failed，exitCode/stdout/stderr 如实回传", async () => {
    const runner = new RunOnceRunner();
    const r = await runner.run({ runId: "r-fail", cli: "claude", args: nodeRun("fail", "M2"), cwd });
    expect(r.status).toBe("failed");
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toContain("partial:M2");
    expect(r.stderr).toContain("boom:M2");
  });

  it("超时：timeoutMs 到点终止子进程 → status=timeout，无残留进程", { timeout: 20_000 }, async () => {
    const runner = new RunOnceRunner();
    const pidFile = path.join(cwd, "timeout.pid");
    const t0 = Date.now();
    const r = await runner.run({ runId: "r-to", cli: "claude", args: nodeRun("hang-with-pid", pidFile), cwd, timeoutMs: 500 });
    // 终结明显早于子进程自身 120s 睡眠；hang 行为无输出，stdout 为空
    expect(r.status).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r.stdout).toBe("");
    await waitPidGone(Number(readFileSync(pidFile, "utf8")));
  });

  it("取消：进行中 cancel → status=cancelled 快速终结；未知 runId no-op 返回 false", { timeout: 20_000 }, async () => {
    const runner = new RunOnceRunner();
    const pidFile = path.join(cwd, "cancel.pid");
    const p = runner.run({ runId: "r-cancel", cli: "claude", args: nodeRun("hang-with-pid", pidFile), cwd });
    await waitForFile(pidFile); // 子进程确已启动再取消
    expect(runner.cancel("r-cancel")).toBe(true);
    const r = await p;
    expect(r.status).toBe("cancelled");
    await waitPidGone(Number(readFileSync(pidFile, "utf8")));
    expect(runner.cancel("nope")).toBe(false);
  });

  it("缺省 timeoutMs：默认 300s（假时钟推进 299_999ms 不终结，到点归 timeout）", { timeout: 20_000 }, async () => {
    // 只伪造 setTimeout/clearTimeout：子进程 spawn/exit 与轮询不受影响
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const runner = new RunOnceRunner();
      const pidFile = path.join(cwd, "default.pid");
      let settled: RunOnceResult | undefined;
      const p = runner.run({ runId: "r-def", cli: "claude", args: nodeRun("hang-with-pid", pidFile), cwd }).then((r) => {
        settled = r;
        return r;
      });
      await waitForFile(pidFile);
      expect(DEFAULT_RUN_ONCE_TIMEOUT_MS).toBe(300_000);
      await vi.advanceTimersByTimeAsync(DEFAULT_RUN_ONCE_TIMEOUT_MS - 1);
      expect(settled).toBeUndefined(); // 未到点不得终结
      await vi.advanceTimersByTimeAsync(1);
      vi.useRealTimers();
      const r = await p; // kill 已触发，等真实 exit/close 事件
      expect(r.status).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stdin 透传：prompt 写入子进程 stdin 后关闭（poc-5 提取形态）", async () => {
    const runner = new RunOnceRunner();
    const r = await runner.run({ runId: "r-stdin", cli: "claude", args: nodeRun("echo-stdin"), cwd, stdin: "只回复：OK" });
    expect(r.status).toBe("completed");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("stdin:只回复：OK");
  });

  it("重复 runId：进行中同名执行直接拒绝（E_INTERNAL）", { timeout: 20_000 }, async () => {
    const runner = new RunOnceRunner();
    const pidFile = path.join(cwd, "dup.pid");
    const p = runner.run({ runId: "r-dup", cli: "claude", args: nodeRun("hang-with-pid", pidFile), cwd });
    await waitForFile(pidFile);
    await expect(runner.run({ runId: "r-dup", cli: "claude", args: nodeRun("ok"), cwd })).rejects.toMatchObject({ code: "E_INTERNAL" });
    runner.cancel("r-dup");
    expect((await p).status).toBe("cancelled");
  });

  it("未知 cli：明确报错并列出支持的 CLI", async () => {
    const runner = new RunOnceRunner();
    await expect(runner.run({ runId: "r-x", cli: "unknown-cli", args: [], cwd })).rejects.toMatchObject({
      code: "E_INTERNAL",
      message: expect.stringContaining("claude"),
    });
  });
});
