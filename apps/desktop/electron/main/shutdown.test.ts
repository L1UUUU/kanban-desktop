// 用途：统一退出序列与重开恢复编排单测（#13/spec H）—— 状态机顺序（拒新→有序取消→有限等待→Session 粒度 dispose→全量 dispose→PTY 停止）、幂等、有限等待超时放行、异常不阻断退出；启动收养登记与 PTY 断开落库
import { describe, expect, it } from "vitest";
import type { AdoptSessionInput, AdapterEvent, ChatEvent, CliAdapter, DisposeInput } from "@kanban/cli-host";
import { AdapterError } from "@kanban/cli-host";
import { openDatabase } from "./db";
import { SessionStore, type SessionRecord } from "./session-store";
import { adoptRestoredSessions, createShutdownOrchestrator } from "./shutdown";
import type { PtyHost } from "./pty-host";

/** 记录型 fake adapter：interruptTurn/dispose(含单会话)记录调用；可选钩子模拟事件落库/失败 */
function makeFakeAdapter(hooks: { onInterrupt?: (id: string) => void; failInterrupt?: boolean } = {}) {
  const calls: string[] = [];
  const adopted: AdoptSessionInput[] = [];
  const adapter: CliAdapter = {
    capabilities: { approval: true, interrupt: true, resume: true, readHistory: true, skillSignal: false },
    createSession: async () => {
      throw new Error("测试不使用");
    },
    sendTurn: async () => {},
    interruptTurn: async (id) => {
      calls.push(`interrupt:${id}`);
      if (hooks.failInterrupt) throw new AdapterError("E_INTERNAL", "模拟中断失败");
      hooks.onInterrupt?.(id);
    },
    resolveApproval: async () => {},
    readHistory: async () => [] as ChatEvent[],
    resume: async () => {},
    adoptSession: async (input) => {
      adopted.push(input);
    },
    dispose: async (input?: DisposeInput) => {
      calls.push(input?.sessionId ? `dispose-one:${input.sessionId}` : "dispose-all");
    },
    subscribe: () => () => {},
  };
  return { adapter, calls, adopted };
}

/** fake PTY：记录 killAll */
function makePty() {
  const killed: string[] = [];
  const pty: PtyHost = {
    spawn: () => ({ ok: true, label: "x", shell: "x", cwd: "x" }),
    write: () => ({ ok: true }),
    resize: () => undefined,
    kill: (id) => {
      killed.push(id);
    },
    isRunning: () => false,
    killAll: () => {
      killed.push("*");
    },
  };
  return { pty, killed };
}

/** 内存库 + 会话行工厂 */
function makeSessions(rows: Partial<SessionRecord>[]): SessionStore {
  const db = openDatabase(":memory:");
  const store = new SessionStore(db);
  for (const r of rows) {
    store.insert({
      id: r.id ?? `s-${Math.random().toString(36).slice(2, 8)}`,
      kind: r.kind ?? "structured",
      cli: r.cli ?? "fake",
      nativeSessionId: r.nativeSessionId ?? null,
      projectId: null,
      title: r.title ?? "t",
      cwd: r.cwd ?? "C:\\demo",
      permMode: r.permMode ?? null,
      status: r.status ?? "idle",
      lastActiveAt: null,
    });
  }
  return store;
}

describe("统一退出序列（spec H §6.1）", () => {
  it("完整顺序：拒新+通知 → 活跃会话有序取消 → 等待落定 → Session 粒度 dispose → 全量 dispose → PTY 全停", async () => {
    const sessions = makeSessions([
      { id: "s-run", status: "running", nativeSessionId: "n1" },
      { id: "s-wait", status: "waiting", nativeSessionId: "n2" },
      { id: "s-idle", status: "idle", nativeSessionId: "n3" },
      { id: "s-disc", status: "disconnected", nativeSessionId: "n4" },
      { id: "s-pty", kind: "pty", cli: "pty", status: "idle" },
    ]);
    // 中断即落定（模拟 turn_interrupted → session_status 落库）
    const { adapter, calls } = makeFakeAdapter({ onInterrupt: (id) => sessions.updateStatus(id, "interrupted") });
    const { pty, killed } = makePty();
    const notices: string[] = [];
    const orch = createShutdownOrchestrator({
      adapter,
      pty,
      sessions,
      graceMs: 1000,
      notifyShutdown: (r) => notices.push(r),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    expect(orch.isShuttingDown()).toBe(false);
    await orch.begin("app-quit");
    // 1. 拒新 + UI 提示
    expect(orch.isShuttingDown()).toBe(true);
    expect(notices).toEqual(["app-quit"]);
    // 2. 有序取消：仅 running/waiting 两个结构化会话
    expect(calls.filter((c) => c.startsWith("interrupt:")).sort()).toEqual(["interrupt:s-run", "interrupt:s-wait"]);
    // 4. Session 粒度受控终止：interrupted/idle 会话逐个 dispose（disconnected/PTY 不在列）
    expect(calls.filter((c) => c.startsWith("dispose-one:")).sort()).toEqual(["dispose-one:s-idle", "dispose-one:s-run", "dispose-one:s-wait"]);
    // 5+6. 全量 dispose + PTY 全停（顺序在全量 dispose 之后）
    expect(calls.at(-1)).toBe("dispose-all");
    expect(killed).toEqual(["*"]);
  });

  it("有限等待超时放行：会话不落定时最长等待 graceMs 后仍走受控终止（不无限阻塞退出）", async () => {
    const sessions = makeSessions([{ id: "s-stuck", status: "running" }]);
    const { adapter, calls } = makeFakeAdapter(); // 不模拟落定：永远 running
    const { pty } = makePty();
    let slept = 0;
    const orch = createShutdownOrchestrator({
      adapter,
      pty,
      sessions,
      graceMs: 120,
      notifyShutdown: () => {},
      sleep: async (ms) => {
        slept += ms;
      }, // 立即返回：循环由 deadline 驱动退出
    });
    const t0 = Date.now();
    await orch.begin("quit");
    expect(Date.now() - t0).toBeLessThan(2000); // 快速收敛（deadline 到即出循环）
    expect(slept).toBeGreaterThan(0);
    expect(calls).toContain("dispose-one:s-stuck"); // 超时后仍受控终止
    expect(calls).toContain("dispose-all");
  });

  it("幂等：并发/重复 begin 只跑一次序列；interrupt 失败不阻断（best-effort）", async () => {
    const sessions = makeSessions([{ id: "s-run", status: "running" }]);
    const { adapter, calls } = makeFakeAdapter({ failInterrupt: true });
    const { pty } = makePty();
    const orch = createShutdownOrchestrator({
      adapter,
      pty,
      sessions,
      graceMs: 50,
      notifyShutdown: () => {},
      sleep: async () => {},
    });
    await Promise.all([orch.begin("a"), orch.begin("b")]);
    await orch.begin("c");
    expect(calls.filter((c) => c === "dispose-all").length).toBe(1); // 单次序列
    expect(calls).toContain("dispose-one:s-run"); // interrupt 失败仍受控终止
  });
});

describe("重开恢复编排（#13）", () => {
  it("启动收养：全部结构化会话（含上次已断开）adoptSession（DB id/native id/cwd/cli 透传）并落库断开；PTY 不收养但统一断开——二次重启后断开会话仍可恢复", async () => {
    const sessions = makeSessions([
      { id: "s-live", cli: "codex", nativeSessionId: "th-1", status: "running", permMode: "auto" },
      { id: "s-null-native", cli: "fake", nativeSessionId: null, status: "idle" },
      { id: "s-already", cli: "claude", nativeSessionId: "cl-1", status: "disconnected" },
      { id: "s-pty", kind: "pty", cli: "pty", status: "idle" },
    ]);
    const { adapter, adopted } = makeFakeAdapter();
    await adoptRestoredSessions({ adapter, sessions });
    expect(adopted.map((a) => a.sessionId).sort()).toEqual(["s-already", "s-live", "s-null-native"]);
    expect(adopted.find((a) => a.sessionId === "s-live")).toMatchObject({ nativeSessionId: "th-1", cli: "codex", permMode: "auto" });
    expect(adopted.find((a) => a.sessionId === "s-null-native")).toMatchObject({ nativeSessionId: "" });
    for (const id of ["s-live", "s-null-native", "s-already", "s-pty"]) {
      expect(sessions.list().find((r) => r.id === id)?.status).toBe("disconnected");
    }
  });

  it("adapter 无 adoptSession 能力或收养抛错：落库断开不中断其余会话收养", async () => {
    const sessions = makeSessions([
      { id: "s-a", cli: "codex", nativeSessionId: "n-a", status: "idle" },
      { id: "s-b", cli: "claude", nativeSessionId: "n-b", status: "idle" },
    ]);
    const noAdopt: CliAdapter = {
      capabilities: { approval: true, interrupt: true, resume: true, readHistory: true, skillSignal: false },
      createSession: async () => {
        throw new Error("unused");
      },
      sendTurn: async () => {},
      interruptTurn: async () => {},
      resolveApproval: async () => {},
      readHistory: async () => [],
      resume: async () => {},
      dispose: async () => {},
      subscribe: (_h: (event: AdapterEvent) => void) => () => {},
    };
    const logs: string[] = [];
    await adoptRestoredSessions({ adapter: noAdopt, sessions, log: (_k, d) => logs.push(d) });
    expect(sessions.list().every((r) => r.status === "disconnected")).toBe(true);
    expect(logs.length).toBe(2); // 每会话一条失败日志
  });
});
