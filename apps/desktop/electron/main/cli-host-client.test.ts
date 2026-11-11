// 用途：CliHostClient 密封测试（#54 / spec #52 B/F/G 节 + issue #73）—— fork 注入替身 proc，覆盖 {log} 消息分派顺序（先于事件/无 id 分支）、Logger 未就绪不抛错、pending 白名单摘要（含 init.cli、不含 stdin 正文）、命令失败 error、worker 意外退出 error 与 exit 汇总一条、正常停机/超时强杀不误报；buildWorkerEnv 纯函数（env 显式化：base 打底保留/config 覆盖/不突变 base）
import { describe, expect, it, vi } from "vitest";

// node 测试环境无 Electron 运行时：桩掉 utilityProcess（测试一律经 fork 注入替身，真实 fork 分支不触达）
vi.mock("electron", () => ({
  utilityProcess: {
    fork: (): never => {
      throw new Error("测试必须注入 fork 替身");
    },
  },
}));

// Job guard 断言用：若替身形态误拉起 guard，spawn 可观察（真实 child_process 不在本测试图内使用）
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { buildWorkerEnv, CliHostClient, type UtilityProcessLike } from "./cli-host-client";

/** 记录型替身 proc：捕获 postMessage/kill 与 message/exit/spawn 监听器，供测试按消息协议驱动 */
class FakeProc implements UtilityProcessLike {
  readonly posted: unknown[] = [];
  readonly messageListeners: Array<(msg: unknown) => void> = [];
  readonly exitListeners: Array<(code: number, signal?: string | null) => void> = [];
  readonly spawnListeners: Array<() => void> = [];
  killCalls = 0;
  readonly pid = 4321;
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  on(event: "message" | "exit" | "spawn", listener: (...args: never[]) => void): void {
    if (event === "message") this.messageListeners.push(listener as unknown as (msg: unknown) => void);
    else if (event === "exit") this.exitListeners.push(listener as unknown as (code: number, signal?: string | null) => void);
    else this.spawnListeners.push(listener as unknown as () => void);
  }
  kill(): void {
    this.killCalls++;
  }
  /** 测试驱动：模拟 worker 发来一条消息 */
  emitWorkerMessage(msg: unknown): void {
    for (const l of this.messageListeners) l(msg);
  }
  /** 测试驱动：模拟 worker 进程退出 */
  emitExit(code: number, signal?: string | null): void {
    for (const l of this.exitListeners) l(code, signal);
  }
}

interface Bench {
  proc: FakeProc;
  client: CliHostClient;
  logKinds: Array<[string, string]>;
  workerLogs: Array<[string, string]>;
}

/** 组装被测 client：注入 fork 替身 + 收集 2 参 log / onWorkerLog 回调（withWorkerLog=false 模拟 Logger 未就绪） */
function bench(withWorkerLog = true, fullDisposeWaitMs?: number): Bench {
  const proc = new FakeProc();
  const logKinds: Array<[string, string]> = [];
  const workerLogs: Array<[string, string]> = [];
  const client = new CliHostClient({
    workerPath: "unused-with-fake-fork",
    dataDir: "unused",
    ...(fullDisposeWaitMs !== undefined ? { fullDisposeWaitMs } : {}),
    fork: () => proc,
    log: (kind, detail) => logKinds.push([kind, detail]),
    ...(withWorkerLog ? { onWorkerLog: (kind: string, detail: string) => workerLogs.push([kind, detail]) } : {}),
  });
  return { proc, client, logKinds, workerLogs };
}

describe("CliHostClient {log} 分派（#54 spec #52 B 节）", () => {
  it("{log} 消息分派给 onWorkerLog（判别位于事件分支与无 id 分支之前——否则将被静默丢弃）", () => {
    const b = bench();
    b.proc.emitWorkerMessage({ log: { kind: "stderr", detail: "boom" } });
    b.proc.emitWorkerMessage({ log: { kind: "brand-new-kind", detail: "d" } });
    expect(b.workerLogs).toEqual([
      ["stderr", "boom"],
      ["brand-new-kind", "d"],
    ]);
  });

  it("既有通道不受影响：事件仍进 handlers、命令响应仍按 id 结算", async () => {
    const b = bench();
    const events: unknown[] = [];
    b.client.subscribe((e) => events.push(e));
    b.proc.emitWorkerMessage({ event: { type: "session_status" } });
    expect(events.length).toBe(1);
    const p = b.client.readHistory("s1");
    const posted = b.proc.posted[0] as { id: number };
    b.proc.emitWorkerMessage({ id: posted.id, ok: true, result: [] }); // issue #73：返回值直传（readHistory 即 ChatEvent[]）
    expect(await p).toEqual([]);
  });

  it("Logger 未就绪（未注入 onWorkerLog）：{log} 消息不抛错、不影响后续命令往返", async () => {
    const b = bench(false);
    expect(() => b.proc.emitWorkerMessage({ log: { kind: "dead", detail: "x" } })).not.toThrow();
    const p = b.client.resume("s1");
    const posted = b.proc.posted[0] as { id: number };
    b.proc.emitWorkerMessage({ id: posted.id, ok: true, result: undefined }); // issue #73：void 方法返回值直传 undefined
    await expect(p).resolves.toBeUndefined();
  });

  it("注入 fork 替身时不拉起 Job guard powershell（Job Object 只绑真实 utilityProcess）", () => {
    bench();
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });
});

describe("CliHostClient 命令失败与白名单摘要（#54 spec #52 G 节 M5）", () => {
  it("命令失败记一条 command-failed：detail 含错误码与白名单摘要（createSession 的 init.cli 计入 cli）", async () => {
    const b = bench();
    const p = b.client.createSession({ cwd: "C:\\w", cli: "claude" });
    const posted = b.proc.posted[0] as { id: number };
    b.proc.emitWorkerMessage({ id: posted.id, ok: false, error: { code: "E_SPAWN_NOT_FOUND", message: "no exe" } });
    await expect(p).rejects.toMatchObject({ code: "E_SPAWN_NOT_FOUND" });
    const failures = b.logKinds.filter(([k]) => k === "command-failed");
    expect(failures.length).toBe(1);
    expect(failures[0][1]).toContain("E_SPAWN_NOT_FOUND");
    expect(failures[0][1]).toContain("kind=createSession cli=claude");
  });

  it("摘要不含正文：sendTurn 的 text 与 run-once 的 stdin 均不进日志（Q8/M5）", async () => {
    const b = bench();
    const p = b.client.sendTurn({ sessionId: "s9", text: "SECRET-TURN-TEXT" });
    void b.client.runOnce({ runId: "r1", cli: "claude", args: [], cwd: "C:\\w", stdin: "SECRET-RUN-STDIN" });
    const first = b.proc.posted[0] as { id: number };
    b.proc.emitWorkerMessage({ id: first.id, ok: false, error: { code: "E_INTERNAL", message: "x" } });
    await expect(p).rejects.toThrow();
    const text = b.logKinds.filter(([k]) => k === "command-failed").map(([, d]) => d).join("\n");
    expect(text).toContain("kind=sendTurn sessionId=s9");
    expect(text).not.toContain("SECRET-TURN-TEXT");
    expect(text).not.toContain("SECRET-RUN-STDIN");
  });

  it("全部命令形状经 command() 单入口后摘要提取不丢字段（白名单键各就各位）", () => {
    const b = bench();
    // 命令均在途被 exit 批量 reject：吞掉 rejection（本用例只观察汇总日志，拒绝语义由意外退出用例覆盖）
    b.client.listChildPids().catch(() => {});
    b.client.cancelRunOnce("rc").catch(() => {});
    b.client.runOnce({ runId: "rr", cli: "claude", args: ["a"], cwd: "C:\\w", stdin: "S" }).catch(() => {});
    b.client.adoptSession({ sessionId: "sa", nativeSessionId: "n1", cwd: "C:\\w", cli: "codex" }).catch(() => {});
    b.proc.emitExit(1);
    const detail = b.logKinds.find(([k]) => k === "worker-exit")?.[1] ?? "";
    expect(detail).toContain("kind=listChildPids");
    expect(detail).toContain("kind=cancelRunOnce runId=rc");
    expect(detail).toContain("kind=runOnce cli=claude runId=rr");
    expect(detail).toContain("kind=adoptSession sessionId=sa cli=codex");
  });
});

describe("buildWorkerEnv（issue #73 env 显式化）", () => {
  it("base 打底全保留：用户/测试手设 env（KANBAN_DISABLE_*、KANBAN_CODEX_MODEL 等）逐键继承；config 有值时叠加覆盖用户手设（与旧 process.env 突变语义一致）", () => {
    const env = buildWorkerEnv(
      { dataDir: "C:\\ud", codexExe: "C:\\cx.exe" },
      { PATH: "p1", KANBAN_DISABLE_CLAUDE: "1", KANBAN_CODEX_MODEL: "gpt-6-luna", KANBAN_CODEX_BIN: "user-set" },
    );
    expect(env).toEqual({
      PATH: "p1",
      KANBAN_DISABLE_CLAUDE: "1",
      KANBAN_CODEX_MODEL: "gpt-6-luna",
      KANBAN_CODEX_BIN: "C:\\cx.exe",
      KANBAN_DATA_DIR: "C:\\ud",
    });
  });

  it("config 缺省（null/undefined/空串）不写对应 _BIN：用户手设值不被清空", () => {
    const env = buildWorkerEnv(
      { dataDir: "C:\\ud", codexExe: null, claudeExe: undefined, opencodeExe: "" },
      { KANBAN_CLAUDE_BIN: "user-claude" },
    );
    expect(env).toEqual({ KANBAN_CLAUDE_BIN: "user-claude", KANBAN_DATA_DIR: "C:\\ud" });
  });

  it("纯函数不突变 base：Main 进程 env 保持干净（residue 枚举只剩 manualOverride 单路）", () => {
    const base: NodeJS.ProcessEnv = { KANBAN_CODEX_BIN: "user-set" };
    buildWorkerEnv({ dataDir: "C:\\ud", codexExe: "C:\\cx.exe" }, base);
    expect(base).toEqual({ KANBAN_CODEX_BIN: "user-set" });
  });
});

describe("CliHostClient worker 退出处置（#54 spec #52 F 节 M2）", () => {
  it("意外退出（非零码）：记一条 worker-exit error；pending 全部 reject 且汇总进同一条（不刷屏）", async () => {
    const b = bench();
    const p1 = b.client.readHistory("s1");
    const p2 = b.client.runOnce({ runId: "r1", cli: "codex", args: [], cwd: "C:\\w" });
    b.proc.emitExit(1);
    await expect(p1).rejects.toThrow("已退出");
    await expect(p2).rejects.toThrow("已退出");
    const exitLogs = b.logKinds.filter(([k]) => k === "worker-exit" || k === "worker-exit-pending");
    expect(exitLogs.length).toBe(1); // 汇总一条，不逐条刷屏
    expect(exitLogs[0][0]).toBe("worker-exit");
    expect(exitLogs[0][1]).toContain("code=1");
    expect(exitLogs[0][1]).toContain("kind=readHistory sessionId=s1");
    expect(exitLogs[0][1]).toContain("kind=runOnce cli=codex runId=r1");
  });

  it("由信号终止（code 0 + signal）同样记意外退出", () => {
    const b = bench();
    b.proc.emitExit(0, "SIGTERM");
    expect(b.logKinds.some(([k]) => k === "worker-exit")).toBe(true);
  });

  it("正常停机不误报：dispose() 发 {shutdown} 后 exit 0 → 无 worker-exit error，kill 兜底仍执行", async () => {
    const b = bench();
    const disposeP = b.client.dispose();
    expect(b.proc.posted.some((m) => (m as { shutdown?: unknown }).shutdown !== undefined)).toBe(true);
    b.proc.emitExit(0);
    await disposeP;
    expect(b.proc.killCalls).toBe(1);
    expect(b.logKinds.some(([k]) => k === "worker-exit")).toBe(false);
  });

  it("有序停机超时后的无条件强杀不误报（M2）：kill 引发非零退出仍不记 error", async () => {
    const b = bench(true, 30);
    const disposeP = b.client.dispose();
    await disposeP; // 替身不退出 → fullDisposeWaitMs 超时路径收口并 kill
    expect(b.proc.killCalls).toBe(1);
    b.proc.emitExit(1); // 强杀导致的非零退出
    expect(b.logKinds.some(([k]) => k === "worker-exit")).toBe(false);
  });

  it("停机时残留 pending：汇总一条 worker-exit-pending（warn 级由 Main 映射），不误报崩溃", async () => {
    const b = bench();
    b.client.readHistory("s1").catch(() => {}); // 停机时仍在途的命令（exit 时被批量 reject，本用例只观察汇总）
    const disposeP = b.client.dispose();
    b.proc.emitExit(0);
    await disposeP;
    const pendingLogs = b.logKinds.filter(([k]) => k === "worker-exit-pending");
    expect(pendingLogs.length).toBe(1);
    expect(pendingLogs[0][1]).toContain("kind=readHistory sessionId=s1");
    expect(b.logKinds.some(([k]) => k === "worker-exit")).toBe(false);
  });

  it("意外退出无 pending：仅记退出本身，不产生空汇总条目", () => {
    const b = bench();
    b.proc.emitExit(3);
    expect(b.logKinds.filter(([k]) => k === "worker-exit").length).toBe(1);
    expect(b.logKinds.some(([k]) => k === "worker-exit-pending")).toBe(false);
  });
});
