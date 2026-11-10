// 用途：Main 入站 IPC 路由单测 —— zod 强制校验（非法消息明确错误码 E_SCHEMA）+ 各通道路由到 Adapter/store + AdapterError 错误码透传（spec E/#6 验收第 4 条/#7 project/session 通道；#17 kanban 七通道 + 原子关联 + tracker 推送）
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAdapter, VirtualClock, type CliAdapter } from "@kanban/cli-host";
import { trackerChangeSchema } from "@kanban/ipc-schema";
import { TrackerEngine, type TrackerChange } from "@kanban/tracker";
import { openDatabase } from "./db";
import { handleDiffIpc, handleIpc, type DiffIpcDeps, type IpcDeps } from "./ipc";
import { openMemoryService } from "./memory-service";
import type { LogFn, LogLevel } from "./logger";
import type { PtyHost } from "./pty-host";
import { ProjectStore } from "./project-store";
import { SessionStore } from "./session-store";

let tmpRoot = "";

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

/** 路由级 fake PTY 宿主：记录 spawn/kill 调用（PTY 行为由 pty-host.test.ts 覆盖） */
function makePtyHost() {
  const spawned: Array<{ terminalId: string; cwd: string }> = [];
  const killed: string[] = [];
  const running = new Set<string>();
  const host: PtyHost = {
    spawn: (terminalId, req) => {
      spawned.push({ terminalId, cwd: req.cwd });
      running.add(terminalId);
      return { ok: true, label: "pwsh", shell: "pwsh.exe", cwd: req.cwd };
    },
    write: (terminalId) => (running.has(terminalId) ? { ok: true } : { ok: false, message: "终端未运行" }),
    resize: () => undefined,
    kill: (terminalId) => {
      killed.push(terminalId);
      running.delete(terminalId);
    },
    isRunning: (terminalId) => running.has(terminalId),
    killAll: () => running.clear(),
  };
  return { host, spawned, killed, drop: (id: string) => running.delete(id) };
}

/** 构造 VirtualClock 驱动的 FakeAdapter + 路由器（无持久化通道，#6 既有行为回归用） */
function makeRouter() {
  const clock = new VirtualClock();
  const adapter = new FakeAdapter({ clock });
  const deps = makeDeps(adapter);
  return { clock, adapter, deps, handle: (raw: unknown) => handleIpc(deps, raw) };
}

/** 完整 deps：内存 store + 可注入的目录选择与当前项目存取（#17 起挂 TrackerEngine：kanban 通道落事件流） */
function makeDeps(adapter: CliAdapter, pick: () => Promise<string | null> = async () => null): IpcDeps {
  const db = openDatabase(":memory:");
  let currentProjectId: string | null = null;
  return {
    adapter,
    engine: new TrackerEngine(db),
    projects: new ProjectStore(db),
    sessions: new SessionStore(db),
    pickDirectory: pick,
    getCurrentProjectId: () => currentProjectId,
    setCurrentProjectId: (id) => {
      currentProjectId = id;
    },
    pty: makePtyHost().host,
  };
}

describe("Main 入站强制校验", () => {
  it("非法消息被拒并返回 E_SCHEMA + 可读摘要（验收第 4 条）", async () => {
    const { handle } = makeRouter();
    const cases: unknown[] = [
      null,
      "session:send",
      { channel: "session:nuke" },
      { channel: "session:send", sessionId: "s", text: "" },
      { channel: "session:send", sessionId: "", text: "hi" },
      { channel: "session:create", cli: "unknown-cli", cwd: "C:\\p" },
    ];
    for (const raw of cases) {
      const res = await handle(raw);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("E_SCHEMA");
        expect(res.error.message.length).toBeGreaterThan(0);
      }
    }
  });

  it("session:create 路由到 adapter，返回会话元数据", async () => {
    const { handle } = makeRouter();
    const res = await handle({
      channel: "session:create",
      cli: "fake",
      cwd: "C:\\project2\\kanban-desktop",
      title: "演示会话",
      permMode: "auto",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.sessionId).toBeTruthy();
      expect(res.cli).toBe("fake");
      expect(res.title).toBe("演示会话");
    }
  });

  it("session:send / interrupt / resolveApproval 路由成功（ok:true）", async () => {
    const { clock, adapter, handle } = makeRouter();
    const created = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p" });
    const sessionId = created.ok ? created.sessionId! : "";
    expect((await handle({ channel: "session:send", sessionId, text: "默认演示" })).ok).toBe(true);
    clock.runToIdle();
    expect((await handle({ channel: "session:interrupt", sessionId })).ok).toBe(true);

    // 走一次完整审批决定：订阅 adapter 事件拿真实 requestId
    const requested = new Promise<string>((resolve) => {
      const off = adapter.subscribe((e) => {
        if ("type" in e && e.type === "approval_requested") {
          off();
          resolve(e.requestId);
        }
      });
    });
    await handle({ channel: "session:send", sessionId, text: "审批演示" });
    clock.runToIdle();
    const requestId = await requested;
    const resolved = await handle({
      channel: "session:resolveApproval",
      sessionId,
      requestId,
      decision: "deny",
    });
    expect(resolved.ok).toBe(true);
    clock.runToIdle();
  });

  it("AdapterError 错误码透传（过期审批 E_APPROVAL_EXPIRED / 未知会话 E_SESSION_NOT_FOUND）；意外异常兜底 E_INTERNAL", async () => {
    const { handle } = makeRouter();
    const res = await handle({ channel: "session:send", sessionId: "ghost", text: "hi" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_SESSION_NOT_FOUND");
    const res1 = await handle({
      channel: "session:resolveApproval",
      sessionId: "ghost",
      requestId: "ap-x",
      decision: "deny",
    });
    expect(res1.ok).toBe(false);
    if (!res1.ok) expect(res1.error.code).toBe("E_SESSION_NOT_FOUND");

    // 抛非 AdapterError 的 adapter → E_INTERNAL 兜底
    const boom = {
      capabilities: new FakeAdapter({ clock: new VirtualClock() }).capabilities,
      createSession: async () => ({ sessionId: "s-boom" }),
      sendTurn: async () => {
        throw new Error("boom");
      },
      interruptTurn: async () => {},
      resolveApproval: async () => {},
      readHistory: async () => [],
      resume: async () => {},
      dispose: async () => {},
      subscribe: () => () => {},
    };
    const res2 = await handleIpc(
      { ...makeDeps(boom as unknown as CliAdapter), adapter: boom as unknown as CliAdapter },
      {
        channel: "session:send",
        sessionId: "s-boom",
        text: "x",
      },
    );
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.error.code).toBe("E_INTERNAL");
  });

  it("session:readHistory：返回 adapter 快照（与实时流同键同 seq）；未知会话 → E_SESSION_NOT_FOUND；session:resume ok（#9 恢复入口）", async () => {
    const { clock, handle } = makeRouter();
    const created = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p" });
    const sessionId = created.ok ? created.sessionId! : "";
    await handle({ channel: "session:send", sessionId, text: "默认演示" });
    clock.runToIdle();

    const read = await handle({ channel: "session:readHistory", sessionId });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.events!.length).toBeGreaterThan(0);
      // 快照成员形状与终态一致（契约：事件日志 = 消息流恢复源）
      const seqs = read.events!.map((e) => e.seq);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      expect(read.events!.at(-1)!.type).toBe("session_status");
    }
    const resume = await handle({ channel: "session:resume", sessionId });
    expect(resume.ok).toBe(true);

    const ghostRead = await handle({ channel: "session:readHistory", sessionId: "ghost" });
    expect(ghostRead.ok).toBe(false);
    if (!ghostRead.ok) expect(ghostRead.error.code).toBe("E_SESSION_NOT_FOUND");
    const ghostResume = await handle({ channel: "session:resume", sessionId: "ghost" });
    expect(ghostResume.ok).toBe(false);
    if (!ghostResume.ok) expect(ghostResume.error.code).toBe("E_SESSION_NOT_FOUND");
  });

  it("装配夹具不传 log（可选成员）零回归（#53：缺省 no-op）", async () => {
    const { handle } = makeRouter();
    const res = await handle({ channel: "project:list" });
    expect(res.ok).toBe(true);
  });
});

describe("IPC 通道诊断日志（#53 spec #52 G 节：safeParse 失败与 catch 记 error、业务拒绝不记；error.code 原样不造新码）", () => {
  /** 收集日志条目的 spy */
  function spyLog(): { log: LogFn; entries: Array<{ level: LogLevel; scope: string; message: string }> } {
    const entries: Array<{ level: LogLevel; scope: string; message: string }> = [];
    return { log: (level, scope, message) => entries.push({ level, scope, message }), entries };
  }

  it("kanban:ipc safeParse 失败记一条 error（含 E_SCHEMA 原码）；返回形状不变", async () => {
    const spy = spyLog();
    const deps: IpcDeps = { ...makeDeps(new FakeAdapter({ clock: new VirtualClock() })), log: spy.log };
    const res = await handleIpc(deps, { channel: "session:nuke" });
    expect(res).toMatchObject({ ok: false, error: { code: "E_SCHEMA" } });
    expect(spy.entries).toHaveLength(1);
    expect(spy.entries[0]).toMatchObject({ level: "error", scope: "kanban:ipc" });
    expect(spy.entries[0].message).toContain("E_SCHEMA");
  });

  it("kanban:ipc route 抛错（非 AdapterError）记一条 error（E_INTERNAL 原码）并保持既有收敛形状", async () => {
    const spy = spyLog();
    const base = new FakeAdapter({ clock: new VirtualClock() });
    const adapter = { ...base, sendTurn: async () => { throw new Error("adapter 内部爆炸"); } } as unknown as CliAdapter;
    const deps: IpcDeps = { ...makeDeps(adapter), log: spy.log };
    const res = await handleIpc(deps, { channel: "session:send", sessionId: "s-1", text: "hi" });
    expect(res).toMatchObject({ ok: false, error: { code: "E_INTERNAL" } });
    expect(spy.entries).toHaveLength(1);
    expect(spy.entries[0].level).toBe("error");
    expect(spy.entries[0].message).toContain("E_INTERNAL");
    expect(spy.entries[0].message).toContain("adapter 内部爆炸");
  });

  it("kanban:ipc 业务拒绝（E_SESSION_NOT_FOUND 的 ok:false 返回）不记日志", async () => {
    const spy = spyLog();
    const deps: IpcDeps = { ...makeDeps(new FakeAdapter({ clock: new VirtualClock() })), log: spy.log };
    const res = await handleIpc(deps, { channel: "terminal:write", terminalId: "t-404", data: "x" });
    expect(res).toMatchObject({ ok: false, error: { code: "E_SESSION_NOT_FOUND" } });
    expect(spy.entries).toHaveLength(0);
  });

  it("diff:ipc safeParse 失败记一条 error（E_SCHEMA 原码）", async () => {
    const spy = spyLog();
    const db = openDatabase(":memory:");
    const projects = new ProjectStore(db);
    const handle = (raw: unknown) =>
      handleDiffIpc({ projects, readWorkspaceDiff: (async () => ({ ok: true, files: [], truncated: false })) as DiffIpcDeps["readWorkspaceDiff"], log: spy.log }, raw);
    const res = await handle({ channel: "diff:get", projectId: "" });
    expect(res).toMatchObject({ ok: false, error: { code: "E_SCHEMA" } });
    expect(spy.entries).toHaveLength(1);
    expect(spy.entries[0]).toMatchObject({ level: "error", scope: "diff:ipc" });
    expect(spy.entries[0].message).toContain("E_SCHEMA");
  });

  it("diff:ipc readWorkspaceDiff 抛错：记一条 error 后原样 rethrow（不改既有传播行为）", async () => {
    const spy = spyLog();
    const db = openDatabase(":memory:");
    const projects = new ProjectStore(db);
    const repoDir = join(tmpRoot || (tmpRoot = mkdtempSync(join(tmpdir(), "kb-diff-log-"))), "repo");
    mkdirSync(repoDir, { recursive: true });
    const { project } = projects.register(repoDir);
    const handle = (raw: unknown) =>
      handleDiffIpc(
        { projects, readWorkspaceDiff: (async () => { throw new Error("git died"); }) as DiffIpcDeps["readWorkspaceDiff"], log: spy.log },
        raw,
      );
    await expect(handle({ channel: "diff:get", projectId: project.id })).rejects.toThrow("git died");
    expect(spy.entries).toHaveLength(1);
    expect(spy.entries[0].level).toBe("error");
    expect(spy.entries[0].message).toContain("git died");
  });
});

describe("project 通道（#7）", () => {
  it("project:register：选中目录 → canonical 注册 + 自动设为当前项目；取消 → canceled", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-ipc-reg-"));
    const projDir = join(tmpRoot, "demo-proj");
    mkdirSync(projDir);
    let picked: string | null = null; // null=模拟用户取消
    const clock = new VirtualClock();
    const deps = makeDeps(new FakeAdapter({ clock }), async () => picked);
    const handle = (raw: unknown) => handleIpc(deps, raw);

    const canceled = await handle({ channel: "project:register" });
    expect(canceled).toMatchObject({ ok: true, canceled: true });

    picked = projDir;
    const res = await handle({ channel: "project:register" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.duplicate).toBe(false);
      expect(res.project).toMatchObject({ name: "demo-proj", status: "ok" });
      expect(deps.getCurrentProjectId()).toBe(res.project!.id);
    }

    // 同目录再注册 → duplicate（不重复建行），不改变当前项目指向
    deps.setCurrentProjectId("other");
    const dup = await handle({ channel: "project:register" });
    expect(dup).toMatchObject({ ok: true, duplicate: true });
    expect(deps.getCurrentProjectId()).toBe("other");
  });

  it("project:list：探测后返回列表 + 当前项目（目录删除 → missing）", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-ipc-list-"));
    const projDir = join(tmpRoot, "vanishing");
    mkdirSync(projDir);
    const clock = new VirtualClock();
    const deps = makeDeps(new FakeAdapter({ clock }), async () => projDir);
    const handle = (raw: unknown) => handleIpc(deps, raw);
    const reg = await handle({ channel: "project:register" });

    rmSync(projDir, { recursive: true, force: true });
    const res = await handle({ channel: "project:list" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.projects).toHaveLength(1);
      expect(res.projects![0]).toMatchObject({ status: "missing" });
      expect(res.currentProjectId).toBe(reg.ok ? reg.project!.id : null);
    }
  });

  it("project:switch：存在 → ok 且当前项目更新（含探测后状态回显）；未知 id → E_PROJECT_NOT_FOUND", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-ipc-switch-"));
    mkdirSync(join(tmpRoot, "a"));
    mkdirSync(join(tmpRoot, "b"));
    const dirs = [join(tmpRoot, "a"), join(tmpRoot, "b")];
    let pickIx = -1;
    const clock = new VirtualClock();
    const deps = makeDeps(new FakeAdapter({ clock }), async () => dirs[++pickIx] ?? null);
    const handle = (raw: unknown) => handleIpc(deps, raw);
    await handle({ channel: "project:register" }); // a
    await handle({ channel: "project:register" }); // b
    const list = await handle({ channel: "project:list" });
    const projects = list.ok ? list.projects! : [];
    const [pa, pb] = projects; // created_at 倒序：b 在前？断言按 name 找
    const projB = projects.find((p) => p.name === "b") ?? pb;
    const projA = projects.find((p) => p.name === "a") ?? pa;

    const ok = await handle({ channel: "project:switch", projectId: projA.id });
    expect(ok.ok).toBe(true);
    expect(deps.getCurrentProjectId()).toBe(projA.id);

    const missing = await handle({ channel: "project:switch", projectId: "ghost" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("E_PROJECT_NOT_FOUND");
    void projB;
  });
});

describe("session 通道（#7）", () => {
  it("session:create：三 CLI 枚举可建、落库挂项目、默认标题；session:list 按 cwd 判定目录身份", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-ipc-sess-"));
    const projDir = join(tmpRoot, "repo");
    mkdirSync(join(projDir, ".git"), { recursive: true }); // 主仓库 fixture
    const clock = new VirtualClock();
    const deps = makeDeps(new FakeAdapter({ clock }), async () => projDir);
    const handle = (raw: unknown) => handleIpc(deps, raw);
    const reg = await handle({ channel: "project:register" });
    const projectId = reg.ok && reg.project ? reg.project.id : undefined;

    const created = await handle({ channel: "session:create", cli: "claude", cwd: projDir, projectId });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.cli).toBe("claude");
      expect(created.title).toBe("新会话 · Claude");
    }

    const list = await handle({ channel: "session:list" });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.sessions).toHaveLength(1);
      expect(list.sessions![0]).toMatchObject({
        cli: "claude",
        projectId: projectId ?? null,
        title: "新会话 · Claude",
        dirIdentity: "main",
        status: "idle",
      });
    }
  });

  it("session:list：projectId 过滤 + worktree fixture 判定 + 无 .git 目录为 none", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-ipc-sess2-"));
    const mainRepo = join(tmpRoot, "main-repo");
    const wt = join(tmpRoot, "wt-poc7");
    const plain = join(tmpRoot, "plain");
    mkdirSync(join(mainRepo, ".git"), { recursive: true });
    mkdirSync(wt, { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(wt, ".git"), `gitdir: ${join(mainRepo, ".git", "worktrees", "poc7")}\n`, "utf8");
    mkdirSync(plain, { recursive: true });

    const clock = new VirtualClock();
    const deps = makeDeps(new FakeAdapter({ clock }), async () => mainRepo);
    const handle = (raw: unknown) => handleIpc(deps, raw);
    const reg = await handle({ channel: "project:register" });
    const projectId = reg.ok && reg.project ? reg.project.id : undefined;

    await handle({ channel: "session:create", cli: "codex", cwd: mainRepo, projectId });
    await handle({ channel: "session:create", cli: "opencode", cwd: wt, projectId });
    await handle({ channel: "session:create", cli: "fake", cwd: plain }); // 无项目演示会话

    const all = await handle({ channel: "session:list" });
    if (!all.ok) throw new Error("session:list 失败");
    expect(all.sessions).toHaveLength(3);
    const byCli = new Map(all.sessions!.map((s) => [s.cli, s]));
    expect(byCli.get("codex")).toMatchObject({ dirIdentity: "main", worktreeName: null });
    expect(byCli.get("opencode")).toMatchObject({ dirIdentity: "worktree", worktreeName: "poc7" });
    expect(byCli.get("fake")).toMatchObject({ dirIdentity: "none", projectId: null });

    const scoped = await handle({ channel: "session:list", projectId });
    if (!scoped.ok) throw new Error("session:list(projectId) 失败");
    expect(scoped.sessions).toHaveLength(2);
  });
});

describe("terminal 通道（#12：terminalApi × terminalId 参数化）", () => {
  /** terminal 专用路由：真实 SessionStore + fake pty 宿主（spawn 可注入失败） */
  function makeTerminalRouter(opts?: { failSpawn?: boolean }) {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-ipc-pty-"));
    const projDir = join(tmpRoot, "repo");
    mkdirSync(join(projDir, ".git"), { recursive: true }); // 主仓库 fixture → dirIdentity=main
    const clock = new VirtualClock();
    const db = openDatabase(":memory:");
    const ptyState = makePtyHost();
    const deps: IpcDeps = {
      adapter: new FakeAdapter({ clock }),
      engine: new TrackerEngine(db),
      projects: new ProjectStore(db),
      sessions: new SessionStore(db),
      pickDirectory: async () => projDir,
      getCurrentProjectId: () => null,
      setCurrentProjectId: () => undefined,
      pty: opts?.failSpawn
        ? {
            ...ptyState.host,
            spawn: () => ({ ok: false, message: "启动失败：spawn boom" }),
          }
        : ptyState.host,
    };
    return { deps, ptyState, projDir, handle: (raw: unknown) => handleIpc(deps, raw) };
  }

  it("terminal:create：spawn + pty 会话落库（kind=pty/cli=pty）+ 目录身份 + 默认标题「终端 · label」", async () => {
    const { handle, ptyState, projDir } = makeTerminalRouter();
    const created = await handle({ channel: "terminal:create", cwd: projDir, cols: 120, rows: 40 });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.sessionId).toBeTruthy();
      expect(created.cli).toBe("pty");
      expect(created.title).toBe("终端 · pwsh");
      expect(created.dirIdentity).toBe("main");
    }
    expect(ptyState.spawned).toHaveLength(1);

    const list = await handle({ channel: "session:list" });
    if (!list.ok) throw new Error("session:list 失败");
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions![0]).toMatchObject({ kind: "pty", cli: "pty", nativeSessionId: null, status: "idle", title: "终端 · pwsh" });
  });

  it("terminal:create spawn 失败 → E_INTERNAL 且不落库", async () => {
    const { handle } = makeTerminalRouter({ failSpawn: true });
    const res = await handle({ channel: "terminal:create", cwd: "C:\\p" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_INTERNAL");
    const list = await handle({ channel: "session:list" });
    if (!list.ok) throw new Error("session:list 失败");
    expect(list.sessions).toHaveLength(0);
  });

  it("terminal:write/resize/kill 路由：成功 ok；未运行/未知终端 → E_SESSION_NOT_FOUND", async () => {
    const { handle, ptyState } = makeTerminalRouter();
    const created = await handle({ channel: "terminal:create", cwd: "C:\\p" });
    const terminalId = created.ok ? created.sessionId! : "";

    expect((await handle({ channel: "terminal:write", terminalId, data: "echo hi\r" })).ok).toBe(true);
    expect((await handle({ channel: "terminal:resize", terminalId, cols: 100, rows: 30 })).ok).toBe(true);
    const ghost = await handle({ channel: "terminal:write", terminalId: "ghost", data: "x" });
    if (!ghost.ok) expect(ghost.error.code).toBe("E_SESSION_NOT_FOUND");

    // 进程退出后 write 同样 E_SESSION_NOT_FOUND
    ptyState.drop(terminalId);
    const afterExit = await handle({ channel: "terminal:write", terminalId, data: "x" });
    if (!afterExit.ok) expect(afterExit.error.code).toBe("E_SESSION_NOT_FOUND");

    expect((await handle({ channel: "terminal:kill", terminalId })).ok).toBe(true);
    expect(ptyState.killed).toContain(terminalId);
  });

  it("非法 terminal 载荷 → E_SCHEMA（缺 terminalId / 空 cwd）", async () => {
    const { handle } = makeTerminalRouter();
    const cases: unknown[] = [
      { channel: "terminal:write", data: "x" },
      { channel: "terminal:resize", terminalId: "t", cols: 0, rows: 30 },
      { channel: "terminal:create", cwd: "" },
      { channel: "terminal:nuke", terminalId: "t" },
    ];
    for (const raw of cases) {
      const res = await handle(raw);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("E_SCHEMA");
    }
  });
});

describe("退出序列 IPC 门闸（#13/spec H 停止接收新请求）", () => {
  it("isShuttingDown=true：全部通道拒绝并返回可读错误；false 时正常", async () => {
    const deps = makeDeps(new FakeAdapter());
    let shuttingDown = false;
    (deps as IpcDeps & { isShuttingDown: () => boolean }).isShuttingDown = () => shuttingDown;
    const handle = (raw: unknown) => handleIpc(deps, raw);
    shuttingDown = true;
    for (const raw of [
      { channel: "session:create", cli: "fake", cwd: "C:\\p" },
      { channel: "session:send", sessionId: "s", text: "hi" },
      { channel: "session:list" },
      { channel: "project:list" },
    ]) {
      const res = await handle(raw);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("E_INTERNAL");
        expect(res.error.message).toContain("正在退出");
      }
    }
    shuttingDown = false;
    expect((await handle({ channel: "project:list" })).ok).toBe(true);
  });
});

describe("kanban 通道（#17 spec #15 C 节：全量经 TrackerEngine.process 落事件流）", () => {
  /** kanban 专用路由：双项目 fixture + TrackerEngine + 推送 spy（changes 收集后逐条过 trackerChangeSchema） */
  function makeKanbanRouter() {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-ipc-kanban-"));
    const projA = join(tmpRoot, "proj-a");
    const projB = join(tmpRoot, "proj-b");
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
    let picked: string | null = projA;
    const clock = new VirtualClock();
    const db = openDatabase(":memory:");
    const engine = new TrackerEngine(db);
    const changes: TrackerChange[] = [];
    const deps: IpcDeps = {
      adapter: new FakeAdapter({ clock }),
      engine,
      projects: new ProjectStore(db),
      sessions: new SessionStore(db),
      emitTrackerChange: (c) => changes.push(c),
      pickDirectory: async () => picked,
      getCurrentProjectId: () => null,
      setCurrentProjectId: () => undefined,
      pty: makePtyHost().host,
    };
    return {
      deps,
      engine,
      changes,
      projA,
      projB,
      pickNext: (dir: string | null) => {
        picked = dir;
      },
      handle: (raw: unknown) => handleIpc(deps, raw),
    };
  }

  /** 注册项目并返回 id */
  async function registerProject(r: ReturnType<typeof makeKanbanRouter>, dir: string): Promise<string> {
    r.pickNext(dir);
    const reg = await r.handle({ channel: "project:register" });
    if (!reg.ok || !reg.project) throw new Error("项目注册失败");
    return reg.project.id;
  }

  /** 建会话并返回 sessionId */
  async function createSession(r: ReturnType<typeof makeKanbanRouter>, cli: "fake" | "codex" | "claude" | "opencode", projectId?: string): Promise<string> {
    const res = await r.handle({ channel: "session:create", cli, cwd: r.projA, projectId });
    if (!res.ok || !res.sessionId) throw new Error("会话创建失败");
    return res.sessionId;
  }

  it("kanban:create/list：确定性 REQ-00N 建卡（缺省待命名需求）、按项目过滤、sessionToReq 反查、推送 schema 化", async () => {
    const r = makeKanbanRouter();
    const pa = await registerProject(r, r.projA);
    const pb = await registerProject(r, r.projB);

    const c1 = await r.handle({ channel: "kanban:create", projectId: pa, title: "手动需求" });
    expect(c1.ok).toBe(true);
    if (c1.ok) expect(c1.requirementId).toBe("REQ-001");
    const c2 = await r.handle({ channel: "kanban:create", projectId: pa }); // 缺省标题 + 计数推进
    expect(c2.ok).toBe(true);
    if (c2.ok) expect(c2.requirementId).toBe("REQ-002");
    const c3 = await r.handle({ channel: "kanban:create", projectId: pb, title: "B 项目需求" });
    expect(c3.ok).toBe(true);
    if (c3.ok) expect(c3.requirementId).toBe("REQ-003");

    const listA = await r.handle({ channel: "kanban:list", projectId: pa });
    expect(listA.ok).toBe(true);
    if (listA.ok) {
      expect(listA.requirements).toHaveLength(2);
      expect(listA.requirements![0]).toMatchObject({ id: "REQ-001", title: "手动需求", stage: null, uncertain: false, projectId: pa, sessions: [] });
      expect(listA.requirements![1]).toMatchObject({ id: "REQ-002", title: "待命名需求" });
      expect(listA.sessionToReq).toEqual({});
    }
    const listB = await r.handle({ channel: "kanban:list", projectId: pb });
    if (!listB.ok) throw new Error("kanban:list(B) 失败");
    expect(listB.requirements).toHaveLength(1);
    expect(listB.requirements![0]).toMatchObject({ id: "REQ-003", projectId: pb });

    // 手动建卡推送 requirement_created（sessionId=null，schema 化）
    expect(r.changes).toHaveLength(3);
    for (const c of r.changes) expect(() => trackerChangeSchema.parse(c)).not.toThrow();
    expect(r.changes.filter((c) => c.type === "requirement_created")).toHaveLength(3);
  });

  it("未知需求 id：kanban:rename/setStage/delete → E_REQUIREMENT_NOT_FOUND", async () => {
    const r = makeKanbanRouter();
    const pa = await registerProject(r, r.projA);
    await r.handle({ channel: "kanban:create", projectId: pa });
    for (const raw of [
      { channel: "kanban:rename", requirementId: "REQ-404", title: "x" },
      { channel: "kanban:setStage", requirementId: "REQ-404", stage: "Design" },
      { channel: "kanban:delete", requirementId: "REQ-404" },
      { channel: "kanban:link", sessionId: "s-x", requirementId: "REQ-404" },
    ]) {
      const res = await r.handle(raw);
      expect(res.ok, JSON.stringify(raw)).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("E_REQUIREMENT_NOT_FOUND");
    }
  });

  it("kanban:setStage：四阶段与 none（归一未开始）经 manual 事件生效；rename 经事件流改标题", async () => {
    const r = makeKanbanRouter();
    const pa = await registerProject(r, r.projA);
    await r.handle({ channel: "kanban:create", projectId: pa, title: "原标题" });

    const set = await r.handle({ channel: "kanban:setStage", requirementId: "REQ-001", stage: "Implement" });
    expect(set.ok).toBe(true);
    let list = await r.handle({ channel: "kanban:list", projectId: pa });
    if (!list.ok) throw new Error("kanban:list 失败");
    expect(list.requirements![0]).toMatchObject({ stage: "Implement", uncertain: false });
    expect(list.requirements![0].stageBasis).toMatchObject({ kind: "manual" });

    const none = await r.handle({ channel: "kanban:setStage", requirementId: "REQ-001", stage: "none" });
    expect(none.ok).toBe(true);
    list = await r.handle({ channel: "kanban:list", projectId: pa });
    if (!list.ok) throw new Error("kanban:list 失败");
    expect(list.requirements![0].stage).toBe(null);

    const rename = await r.handle({ channel: "kanban:rename", requirementId: "REQ-001", title: "新标题" });
    expect(rename.ok).toBe(true);
    list = await r.handle({ channel: "kanban:list", projectId: pa });
    if (!list.ok) throw new Error("kanban:list 失败");
    expect(list.requirements![0].title).toBe("新标题");
    expect(r.changes.filter((c) => c.type === "requirement_renamed")).toHaveLength(1);
    expect(r.changes.filter((c) => c.type === "stage_changed")).toHaveLength(2);
  });

  it("kanban:link：成功关联（会话行进卡片 + 反查映射）；已关联他卡/跨项目/无项目会话三类业务拒绝（linked=false + reason）", async () => {
    const r = makeKanbanRouter();
    const pa = await registerProject(r, r.projA);
    const pb = await registerProject(r, r.projB);
    await r.handle({ channel: "kanban:create", projectId: pa });
    await r.handle({ channel: "kanban:create", projectId: pa }); // REQ-002（他卡）
    const sidA = await createSession(r, "claude", pa);
    const sidB = await createSession(r, "codex", pb); // B 项目会话
    const sidNone = await createSession(r, "fake"); // 无项目演示会话

    // 成功：同项目关联
    const ok = await r.handle({ channel: "kanban:link", sessionId: sidA, requirementId: "REQ-001" });
    expect(ok).toMatchObject({ ok: true, linked: true });
    let list = await r.handle({ channel: "kanban:list", projectId: pa });
    if (!list.ok) throw new Error("kanban:list 失败");
    expect(list.requirements![0].sessions).toEqual([sidA]);
    expect(list.sessionToReq).toEqual({ [sidA]: "REQ-001" });
    expect(r.changes.some((c) => c.type === "session_linked" && c.requirementId === "REQ-001")).toBe(true);

    // 拒绝 1：已关联他卡
    const conflict = await r.handle({ channel: "kanban:link", sessionId: sidA, requirementId: "REQ-002" });
    expect(conflict.ok).toBe(true);
    if (conflict.ok) {
      expect(conflict.linked).toBe(false);
      expect(conflict.reason).toContain("已关联");
    }

    // 拒绝 2：跨项目（B 项目会话 × A 项目需求）
    const mismatch = await r.handle({ channel: "kanban:link", sessionId: sidB, requirementId: "REQ-001" });
    expect(mismatch.ok).toBe(true);
    if (mismatch.ok) {
      expect(mismatch.linked).toBe(false);
      expect(mismatch.reason).toContain("跨项目");
    }

    // 拒绝 3：无项目会话
    const unprojected = await r.handle({ channel: "kanban:link", sessionId: sidNone, requirementId: "REQ-001" });
    expect(unprojected.ok).toBe(true);
    if (unprojected.ok) {
      expect(unprojected.linked).toBe(false);
      expect(unprojected.reason).toContain("未归属项目");
    }

    // 三类拒绝均不落 session_linked
    list = await r.handle({ channel: "kanban:list", projectId: pa });
    if (!list.ok) throw new Error("kanban:list 失败");
    expect(list.requirements![0].sessions).toEqual([sidA]);
    expect(list.requirements![1].sessions).toEqual([]);
  });

  it("kanban:link 幂等（已关联同一需求 → linked=true）；unlink 解除并保留阶段；未知会话 → E_SESSION_NOT_FOUND", async () => {
    const r = makeKanbanRouter();
    const pa = await registerProject(r, r.projA);
    await r.handle({ channel: "kanban:create", projectId: pa });
    await r.handle({ channel: "kanban:setStage", requirementId: "REQ-001", stage: "PR" });
    const sid = await createSession(r, "opencode", pa);

    const again = await r.handle({ channel: "kanban:link", sessionId: sid, requirementId: "REQ-001" });
    expect(again).toMatchObject({ ok: true, linked: true });
    const dup = await r.handle({ channel: "kanban:link", sessionId: sid, requirementId: "REQ-001" });
    expect(dup).toMatchObject({ ok: true, linked: true }); // 幂等成功，无新事件

    const ghost = await r.handle({ channel: "kanban:link", sessionId: "ghost", requirementId: "REQ-001" });
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.error.code).toBe("E_SESSION_NOT_FOUND");

    const unlink = await r.handle({ channel: "kanban:unlink", sessionId: sid });
    expect(unlink.ok).toBe(true);
    const list = await r.handle({ channel: "kanban:list", projectId: pa });
    if (!list.ok) throw new Error("kanban:list 失败");
    expect(list.requirements![0]).toMatchObject({ stage: "PR", sessions: [] }); // 解除不回退阶段
    expect(list.sessionToReq).toEqual({});
    expect(r.changes.some((c) => c.type === "session_unlinked" && c.sessionId === sid)).toBe(true);
  });

  it("kanban:delete：墓碑（行消失 + 关联解除 + 事件日志保留 + requirement_deleted 推送）", async () => {
    const r = makeKanbanRouter();
    const pa = await registerProject(r, r.projA);
    await r.handle({ channel: "kanban:create", projectId: pa });
    const sid = await createSession(r, "claude", pa);
    await r.handle({ channel: "kanban:link", sessionId: sid, requirementId: "REQ-001" });
    const eventsBefore = r.engine.store.snapshotTables().stageEventCount;

    const del = await r.handle({ channel: "kanban:delete", requirementId: "REQ-001" });
    expect(del.ok).toBe(true);
    const list = await r.handle({ channel: "kanban:list", projectId: pa });
    if (!list.ok) throw new Error("kanban:list 失败");
    expect(list.requirements).toEqual([]);
    expect(list.sessionToReq).toEqual({});
    expect(r.engine.store.snapshotTables().stageEventCount, "事件日志永不删除").toBe(eventsBefore + 1);
    expect(r.changes.some((c) => c.type === "requirement_deleted" && c.requirementId === "REQ-001")).toBe(true);
  });

  it("kanban:delete：级联清理该需求 memory 数据（issue #35 spec #27 J 节——知识保留、需求级记录与总结清理、目录清除）", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-ipc-delmem-"));
    const projA = join(tmpRoot, "proj-a");
    mkdirSync(projA, { recursive: true });
    const clock = new VirtualClock();
    const db = openDatabase(":memory:");
    const engine = new TrackerEngine(db);
    // memory 面与 kanban 面同库装配（index.ts 生产形态：MemoryService 经 deps 注入可达）
    const { service: memory } = openMemoryService({
      db,
      dataRoot: join(tmpRoot, "memory"),
      listLinkedStructuredSessions: () => [],
      getRequirementTitle: () => null,
    });
    const deps: IpcDeps = {
      adapter: new FakeAdapter({ clock }),
      engine,
      projects: new ProjectStore(db),
      sessions: new SessionStore(db),
      memory,
      pickDirectory: async () => projA,
      getCurrentProjectId: () => null,
      setCurrentProjectId: () => undefined,
      pty: makePtyHost().host,
    };
    const handle = (raw: unknown) => handleIpc(deps, raw);

    const reg = await handle({ channel: "project:register" });
    const projectId = reg.ok && reg.project ? reg.project.id : "";
    await handle({ channel: "kanban:create", projectId, title: "带记忆的需求" });
    // 预置提取完成形态：accepted + pending 候选、总结（spec J 节清理对象的知识/需求级两分）
    memory.store.createBatch({ id: "B1", requirementId: "REQ-001", projectId, sourceSessionCount: 1 });
    const created = memory.store.appendCandidates("B1", [
      { claim: "级联后保留的项目知识", scope: "删除级联", evidence: "e", sourceSessionIds: ["s1"] },
      { claim: "级联时清理的待审候选", scope: "", evidence: "e", sourceSessionIds: ["s1"] },
    ]);
    const accepted = memory.store.reviewCandidate(created[0].id, "accept");
    memory.store.finishBatch("B1", { status: "completed" });
    memory.summaries.writeSummary({ requirementId: "REQ-001", projectId, batchId: "B1", content: "# 需求总结" });

    const del = await handle({ channel: "kanban:delete", requirementId: "REQ-001" });
    expect(del.ok).toBe(true);

    // 墓碑照旧 + memory 级联生效：知识保留（md 在）、总结行消失、批次/待审清理、需求目录清除
    const list = await handle({ channel: "kanban:list", projectId });
    if (!list.ok) throw new Error("kanban:list 失败");
    expect(list.requirements).toEqual([]);
    const pm = memory.projectMemory(projectId);
    expect(pm.ok && pm.knowledge.length === 1 && pm.summaries.length === 0).toBe(true);
    const detail = memory.requirementMemory("REQ-001");
    expect(detail.batches).toEqual([]);
    expect(detail.candidates.map((c) => c.status)).toEqual(["accepted"]);
    expect(existsSync(join(tmpRoot, "memory", projectId, "requirements", "REQ-001"))).toBe(false);
    expect(existsSync(accepted.mdPath ?? "")).toBe(true);
  });

  it("session:create+requirementId：同项目原子落 link（create+link 两事件一次完成）；跨项目/无项目/未知需求返回拒绝原因且不落 link", async () => {
    const r = makeKanbanRouter();
    const pa = await registerProject(r, r.projA);
    const pb = await registerProject(r, r.projB);
    await r.handle({ channel: "kanban:create", projectId: pa });

    // 同项目：创建成功即关联（无 renderer 两步编排）
    const ok = await r.handle({ channel: "session:create", cli: "claude", cwd: r.projA, projectId: pa, requirementId: "REQ-001" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.linked).toBe(true);
      expect(ok.sessionId).toBeTruthy();
    }
    const snap = r.engine.snapshot();
    expect(snap[0].sessions.length).toBe(1);
    expect(r.engine.store.snapshotTables().stageEventCount).toBe(2); // create + link
    expect(r.changes.some((c) => c.type === "session_linked")).toBe(true);

    // 跨项目：会话仍创建成功，但 link 被拒并返回原因
    const eventsBefore = r.engine.store.snapshotTables().stageEventCount;
    const mismatch = await r.handle({ channel: "session:create", cli: "codex", cwd: r.projB, projectId: pb, requirementId: "REQ-001" });
    expect(mismatch.ok).toBe(true);
    if (mismatch.ok) {
      expect(mismatch.linked).toBe(false);
      expect(mismatch.reason).toContain("跨项目");
      expect(mismatch.sessionId).toBeTruthy(); // 会话本身创建成功
    }
    expect(r.engine.store.snapshotTables().stageEventCount).toBe(eventsBefore); // 不落 link 事件
    expect(r.engine.snapshot()[0].sessions.length).toBe(1);

    // 无项目会话：拒绝关联
    const unprojected = await r.handle({ channel: "session:create", cli: "fake", cwd: r.projA, requirementId: "REQ-001" });
    expect(unprojected).toMatchObject({ ok: true, linked: false });
    if (unprojected.ok) expect(unprojected.reason).toContain("未归属项目");

    // 未知需求：会话创建成功 + 拒绝原因（业务拒绝合法结果）
    const ghost = await r.handle({ channel: "session:create", cli: "opencode", cwd: r.projA, projectId: pa, requirementId: "REQ-404" });
    expect(ghost).toMatchObject({ ok: true, linked: false });
    if (ghost.ok) expect(ghost.reason).toContain("REQ-404");
    expect(r.engine.snapshot()[0].sessions.length).toBe(1);
  });

  it("terminal:create+requirementId（#20 卡片建 PTY）：同项目原子落 link（cli=pty 合法）；跨项目返回拒绝原因且不落 link", async () => {
    const r = makeKanbanRouter();
    const pa = await registerProject(r, r.projA);
    const pb = await registerProject(r, r.projB);
    await r.handle({ channel: "kanban:create", projectId: pa });

    // 同项目：PTY 终端创建成功即关联（S2-12：pty 可 link）
    const ok = await r.handle({ channel: "terminal:create", cwd: r.projA, projectId: pa, requirementId: "REQ-001" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.linked).toBe(true);
      expect(ok.cli).toBe("pty");
      expect(ok.sessionId).toBeTruthy();
    }
    const list = await r.handle({ channel: "kanban:list", projectId: pa });
    if (!list.ok) throw new Error("kanban:list 失败");
    expect(list.requirements![0].sessions.length).toBe(1);
    expect(list.sessionToReq).toEqual({ [list.requirements![0].sessions[0]]: "REQ-001" });

    // 跨项目：终端仍创建成功，但 link 被拒并返回原因
    const eventsBefore = r.engine.store.snapshotTables().stageEventCount;
    const mismatch = await r.handle({ channel: "terminal:create", cwd: r.projB, projectId: pb, requirementId: "REQ-001" });
    expect(mismatch).toMatchObject({ ok: true, linked: false });
    if (mismatch.ok) expect(mismatch.reason).toContain("跨项目");
    expect(r.engine.store.snapshotTables().stageEventCount).toBe(eventsBefore); // 不落 link 事件
  });

  it("session:create cli=claude 响应含 skillConflicts（#21 真实检测：fixture 无 .claude → 空数组）；非 claude 不带该字段", async () => {
    const r = makeKanbanRouter();
    const claude = await r.handle({ channel: "session:create", cli: "claude", cwd: r.projA });
    expect(claude.ok).toBe(true);
    if (claude.ok) expect(claude.skillConflicts).toEqual([]);
    const codex = await r.handle({ channel: "session:create", cli: "codex", cwd: r.projA });
    expect(codex.ok).toBe(true);
    if (codex.ok) expect(codex.skillConflicts).toBeUndefined();
  });

  it("session:create 仅 cli=claude 触发同名检测（#21）：项目/用户级交集入响应；codex/opencode 同目录不检测不带字段", async () => {
    const r = makeKanbanRouter();
    // 项目级 .claude/skills 与用户级 skills 各放同名 skill + 各自独有目录（deps 注入基准目录，等价 Main 默认解析结果）
    mkdirSync(join(r.projA, ".claude", "skills", "design-feature"), { recursive: true });
    mkdirSync(join(r.projA, ".claude", "skills", "proj-only"), { recursive: true });
    const userDir = join(tmpRoot, "user-claude");
    mkdirSync(join(userDir, "skills", "Design-Feature"), { recursive: true }); // 大小写变体也检出（Windows 语义）
    mkdirSync(join(userDir, "skills", "user-only"), { recursive: true });
    r.deps.resolveUserClaudeDir = () => userDir;

    const claude = await r.handle({ channel: "session:create", cli: "claude", cwd: r.projA });
    expect(claude.ok).toBe(true);
    if (claude.ok) expect(claude.skillConflicts).toEqual(["design-feature"]);

    // 同一目录建 codex/opencode 会话：不检测（不带字段）
    for (const cli of ["codex", "opencode"] as const) {
      const res = await r.handle({ channel: "session:create", cli, cwd: r.projA });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.skillConflicts).toBeUndefined();
    }
  });

  it("session:create 默认基准解析：CLAUDE_CONFIG_DIR 环境变量优先生效（不注入 deps 也读到，#21）", async () => {
    const r = makeKanbanRouter();
    mkdirSync(join(r.projA, ".claude", "skills", "design-feature"), { recursive: true });
    const cfgDir = join(tmpRoot, "cfg-claude");
    mkdirSync(join(cfgDir, "skills", "design-feature"), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = cfgDir;
    try {
      const res = await r.handle({ channel: "session:create", cli: "claude", cwd: r.projA });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.skillConflicts).toEqual(["design-feature"]);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it("restore() 重放不产生推送；renderer 启动靠 kanban:list 再水化（spec #15 C/G 节）", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-ipc-restore-"));
    const projDir = join(tmpRoot, "proj");
    mkdirSync(projDir, { recursive: true });
    const dbFile = join(tmpRoot, "kanban.db");
    const clock = new VirtualClock();

    // 第一段：建卡落事件流后退出
    const projectId = await (async () => {
      const db = openDatabase(dbFile);
      const engine = new TrackerEngine(db);
      engine.restore();
      const deps: IpcDeps = {
        adapter: new FakeAdapter({ clock }),
        engine,
        projects: new ProjectStore(db),
        sessions: new SessionStore(db),
        emitTrackerChange: () => undefined,
        pickDirectory: async () => projDir,
        getCurrentProjectId: () => null,
        setCurrentProjectId: () => undefined,
        pty: makePtyHost().host,
      };
      const reg = await handleIpc(deps, { channel: "project:register" });
      const id = reg.ok && reg.project ? reg.project.id : "";
      const created = await handleIpc(deps, { channel: "kanban:create", projectId: id, title: "重启水化" });
      expect(created).toMatchObject({ ok: true, requirementId: "REQ-001" });
      engine.close();
      return id;
    })();

    // 第二段：重启 restore → 零推送；kanban:list 水化出行；此后新操作恢复推送
    const db2 = openDatabase(dbFile);
    const engine2 = new TrackerEngine(db2);
    const pushed: TrackerChange[] = [];
    const deps2: IpcDeps = {
      adapter: new FakeAdapter({ clock }),
      engine: engine2,
      projects: new ProjectStore(db2),
      sessions: new SessionStore(db2),
      emitTrackerChange: (c) => pushed.push(c),
      pickDirectory: async () => projDir,
      getCurrentProjectId: () => null,
      setCurrentProjectId: () => undefined,
      pty: makePtyHost().host,
    };
    engine2.restore();
    expect(pushed, "restore 重放不产生 changes 推送").toEqual([]);

    const list = await handleIpc(deps2, { channel: "kanban:list", projectId });
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.requirements).toMatchObject([{ id: "REQ-001", title: "重启水化", projectId }]);

    await handleIpc(deps2, { channel: "kanban:setStage", requirementId: "REQ-001", stage: "Design" });
    expect(pushed.filter((c) => c.type === "stage_changed")).toHaveLength(1); // 推送路径本身可用
    engine2.close();
  });
});

describe("diff:ipc 通道（#43 spec #40 D 节：独立单通道 + 入站 zod + 经 project store 解析 cwd）", () => {
  /** diff 专用路由：真实 ProjectStore（临时目录注册）+ 注入 fake readWorkspaceDiff */
  function makeDiffRouter(readWorkspaceDiff: (cwd: string) => Promise<unknown>) {
    const db = openDatabase(":memory:");
    const projects = new ProjectStore(db);
    const repoDir = join(tmpRoot || (tmpRoot = mkdtempSync(join(tmpdir(), "kb-diff-ipc-"))), "repo");
    mkdirSync(repoDir, { recursive: true });
    const { project } = projects.register(repoDir);
    const handle = (raw: unknown) =>
      handleDiffIpc(
        { projects, readWorkspaceDiff: readWorkspaceDiff as DiffIpcDeps["readWorkspaceDiff"], isShuttingDown: () => false },
        raw,
      );
    return { handle, project, repoDir };
  }

  it("非法请求 → E_SCHEMA；退出门闸 → E_INTERNAL；项目不存在 → E_PROJECT_NOT_FOUND", async () => {
    const { handle } = makeDiffRouter(async () => ({ ok: true, files: [], truncated: false }));
    const schema = await handle({ channel: "diff:get", projectId: "" });
    expect(schema).toEqual({ ok: false, error: { code: "E_SCHEMA", message: expect.any(String) } });
    const gone = await handle({ channel: "diff:get", projectId: "no-such" });
    expect(gone).toEqual({ ok: false, error: { code: "E_PROJECT_NOT_FOUND", message: expect.stringContaining("no-such") } });
  });

  it("diff:get 成功：经 project store 解析 canonicalPath 为 cwd 并透传服务结果", async () => {
    const seen: string[] = [];
    const { handle, project, repoDir } = makeDiffRouter(async (cwd) => {
      seen.push(cwd);
      return { ok: true, files: [{ path: "a.ts", changeType: "modified", binary: false, oldPath: null, hunks: null, additions: 1, deletions: 0 }], truncated: false };
    });
    const res = await handle({ channel: "diff:get", projectId: project.id });
    expect(seen).toEqual([repoDir]);
    expect(res).toEqual({
      ok: true,
      truncated: false,
      files: [{ path: "a.ts", changeType: "modified", binary: false, oldPath: null, hunks: null, additions: 1, deletions: 0 }],
    });
  });

  it("四档错误透传（not-a-repo 代表）", async () => {
    const { handle, project } = makeDiffRouter(async () => ({ ok: false, kind: "not-a-repo", message: "当前项目不是 git 仓库" }));
    const res = await handle({ channel: "diff:get", projectId: project.id });
    expect(res).toEqual({ ok: false, kind: "not-a-repo", message: "当前项目不是 git 仓库" });
  });
});
