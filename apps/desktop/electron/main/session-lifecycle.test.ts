// 用途：session-lifecycle 密封测试（issue #70 C2，A 类）—— 归档/取消归档/删除三编排的顺序与幂等/中止语义、SessionProcesses seam 分派（真 SQLite tmp 直连 store + fake procs + 固定时钟）；#60×#62 墓碑复活语义经 remove+重插钉住
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdoptSessionInput } from "@kanban/cli-host";
import { openDatabase, type SqliteDb } from "./db";
import { SessionStore, type SessionRecord } from "./session-store";
import { createSessionLifecycle, type SessionProcesses } from "./session-lifecycle";
import type { LogFn, LogLevel } from "./logger";

let tmpRoot = "";
let db: SqliteDb | null = null;

afterEach(() => {
  db?.close();
  db = null;
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

/** 真 SQLite tmp 夹具（session-store.test.ts makeStore 先例；预置 p-1 项目行满足 FK） */
function makeStore(): SessionStore {
  tmpRoot = mkdtempSync(join(tmpdir(), "kb-lifecycle-"));
  db = openDatabase(join(tmpRoot, "test.db"));
  db.prepare("INSERT INTO projects (id, name, canonical_path, status, created_at) VALUES ('p-1', 'p-1', 'C:\\p-1', 'ok', '2026-11-05T00:00:00.000Z')").run();
  return new SessionStore(db);
}

function makeRecord(partial: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s-1",
    kind: "structured",
    cli: "claude",
    nativeSessionId: "thread-1",
    projectId: "p-1",
    title: "调研",
    cwd: "C:\\repo",
    permMode: "auto",
    status: "idle",
    lastActiveAt: null,
    archivedAt: null,
    ...partial,
  };
}

/** 记录型 fake procs：interrupt/terminate/adopt 全记录，可注入失败与 adopt 不支持 */
function makeProcs(fails: { interrupt?: boolean; terminate?: boolean; adopt?: boolean; unsupportedAdopt?: boolean } = {}) {
  const calls: string[] = [];
  const adopted: AdoptSessionInput[] = [];
  const procs: SessionProcesses = {
    interrupt: async (id) => {
      calls.push(`interrupt:${id}`);
      if (fails.interrupt) throw new Error("中断失败（注入）");
    },
    terminate: async (rec) => {
      calls.push(`terminate:${rec.id}:${rec.kind}`);
      if (fails.terminate) throw new Error("终止失败（注入）");
    },
    adopt:
      fails.unsupportedAdopt
        ? (input) => {
            calls.push(`adopt:${input.sessionId}`);
            return Promise.reject(new Error(`当前 CLI 不支持会话收养，无法取消归档：${input.cli ?? ""}`));
          }
        : async (input) => {
            calls.push(`adopt:${input.sessionId}`);
            adopted.push(input);
            if (fails.adopt) throw new Error("登记失败（注入）");
          },
  };
  return { procs, calls, adopted };
}

/** 日志收集（best-effort warn 断言面） */
function makeLog() {
  const entries: Array<{ level: LogLevel; scope: string; message: string }> = [];
  const log: LogFn = (level, scope, message) => entries.push({ level, scope, message });
  return { entries, log };
}

const FIXED_NOW = "2026-11-11T08:00:00.000Z";
const fixedClock = (): string => FIXED_NOW;

/** 组装被测 lifecycle：真 store + fake procs + 固定时钟 */
function makeLifecycle(fails?: Parameters<typeof makeProcs>[0]) {
  const sessions = makeStore();
  const procs = makeProcs(fails);
  const logs = makeLog();
  const lifecycle = createSessionLifecycle({ sessions, procs: procs.procs, now: fixedClock, log: logs.log });
  return { sessions, ...procs, logs, lifecycle };
}

describe("archive 归档编排（#58 spec #57 D 节）", () => {
  it("结构化：中断 → 受控终止 → 写归档标记（固定时钟），行移出默认列表进归档视图", async () => {
    const { sessions, calls, lifecycle } = makeLifecycle();
    sessions.insert(makeRecord());
    const r = await lifecycle.archive("s-1");
    expect(r).toEqual({ outcome: "archived" });
    expect(calls).toEqual(["interrupt:s-1", "terminate:s-1:structured"]); // 顺序：先中断再终止
    expect(sessions.list()).toEqual([]);
    expect(sessions.listArchived()[0]).toMatchObject({ id: "s-1", archivedAt: FIXED_NOW });
  });

  it("PTY：只用终端终止（无 interrupt/dispose），不走结构化路径", async () => {
    const { sessions, calls, lifecycle } = makeLifecycle();
    sessions.insert(makeRecord({ id: "tty-1", kind: "pty", cli: "pty", nativeSessionId: null, permMode: null }));
    const r = await lifecycle.archive("tty-1");
    expect(r).toEqual({ outcome: "archived" });
    expect(calls).toEqual(["terminate:tty-1:pty"]);
  });

  it("中断/终止失败（进程已死）best-effort 放行：仍写归档标记并记 warn", async () => {
    const { sessions, calls, logs, lifecycle } = makeLifecycle({ interrupt: true, terminate: true });
    sessions.insert(makeRecord());
    const r = await lifecycle.archive("s-1");
    expect(r).toEqual({ outcome: "archived" });
    expect(calls).toEqual(["interrupt:s-1", "terminate:s-1:structured"]); // 两步都尝试
    expect(sessions.listArchived()).toHaveLength(1); // 归档不被进程失败阻断
    expect(logs.entries.filter((e) => e.level === "warn")).toHaveLength(2); // 逐条记 warn
  });

  it("幂等：未知 id 与已归档行均 no-op（不编排、不覆盖首次归档时间）", async () => {
    const { sessions, calls, lifecycle } = makeLifecycle();
    expect(await lifecycle.archive("ghost")).toEqual({ outcome: "noop" });
    sessions.insert(makeRecord());
    await lifecycle.archive("s-1");
    const callsAfterFirst = calls.length;
    expect(await lifecycle.archive("s-1")).toEqual({ outcome: "noop" });
    expect(calls.length).toBe(callsAfterFirst); // 重复归档不再次中断/终止
    expect(sessions.listArchived()[0].archivedAt).toBe(FIXED_NOW); // 首次时间保留（store COALESCE）
  });
});

describe("unarchive 取消归档编排（#58）", () => {
  it("结构化：先 adopt 登记可恢复句柄（native id/cwd/permMode/cli 透传）→ 清标记、置 disconnected、活跃时间=固定时钟", async () => {
    const { sessions, calls, adopted, lifecycle } = makeLifecycle();
    sessions.insert(makeRecord());
    await lifecycle.archive("s-1");
    const r = await lifecycle.unarchive("s-1");
    expect(r).toEqual({ outcome: "restored" });
    expect(calls[calls.length - 1]).toBe("adopt:s-1"); // 清标记前先登记
    expect(adopted[0]).toEqual({ sessionId: "s-1", nativeSessionId: "thread-1", cwd: "C:\\repo", permMode: "auto", cli: "claude" });
    expect(sessions.list()[0]).toMatchObject({ id: "s-1", archivedAt: null, status: "disconnected", lastActiveAt: FIXED_NOW });
  });

  it("PTY：无进程恢复（不调 adopt），仅清标记回列表显示已断开", async () => {
    const { sessions, calls, lifecycle } = makeLifecycle();
    sessions.insert(makeRecord({ id: "tty-1", kind: "pty", cli: "pty", nativeSessionId: null, permMode: null }));
    await lifecycle.archive("tty-1");
    const r = await lifecycle.unarchive("tty-1");
    expect(r).toEqual({ outcome: "restored" });
    expect(calls.filter((c) => c.startsWith("adopt:"))).toEqual([]);
    expect(sessions.list()[0]).toMatchObject({ id: "tty-1", status: "disconnected", archivedAt: null });
  });

  it("adopt 失败（含 CLI 不支持收养）原地抛错：留在归档态、不写活跃时间（可重试）", async () => {
    const { sessions, lifecycle } = makeLifecycle({ adopt: true });
    sessions.insert(makeRecord());
    await lifecycle.archive("s-1");
    await expect(lifecycle.unarchive("s-1")).rejects.toThrow("登记失败（注入）");
    expect(sessions.listArchived()[0]).toMatchObject({ id: "s-1", lastActiveAt: null }); // 归档态原样

    const noAdopt = makeLifecycle({ unsupportedAdopt: true });
    noAdopt.sessions.insert(makeRecord({ id: "s-2", cli: "codex" }));
    await noAdopt.lifecycle.archive("s-2");
    await expect(noAdopt.lifecycle.unarchive("s-2")).rejects.toThrow("当前 CLI 不支持会话收养，无法取消归档：codex");
    expect(noAdopt.sessions.listArchived()).toHaveLength(1);
  });

  it("未归档/未知 id no-op：不调 adopt、不写活跃时间（重复取消归档幂等）", async () => {
    const { sessions, calls, lifecycle } = makeLifecycle();
    sessions.insert(makeRecord());
    expect(await lifecycle.unarchive("s-1")).toEqual({ outcome: "noop" }); // 本就未归档
    expect(await lifecycle.unarchive("ghost")).toEqual({ outcome: "noop" });
    expect(calls).toEqual([]);
    expect(sessions.list()[0]).toMatchObject({ lastActiveAt: null }); // 不凭空写活跃时间
  });
});

describe("remove 删除编排（#62 spec #57 D 节）", () => {
  it("结构化：beforeDelete hook → 中断 → 受控终止 → 删行；hook 拿到会话 id", async () => {
    const { sessions, calls, lifecycle } = makeLifecycle();
    sessions.insert(makeRecord());
    const hookIds: string[] = [];
    await lifecycle.remove("s-1", { beforeDelete: async () => { hookIds.push("s-1"); } });
    expect(hookIds).toEqual(["s-1"]); // 解关联先于终止
    expect(calls).toEqual(["interrupt:s-1", "terminate:s-1:structured"]);
    expect(sessions.listAll()).toEqual([]); // 行删除
  });

  it("PTY：终端终止（无 interrupt/dispose）→ 删行", async () => {
    const { sessions, calls, lifecycle } = makeLifecycle();
    sessions.insert(makeRecord({ id: "tty-1", kind: "pty", cli: "pty", nativeSessionId: null, permMode: null }));
    await lifecycle.remove("tty-1");
    expect(calls).toEqual(["terminate:tty-1:pty"]);
    expect(sessions.listAll()).toEqual([]);
  });

  it("hook 抛错即中止：行保留、进程未终止（可重试）；无行幂等 no-op 且不调 hook", async () => {
    const { sessions, calls, lifecycle } = makeLifecycle();
    sessions.insert(makeRecord());
    await expect(
      lifecycle.remove("s-1", { beforeDelete: async () => { throw new Error("sqlite 写入失败（注入）"); } }),
    ).rejects.toThrow("sqlite 写入失败");
    expect(calls).toEqual([]); // 未走到中断/终止
    expect(sessions.list()).toHaveLength(1); // 行保留

    let hookCalled = false;
    await lifecycle.remove("ghost", { beforeDelete: async () => { hookCalled = true; } });
    expect(hookCalled).toBe(false); // 幂等：无行不触发解关联
    await expect(lifecycle.remove("ghost")).resolves.toBeUndefined();
  });

  it("中断/终止失败 best-effort 放行：行仍删除（进程已死不应挡删除）", async () => {
    const { sessions, logs, lifecycle } = makeLifecycle({ interrupt: true, terminate: true });
    sessions.insert(makeRecord());
    await lifecycle.remove("s-1");
    expect(sessions.listAll()).toEqual([]);
    expect(logs.entries.filter((e) => e.level === "warn")).toHaveLength(2);
  });

  it("墓碑复活（#62 × #60）：删除后同 id 重插（PTY 草稿回删占位行后重试复用同 id）——重建即活会话，迟到守卫不再命中", async () => {
    const { sessions, lifecycle } = makeLifecycle();
    sessions.insert(makeRecord({ id: "tty-1", kind: "pty", cli: "pty", nativeSessionId: null, permMode: null }));
    await lifecycle.remove("tty-1"); // spawn 失败回删占位行（进墓碑）
    expect(sessions.shouldDropEvents("tty-1")).toBe(true);
    sessions.insert(makeRecord({ id: "tty-1", kind: "pty", cli: "pty", nativeSessionId: null, permMode: null })); // 同 id 重试重建
    expect(sessions.shouldDropEvents("tty-1")).toBe(false); // 重建后事件照常
  });
});
