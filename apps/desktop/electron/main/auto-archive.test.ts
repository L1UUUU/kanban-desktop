// 用途：自动归档引擎密封测试（#64 spec #57）—— 判定纯函数（默认关恒空/天数边界含 1、365 与临界天/基准回落/四类跳过含空闲终端进程存活/已归档排除）+ 执行器（默认关零动作/逐条容错/摘要/取消归档后不立即重归档；真实内存 SQLite + FakeAdapter + fake PTY 宿主）
import { describe, expect, it } from "vitest";
import { FakeAdapter } from "@kanban/cli-host";
import type { AutoArchiveConfig } from "@kanban/ipc-schema";
import { selectAutoArchiveIds, runAutoArchiveScan, type AutoArchiveCandidate } from "./auto-archive";
import { openDatabase } from "./db";
import type { LogFn, LogLevel } from "./logger";
import type { PtyHost } from "./pty-host";
import { createAdapterSessionProcesses, createSessionLifecycle } from "./session-lifecycle";
import { SessionStore, type SessionRecord } from "./session-store";

// ============ 判定纯函数（Seam A：会话集合 + 配置 + 当前时间 → 待归档 id 列表） ============

/** 候选行工厂：缺省 = 未归档、已断开、进程不在的结构化会话（创建于 2026-01-01） */
function cand(over: Partial<AutoArchiveCandidate> & { id: string }): AutoArchiveCandidate {
  return {
    kind: "structured",
    status: "disconnected",
    lastActiveAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    processAlive: false,
    ...over,
  };
}

const NOW = new Date("2026-06-01T00:00:00.000Z");
const ON = { enabled: true, days: 30 } as const satisfies AutoArchiveConfig;
const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY_MS).toISOString();

describe("selectAutoArchiveIds 判定纯函数", () => {
  it("默认关（enabled=false）恒空 —— 即使存在远超期的老会话也不产生任何待归档 id", () => {
    const sessions = [cand({ id: "s-ancient", createdAt: ago(400) })];
    expect(selectAutoArchiveIds(sessions, { enabled: false, days: 30 }, NOW)).toEqual([]);
  });

  it("临界天：距基准恰好满 N 天（含整点）待归档；差 1ms 未满 N 天不归档", () => {
    const exact = cand({ id: "s-exact", createdAt: ago(30) });
    const justUnder = cand({ id: "s-under", createdAt: new Date(NOW.getTime() - 30 * DAY_MS + 1).toISOString() });
    expect(selectAutoArchiveIds([exact, justUnder], ON, NOW)).toEqual(["s-exact"]);
  });

  it("天数边界 1（下界）：满 1 天归档、差 1ms 不归档", () => {
    const a = cand({ id: "s-1d", createdAt: ago(1) });
    const b = cand({ id: "s-1d-minus", createdAt: new Date(NOW.getTime() - DAY_MS + 1).toISOString() });
    expect(selectAutoArchiveIds([a, b], { enabled: true, days: 1 }, NOW)).toEqual(["s-1d"]);
  });

  it("天数边界 365（上界）：满 365 天归档、364 天不归档", () => {
    const a = cand({ id: "s-365d", createdAt: ago(365) });
    const b = cand({ id: "s-364d", createdAt: ago(364) });
    expect(selectAutoArchiveIds([a, b], { enabled: true, days: 365 }, NOW)).toEqual(["s-365d"]);
  });

  it("基准回落 COALESCE(last_active_at, created_at)：lastActiveAt 缺失回落 createdAt；存在则以 lastActiveAt 为准（更近则不超期）", () => {
    const fellBack = cand({ id: "s-fallback", lastActiveAt: null, createdAt: ago(31) });
    const recentActive = cand({ id: "s-recent", lastActiveAt: ago(1), createdAt: ago(90) });
    const staleActive = cand({ id: "s-stale", lastActiveAt: ago(45), createdAt: ago(1) });
    expect(selectAutoArchiveIds([fellBack, recentActive, staleActive], ON, NOW)).toEqual(["s-fallback", "s-stale"]);
  });

  it("四类跳过：运行中 / 等待审批 / 底层进程存活（含正开着的空闲终端与使用中的结构化会话）/ 已归档 —— 同批仅无事件存活者入选", () => {
    const sessions = [
      cand({ id: "s-running", status: "running" }),
      cand({ id: "s-waiting", status: "waiting" }),
      cand({ id: "s-idle-terminal", kind: "pty", status: "idle", processAlive: true, createdAt: ago(90) }),
      cand({ id: "s-idle-structured", status: "idle", processAlive: true, createdAt: ago(90) }),
      cand({ id: "s-archived", archivedAt: "2026-05-01T00:00:00.000Z", createdAt: ago(400) }),
      cand({ id: "s-free", createdAt: ago(31) }),
    ];
    expect(selectAutoArchiveIds(sessions, ON, NOW)).toEqual(["s-free"]);
  });

  it("基准时间不可解析时保守跳过（不因脏数据误归档）", () => {
    const dirty = cand({ id: "s-dirty", lastActiveAt: "not-a-timestamp", createdAt: ago(400) });
    const noBasis = cand({ id: "s-nobasis", lastActiveAt: null, createdAt: null });
    expect(selectAutoArchiveIds([dirty, noBasis], ON, NOW)).toEqual([]);
  });
});

// ============ 执行器（Seam A：真实内存 SQLite + FakeAdapter + fake PTY 宿主，纯依赖注入） ============

/** fake PTY 宿主（对齐 ipc.test.ts makePtyHost：记录 kill、可控制 isRunning 集合） */
function makePtyHost() {
  const killed: string[] = [];
  const running = new Set<string>();
  const host: PtyHost = {
    spawn: () => ({ ok: true, label: "pwsh", shell: "pwsh.exe", cwd: "C:\\p" }),
    write: () => ({ ok: true }),
    resize: () => undefined,
    kill: (terminalId) => {
      killed.push(terminalId);
      running.delete(terminalId);
    },
    isRunning: (terminalId) => running.has(terminalId),
    killAll: () => running.clear(),
  };
  return { host, killed, markRunning: (id: string) => running.add(id) };
}

/** 日志收集器（断言扫描日志可查） */
function makeLog() {
  const entries: Array<{ level: LogLevel; scope: string; message: string }> = [];
  const log: LogFn = (level, scope, message) => entries.push({ level, scope, message });
  return { entries, log };
}

/** 落一条会话行（缺省 = 已断开、40 天前创建、未归档） */
function seed(sessions: SessionStore, over: Partial<SessionRecord> & { id: string }): void {
  sessions.insert({
    kind: "structured",
    cli: "fake",
    nativeSessionId: null,
    projectId: null,
    title: null,
    cwd: "C:\\p",
    permMode: "auto",
    status: "disconnected",
    lastActiveAt: null,
    archivedAt: null,
    createdAt: ago(40),
    ...over,
  });
}

/** 引擎夹具：内存库 + FakeAdapter + fake PTY + 日志收集（归档编排经 lifecycle 唯一写者，adapter/pty 经 SessionProcesses 分派） */
function makeEngine() {
  const adapter = new FakeAdapter();
  const sessions = new SessionStore(openDatabase(":memory:"));
  const pty = makePtyHost();
  const logs = makeLog();
  const lifecycle = createSessionLifecycle({ sessions, procs: createAdapterSessionProcesses(adapter, pty.host) });
  return {
    adapter,
    sessions,
    pty,
    logs,
    lifecycle,
    run: (config: AutoArchiveConfig, now: Date = NOW) => runAutoArchiveScan({ sessions, pty: pty.host, lifecycle, log: logs.log }, config, now),
  };
}

describe("runAutoArchiveScan 执行器", () => {
  it("默认关：零动作 —— 不读库不归档不触碰 adapter/PTY，摘要为零", async () => {
    const { adapter, sessions, pty, logs, run } = makeEngine();
    seed(sessions, { id: "s-old" });
    const summary = await run({ enabled: false, days: 30 });
    expect(summary).toEqual({ archived: 0, failed: 0 });
    expect(sessions.list().length).toBe(1); // 老数据不动
    expect(sessions.get("s-old")?.archivedAt).toBeNull();
    expect(pty.killed).toEqual([]);
    expect(logs.entries).toEqual([]);
    // adapter 未被触碰：对其发 turn 仍正常（未被 dispose 清空）
    const created = await adapter.createSession({ cli: "fake", cwd: "C:\\p" });
    expect(created.sessionId).toBeTruthy();
  });

  it("开启后：超期已断开会话被归档（结构化走 adapter 终止、PTY 走宿主 kill），移出默认列表、可在归档视图找回", async () => {
    const { sessions, pty, logs, run } = makeEngine();
    seed(sessions, { id: "s-structured" });
    seed(sessions, { id: "t-pty", kind: "pty", cli: "pty", permMode: null });
    const summary = await run(ON);
    expect(summary).toEqual({ archived: 2, failed: 0 });
    expect(sessions.list()).toEqual([]); // 移出默认列表
    expect(sessions.listArchived().map((r) => r.id).sort()).toEqual(["s-structured", "t-pty"]);
    expect(pty.killed).toEqual(["t-pty"]); // PTY 用终端终止
    expect(logs.entries.some((e) => e.scope === "auto-archive" && e.message.includes("归档 2 条"))).toBe(true);
  });

  it("使用中会话绝不被归档：运行中/等待审批/底层进程存活（正开着的空闲终端）全部跳过", async () => {
    const { sessions, pty, run } = makeEngine();
    seed(sessions, { id: "s-running", status: "running" });
    seed(sessions, { id: "s-waiting", status: "waiting" });
    seed(sessions, { id: "t-open", kind: "pty", cli: "pty", permMode: null, status: "idle" });
    seed(sessions, { id: "s-idle-alive", status: "idle" });
    pty.markRunning("t-open");
    const summary = await run(ON);
    expect(summary).toEqual({ archived: 0, failed: 0 });
    expect(sessions.list().length).toBe(4); // 全部留在默认列表
    expect(pty.killed).toEqual([]); // 空闲终端未被误杀
    expect(sessions.listArchived()).toEqual([]);
  });

  it("单条失败不影响其余：失败条目计入 failed 并记 error 日志，其余照常归档", async () => {
    const { adapter, pty, logs } = makeEngine();
    // archive 抛错的 store 子类：仅 s-bad 行失败，验证 allSettled 逐条容错
    class FailingStore extends SessionStore {
      archive(id: string, at: string): void {
        if (id === "s-bad") throw new Error("注入的归档失败");
        super.archive(id, at);
      }
    }
    const sessions = new FailingStore(openDatabase(":memory:"));
    seed(sessions, { id: "s-bad" });
    seed(sessions, { id: "s-ok" });
    const lifecycle = createSessionLifecycle({ sessions, procs: createAdapterSessionProcesses(adapter, pty.host) });
    const summary = await runAutoArchiveScan({ sessions, pty: pty.host, lifecycle, log: logs.log }, ON, NOW);
    expect(summary).toEqual({ archived: 1, failed: 1 });
    expect(sessions.get("s-ok")?.archivedAt).toBeTruthy();
    expect(sessions.get("s-bad")?.archivedAt).toBeNull();
    expect(logs.entries.some((e) => e.level === "error" && e.message.includes("s-bad") && e.message.includes("注入的归档失败"))).toBe(true);
  });

  it("取消归档重置活跃时间后：下次扫描不立即重归档（衔接 #58 unarchive 刷新 last_active_at）", async () => {
    const { sessions, run } = makeEngine();
    seed(sessions, { id: "s-cycle" });
    await run(ON);
    expect(sessions.get("s-cycle")?.archivedAt).toBeTruthy();
    // 取消归档：清标记 + 刷新活跃时间为当前时刻（#58 语义）
    sessions.unarchive("s-cycle", NOW.toISOString());
    const summary = await run(ON);
    expect(summary).toEqual({ archived: 0, failed: 0 });
    expect(sessions.get("s-cycle")?.archivedAt).toBeNull();
    expect(sessions.list().length).toBe(1); // 回到默认列表且未被重归档
  });

  it("归档编排复用 session:archive 同一路径：已归档行再次扫描为幂等 no-op（不重复编排）", async () => {
    const { sessions, run } = makeEngine();
    seed(sessions, { id: "s-once" });
    const first = await run(ON);
    expect(first).toEqual({ archived: 1, failed: 0 });
    const second = await run(ON);
    expect(second).toEqual({ archived: 0, failed: 0 });
    // adapter 未因第二次扫描再次 dispose（首次 dispose 已删除句柄；二次无目标）
    expect(sessions.listArchived().length).toBe(1);
  });
});
