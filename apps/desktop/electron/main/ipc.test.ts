// 用途：Main 入站 IPC 路由单测 —— zod 强制校验（非法消息明确错误码 E_SCHEMA）+ 各通道路由到 Adapter/store + AdapterError 错误码透传（spec E/#6 验收第 4 条/#7 project/session 通道；#17 kanban 七通道 + 原子关联 + tracker 推送）
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdapterError, FakeAdapter, VirtualClock, type CliAdapter, type ListCommandsInput, type ListModelsInput } from "@kanban/cli-host";
import { trackerChangeSchema } from "@kanban/ipc-schema";
import { TrackerEngine, type TrackerChange } from "@kanban/tracker";
import { openDatabase } from "./db";
import { defaultConfig, loadConfig, openLiveConfig, saveConfig, type AppConfig } from "./config";
import { handleCliStatusIpc, handleConfigIpc, handleDiffIpc, handleIpc, handleModelsIpc, type ConfigIpcDeps, type DiffIpcDeps, type IpcDeps, type ModelsIpcDeps } from "./ipc";
import { CommandCatalog } from "./command-catalog";
import { openMemoryService } from "./memory-service";
import type { LogFn, LogLevel } from "./logger";
import type { PtyHost } from "./pty-host";
import { ProjectStore } from "./project-store";
import { createAdapterSessionProcesses, createSessionLifecycle } from "./session-lifecycle";
import { SessionStore } from "./session-store";

let tmpRoot = "";

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

/** 路由级 fake PTY 宿主：记录 spawn/write/kill 调用（PTY 行为由 pty-host.test.ts 覆盖） */
function makePtyHost() {
  const spawned: Array<{ terminalId: string; cwd: string }> = [];
  const writes: Array<{ terminalId: string; data: string }> = [];
  const killed: string[] = [];
  const running = new Set<string>();
  const host: PtyHost = {
    spawn: (terminalId, req) => {
      spawned.push({ terminalId, cwd: req.cwd });
      running.add(terminalId);
      return { ok: true, label: "pwsh", shell: "pwsh.exe", cwd: req.cwd };
    },
    write: (terminalId, data) => {
      if (!running.has(terminalId)) return { ok: false, message: "终端未运行" };
      writes.push({ terminalId, data });
      return { ok: true };
    },
    resize: () => undefined,
    kill: (terminalId) => {
      killed.push(terminalId);
      running.delete(terminalId);
    },
    isRunning: (terminalId) => running.has(terminalId),
    killAll: () => running.clear(),
  };
  return { host, spawned, writes, killed, drop: (id: string) => running.delete(id) };
}

/** 构造 VirtualClock 驱动的 FakeAdapter + 路由器（无持久化通道，#6 既有行为回归用） */
function makeRouter() {
  const clock = new VirtualClock();
  const adapter = new FakeAdapter({ clock });
  const deps = makeDeps(adapter);
  return { clock, adapter, deps, handle: (raw: unknown) => handleIpc(deps, raw) };
}

/** 完整 deps：内存 store + 可注入的目录选择和当前项目存取（#17 起挂 TrackerEngine：kanban 通道落事件流；#70 起挂 lifecycle：归档/删除编排唯一写者） */
function makeDeps(adapter: CliAdapter, pick: () => Promise<string | null> = async () => null, ptyHost = makePtyHost()): IpcDeps {
  const db = openDatabase(":memory:");
  let currentProjectId: string | null = null;
  const sessions = new SessionStore(db);
  return {
    adapter,
    engine: new TrackerEngine(db),
    projects: new ProjectStore(db),
    sessions,
    lifecycle: createSessionLifecycle({ sessions, procs: createAdapterSessionProcesses(adapter, ptyHost.host) }),
    pickDirectory: pick,
    getCurrentProjectId: () => currentProjectId,
    setCurrentProjectId: (id) => {
      currentProjectId = id;
    },
    pty: ptyHost.host,
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

  it("session:create 附实际采用 model（issue #76：fake 透传请求值）", async () => {
    const { handle } = makeRouter();
    const res = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p", model: "fake-standard" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.model).toBe("fake-standard");
  });

  it("session:setModel：idle 可切——adapter 生效模型回传；未知会话 E_SESSION_NOT_FOUND（issue #79）", async () => {
    const { handle } = makeRouter();
    const created = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p", model: "fake-standard" });
    const sessionId = created.ok ? created.sessionId! : "";
    const r = await handle({ channel: "session:setModel", sessionId, model: "fake-lite" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model).toBe("fake-lite");
    const ghost = await handle({ channel: "session:setModel", sessionId: "ghost", model: "x" });
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.error.code).toBe("E_SESSION_NOT_FOUND");
  });

  it("session:setModel main 侧校验：本轮进行中（running/waiting）拒绝、断开拒绝、interrupted/idle 可切（issue #79 三 CLI 统一语义）", async () => {
    const { deps, handle } = makeRouter();
    const created = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p" });
    const sessionId = created.ok ? created.sessionId! : "";
    const setModel = () => handle({ channel: "session:setModel", sessionId, model: "fake-lite" });
    deps.sessions.updateStatus(sessionId, "running");
    let r = await setModel();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe("本轮进行中，结束后再切换");
    deps.sessions.updateStatus(sessionId, "waiting"); // 审批待决 = 本轮未结束
    r = await setModel();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe("本轮进行中，结束后再切换");
    deps.sessions.updateStatus(sessionId, "interrupted"); // 本轮已结束：可切
    r = await setModel();
    expect(r.ok).toBe(true);
    deps.sessions.updateStatus(sessionId, "disconnected");
    r = await setModel();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe("会话已断开，恢复后可切换");
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

    // 抛非 AdapterError 的 adapter → E_INTERNAL 兜底（arch C13：可选面缺席如实声明，本测试只驱动 session:send）
    const boom = {
      capabilities: { approval: true, interrupt: true, resume: true, readHistory: true, skillSignal: true, adoptSession: false, runOnce: false, listChildPids: false, summarizeTitle: false },
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
        titleSource: "default", // review A1：wire 行回带标题来源（#94 验收「session:list 回带 source」）
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
    const adapter = new FakeAdapter({ clock });
    const sessions = new SessionStore(db);
    // arch C12：create 编排经 lifecycle 的 SessionProcesses 分派到 PTY 宿主——失败注入须对齐生产装配
    //（index.ts 中 deps.pty 与 lifecycle 的 procs 是同一 ptyHost 实例），不能只覆盖 deps.pty 一侧
    const pty: PtyHost = opts?.failSpawn
      ? {
          ...ptyState.host,
          spawn: () => ({ ok: false, message: "启动失败：spawn boom" }),
        }
      : ptyState.host;
    const deps: IpcDeps = {
      adapter,
      engine: new TrackerEngine(db),
      projects: new ProjectStore(db),
      sessions,
      lifecycle: createSessionLifecycle({ sessions, procs: createAdapterSessionProcesses(adapter, pty) }),
      pickDirectory: async () => projDir,
      getCurrentProjectId: () => null,
      setCurrentProjectId: () => undefined,
      pty,
    };
    return { deps, ptyState, projDir, handle: (raw: unknown) => handleIpc(deps, raw) };
  }

  it("terminal:create：渲染端预生成 id 落库（kind=pty/cli=pty）+ 目录身份 + 默认标题「终端 · label」启动后回写", async () => {
    const { handle, ptyState, projDir } = makeTerminalRouter();
    const terminalId = randomUUID(); // #60：渲染端草稿预生成的终端 id
    const created = await handle({ channel: "terminal:create", terminalId, cwd: projDir, cols: 120, rows: 40 });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.sessionId).toBe(terminalId); // 应用渲染端 id（单一 id 空间）
      expect(created.cli).toBe("pty");
      expect(created.title).toBe("终端 · pwsh");
      expect(created.dirIdentity).toBe("main");
    }
    expect(ptyState.spawned).toHaveLength(1);

    const list = await handle({ channel: "session:list" });
    if (!list.ok) throw new Error("session:list 失败");
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions![0]).toMatchObject({
      id: terminalId,
      kind: "pty",
      cli: "pty",
      nativeSessionId: null,
      status: "idle",
      title: "终端 · pwsh",
    });
  });

  it("terminal:create 携带 firstInput（#60 草稿首输入）：spawn 成功后重放（含中文/多字符不丢失）", async () => {
    const { handle, ptyState } = makeTerminalRouter();
    const terminalId = randomUUID();
    const res = await handle({ channel: "terminal:create", terminalId, cwd: "C:\\p", firstInput: "中文abc\r" });
    expect(res.ok).toBe(true);
    expect(ptyState.spawned).toHaveLength(1); // 先 spawn
    expect(ptyState.writes).toEqual([{ terminalId, data: "中文abc\r" }]); // 后重放首输入
  });

  it("terminal:create spawn 失败 → E_INTERNAL 且回删占位行（无孤儿记录：默认列表与重启均无）", async () => {
    const { handle, deps } = makeTerminalRouter({ failSpawn: true });
    const terminalId = randomUUID();
    const res = await handle({ channel: "terminal:create", terminalId, cwd: "C:\\p" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_INTERNAL");
    // 先落库占位→失败回删：结束后无行（直接查 store 等价「重启读回」视角）
    expect(deps.sessions.get(terminalId)).toBeNull();
    const list = await handle({ channel: "session:list" });
    if (!list.ok) throw new Error("session:list 失败");
    expect(list.sessions).toHaveLength(0);
  });

  it("terminal:create 终端 id 与既有会话冲突 → E_SESSION_EXISTS 明确报错（单一 id 空间保护，不启动进程）", async () => {
    const { handle, ptyState } = makeTerminalRouter();
    const terminalId = randomUUID();
    // 预置同 id 会话行（模拟历史行/并发创建）
    const seed = await handle({ channel: "terminal:create", terminalId, cwd: "C:\\p" });
    expect(seed.ok).toBe(true);
    const again = await handle({ channel: "terminal:create", terminalId, cwd: "C:\\p" });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe("E_SESSION_EXISTS");
      expect(again.error.message).toContain(terminalId);
    }
    expect(ptyState.spawned).toHaveLength(1); // 冲突请求不 spawn
  });

  it("terminal:write/resize/kill 路由：成功 ok；未运行/未知终端 → E_SESSION_NOT_FOUND", async () => {
    const { handle, ptyState } = makeTerminalRouter();
    const created = await handle({ channel: "terminal:create", terminalId: randomUUID(), cwd: "C:\\p" });
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

  it("非法 terminal 载荷 → E_SCHEMA（缺 terminalId / 非 uuid 终端 id / 空 cwd）", async () => {
    const { handle } = makeTerminalRouter();
    const cases: unknown[] = [
      { channel: "terminal:write", data: "x" },
      { channel: "terminal:resize", terminalId: "t", cols: 0, rows: 30 },
      { channel: "terminal:create", cwd: "C:\\p" }, // #60：缺渲染端预生成 terminalId
      { channel: "terminal:create", terminalId: "not-a-uuid", cwd: "C:\\p" }, // #60：id 须与 randomUUID 同 uuid 格式
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
    const adapter = new FakeAdapter({ clock });
    const sessions = new SessionStore(db);
    const deps: IpcDeps = {
      adapter,
      engine,
      projects: new ProjectStore(db),
      sessions,
      lifecycle: createSessionLifecycle({ sessions, procs: createAdapterSessionProcesses(adapter, makePtyHost().host) }),
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
    const adapter = new FakeAdapter({ clock });
    const sessions = new SessionStore(db);
    const deps: IpcDeps = {
      adapter,
      engine,
      projects: new ProjectStore(db),
      sessions,
      lifecycle: createSessionLifecycle({ sessions, procs: createAdapterSessionProcesses(adapter, makePtyHost().host) }),
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
    const ok = await r.handle({ channel: "terminal:create", terminalId: randomUUID(), cwd: r.projA, projectId: pa, requirementId: "REQ-001" });
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
    const mismatch = await r.handle({ channel: "terminal:create", terminalId: randomUUID(), cwd: r.projB, projectId: pb, requirementId: "REQ-001" });
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
      const adapter = new FakeAdapter({ clock });
      const sessions = new SessionStore(db);
      const deps: IpcDeps = {
        adapter,
        engine,
        projects: new ProjectStore(db),
        sessions,
        lifecycle: createSessionLifecycle({ sessions, procs: createAdapterSessionProcesses(adapter, makePtyHost().host) }),
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
    const adapter2 = new FakeAdapter({ clock });
    const sessions2 = new SessionStore(db2);
    const deps2: IpcDeps = {
      adapter: adapter2,
      engine: engine2,
      projects: new ProjectStore(db2),
      sessions: sessions2,
      lifecycle: createSessionLifecycle({ sessions: sessions2, procs: createAdapterSessionProcesses(adapter2, makePtyHost().host) }),
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

describe("session:create 首条消息原子化（#59：草稿提交 = 创建原生会话→落库→发送首条消息，任一步失败回滚不留空会话）", () => {
  /** 草稿原子化专用 adapter：createSession 可注入失败；sendTurn 前 N 次抛错（驱动「创建成功但发送失败」）；dispose 记录调用 */
  function makeAtomicAdapter(opts?: { failCreate?: boolean; failSendFirst?: number }) {
    const clock = new VirtualClock();
    const base = new FakeAdapter({ clock });
    let seq = 0;
    let sendCalls = 0;
    const disposed: Array<string | undefined> = [];
    const sentTurns: Array<{ sessionId: string; text: string }> = [];
    const adapter = {
      // arch C13：包装层未透传可选面方法——能力如实声明缺席（本夹具只驱动 create/send/dispose）；arch D2：createSession 覆盖移入 forCli 句柄
      capabilities: { ...base.capabilities, adoptSession: false, runOnce: false, listChildPids: false },
      forCli: (cli?: string) => {
        const dir = base.forCli(cli);
        return {
          createSession: async () => {
            seq += 1;
            if (opts?.failCreate) throw new AdapterError("E_SPAWN_NOT_FOUND", "未找到 CLI 可执行文件（注入）");
            return { sessionId: `s-draft-${seq}` };
          },
          listModels: (i: ListModelsInput) => dir.listModels(i),
          listCommands: (i: ListCommandsInput) => dir.listCommands(i),
        };
      },
      sendTurn: async (input: { sessionId: string; text: string }) => {
        sendCalls += 1;
        if (sendCalls <= (opts?.failSendFirst ?? 0)) throw new AdapterError("E_INTERNAL", "发送失败（注入）");
        sentTurns.push(input);
      },
      interruptTurn: async () => {},
      resolveApproval: async () => {},
      readHistory: async () => [],
      resume: async () => {},
      dispose: async (input?: { sessionId?: string }) => {
        disposed.push(input?.sessionId);
      },
      subscribe: () => () => undefined,
    };
    return { adapter: adapter as unknown as CliAdapter, disposed, sentTurns };
  }

  it("firstMessage 成功（Fake 全链）：落库 + 首条 turn 已提交（turn_started 事件可见）+ 响应 ok", async () => {
    const clock = new VirtualClock();
    const deps = makeDeps(new FakeAdapter({ clock }));
    const handle = (raw: unknown) => handleIpc(deps, raw);
    // 订阅先于创建（turn_started 在 create+send 编排内发出）
    const turns: string[] = [];
    deps.adapter.subscribe((e) => {
      if ("type" in e && e.type === "turn_started") turns.push(e.sessionId);
    });
    const r = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p", firstMessage: "首条消息" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sessionId).toBeTruthy();
      expect(r.title).toBe("首条消息"); // #94：firstMessage 携带时标题 = 派生标题（随行原子落库）
    }
    // 落库（重启恢复依据）+ 首条消息送达 adapter（turn 已提交，事件流可见）
    expect(deps.sessions.get(r.ok ? r.sessionId! : "")).toMatchObject({ cli: "fake", status: "idle" });
    expect(turns).toContain(r.ok ? r.sessionId! : "");
  });

  it("发送失败：回滚删除已插记录（重启后不被恢复）+ 受控终止 + 明确错误；重试成功正常入库", async () => {
    const { adapter, disposed, sentTurns } = makeAtomicAdapter({ failSendFirst: 1 });
    const deps = makeDeps(adapter);
    const handle = (raw: unknown) => handleIpc(deps, raw);

    const r1 = await handle({ channel: "session:create", cli: "claude", cwd: "C:\\p", firstMessage: "首条" });
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.error.code).toBe("E_INTERNAL");
      expect(r1.error.message).toContain("发送失败");
    }
    // 回滚：记录已删（session:list 空 = 重启后不被恢复）、受控终止已调
    expect(deps.sessions.get("s-draft-1")).toBeNull();
    expect(deps.sessions.list()).toHaveLength(0);
    expect(disposed).toEqual(["s-draft-1"]);

    // 重试（同参数再发）：成功后正常入库、首条消息原样送达
    const r2 = await handle({ channel: "session:create", cli: "claude", cwd: "C:\\p", firstMessage: "首条" });
    expect(r2.ok).toBe(true);
    expect(deps.sessions.get("s-draft-2")).toMatchObject({ cli: "claude", status: "idle" });
    expect(sentTurns).toEqual([{ sessionId: "s-draft-2", text: "首条" }]);
  });

  it("创建失败（如 CLI 不存在）：错误透传、无落库、无回滚副作用", async () => {
    const { adapter, disposed } = makeAtomicAdapter({ failCreate: true });
    const deps = makeDeps(adapter);
    const r = await handleIpc(deps, { channel: "session:create", cli: "claude", cwd: "C:\\p", firstMessage: "首条" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("E_SPAWN_NOT_FOUND");
    expect(deps.sessions.list()).toHaveLength(0);
    expect(disposed).toEqual([]); // 创建失败在落库前，无需终止
  });

  it("firstMessage + requirementId：发送成功后关联落到新会话（sessionToReq 可见）", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-ipc-draft-link-"));
    const projDir = join(tmpRoot, "repo");
    mkdirSync(projDir, { recursive: true });
    const { adapter } = makeAtomicAdapter();
    const deps = makeDeps(adapter, async () => projDir);
    const handle = (raw: unknown) => handleIpc(deps, raw);
    const reg = await handle({ channel: "project:register" });
    const projectId = reg.ok && reg.project ? reg.project.id : null;
    await handle({ channel: "kanban:create", projectId, title: "草稿关联需求" });
    const reqId = projectId ? "REQ-001" : "REQ-001";

    const r = await handle({
      channel: "session:create",
      cli: "fake",
      cwd: projDir,
      projectId: projectId ?? undefined,
      requirementId: reqId,
      firstMessage: "带关联的首条",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.linked).toBe(true);
    const list = await handle({ channel: "kanban:list" });
    if (list.ok) expect(list.sessionToReq?.["s-draft-1"]).toBe("REQ-001");
  });

  it("非 AdapterError 的发送异常：E_INTERNAL 兜底且同样回滚", async () => {
    const clock = new VirtualClock();
    const base = new FakeAdapter({ clock });
    const adapter = {
      // arch C13：包装层未透传可选面方法——能力如实声明缺席（本夹具只驱动 create/send/dispose）
      capabilities: { ...base.capabilities, adoptSession: false, runOnce: false, listChildPids: false },
      createSession: async () => ({ sessionId: "s-internal" }),
      sendTurn: async () => {
        throw new Error("boom");
      },
      interruptTurn: async () => {},
      resolveApproval: async () => {},
      readHistory: async () => [],
      resume: async () => {},
      dispose: async () => {},
      subscribe: () => () => undefined,
    };
    const deps = makeDeps(adapter as unknown as CliAdapter);
    const r = await handleIpc(deps, { channel: "session:create", cli: "fake", cwd: "C:\\p", firstMessage: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("E_INTERNAL");
    expect(deps.sessions.get("s-internal")).toBeNull();
  });
});

describe("会话标题派生与手动重命名（#94 / ADR 0003：四态状态机 + 派生挂 IPC）", () => {
  it("session:create 无 firstMessage：默认标题 + title_source=default（既有行为不变）", async () => {
    const deps = makeDeps(new FakeAdapter({ clock: new VirtualClock() }));
    const handle = (raw: unknown) => handleIpc(deps, raw);
    const r = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.title).toBe("新会话 · Fake");
    expect(deps.sessions.get(r.ok ? r.sessionId! : "")).toMatchObject({ title: "新会话 · Fake", titleSource: "default" });
  });

  it("session:create+firstMessage：标题随行原子派生（去/压空白），落库 derived", async () => {
    const deps = makeDeps(new FakeAdapter({ clock: new VirtualClock() }));
    const handle = (raw: unknown) => handleIpc(deps, raw);
    const r = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p", firstMessage: "  调研\tVite 构建\n配置  " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.title).toBe("调研 Vite 构建 配置");
    expect(deps.sessions.get(r.ok ? r.sessionId! : "")).toMatchObject({ title: "调研 Vite 构建 配置", titleSource: "derived" });
  });

  it("session:create+firstMessage+显式 title：派生仍优先（请求 title 仅为草稿占位名，非用户意图命名）", async () => {
    const deps = makeDeps(new FakeAdapter({ clock: new VirtualClock() }));
    const handle = (raw: unknown) => handleIpc(deps, raw);
    const r = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p", title: "新会话 · Fake", firstMessage: "首条意图消息" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.title).toBe("首条意图消息");
    expect(deps.sessions.get(r.ok ? r.sessionId! : "")).toMatchObject({ title: "首条意图消息", titleSource: "derived" });
  });

  it("session:create+firstMessage 纯空白：派生为空回退默认标题（default，不落空标题）", async () => {
    const deps = makeDeps(new FakeAdapter({ clock: new VirtualClock() }));
    const handle = (raw: unknown) => handleIpc(deps, raw);
    const r = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p", firstMessage: "   " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.title).toBe("新会话 · Fake");
    expect(deps.sessions.get(r.ok ? r.sessionId! : "")).toMatchObject({ title: "新会话 · Fake", titleSource: "default" });
  });

  it("session:create+firstMessage 发送失败回滚：派生标题随行删除（回滚天然一致，不留「来自未发出消息」的标题）", async () => {
    const clock = new VirtualClock();
    const base = new FakeAdapter({ clock });
    const adapter = {
      // arch C13：包装层未透传可选面方法——能力如实声明缺席（本夹具只驱动 create/send/dispose）
      capabilities: { ...base.capabilities, adoptSession: false, runOnce: false, listChildPids: false },
      createSession: async () => ({ sessionId: "s-rollback-title" }),
      sendTurn: async () => {
        throw new AdapterError("E_INTERNAL", "发送失败（注入）");
      },
      interruptTurn: async () => {},
      resolveApproval: async () => {},
      readHistory: async () => [],
      resume: async () => {},
      dispose: async () => {},
      subscribe: () => () => undefined,
    };
    const deps = makeDeps(adapter as unknown as CliAdapter);
    const r = await handleIpc(deps, { channel: "session:create", cli: "fake", cwd: "C:\\p", firstMessage: "不会成功的首条" });
    expect(r.ok).toBe(false);
    expect(deps.sessions.get("s-rollback-title")).toBeNull(); // 整行回滚（标题随行消失）
  });

  it("session:send 成功：sendTurn 后派生（响应带回新标题，renderer 即时刷新无需推送）", async () => {
    const deps = makeDeps(new FakeAdapter({ clock: new VirtualClock() }));
    const handle = (raw: unknown) => handleIpc(deps, raw);
    const created = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p" });
    const sessionId = created.ok ? created.sessionId! : "";
    const r = await handle({ channel: "session:send", sessionId, text: "第一条正经消息" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.title).toBe("第一条正经消息");
    expect(deps.sessions.get(sessionId)).toMatchObject({ title: "第一条正经消息", titleSource: "derived" });
  });

  it("session:send 派生单向：已 derived 后第二条消息不覆盖（响应不带 title）", async () => {
    const deps = makeDeps(new FakeAdapter({ clock: new VirtualClock() }));
    const handle = (raw: unknown) => handleIpc(deps, raw);
    const created = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p" });
    const sessionId = created.ok ? created.sessionId! : "";
    await handle({ channel: "session:send", sessionId, text: "第一条消息" });
    const r2 = await handle({ channel: "session:send", sessionId, text: "第二条消息" });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.title).toBeUndefined();
    expect(deps.sessions.get(sessionId)).toMatchObject({ title: "第一条消息", titleSource: "derived" });
  });

  it("session:list 回带 titleSource（review A1：状态机各态经 wire 行透出，#94 验收）", async () => {
    const deps = makeDeps(new FakeAdapter({ clock: new VirtualClock() }));
    const handle = (raw: unknown) => handleIpc(deps, raw);
    const created = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p" });
    const sessionId = created.ok ? created.sessionId! : "";
    await handle({ channel: "session:send", sessionId, text: "首条消息" }); // default → derived
    await handle({ channel: "session:rename", sessionId, title: "手动名" }); // → manual
    const list = await handle({ channel: "session:list" });
    if (!list.ok) throw new Error("session:list 失败");
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions![0]).toMatchObject({ title: "手动名", titleSource: "manual" });
  });

  it("session:send 失败：不派生（标题保持原值，无「来自未发出消息」的标题）", async () => {
    const clock = new VirtualClock();
    const base = new FakeAdapter({ clock });
    const adapter = {
      // arch C13：包装层未透传可选面方法——能力如实声明缺席（本夹具只驱动 create/send/dispose）；arch D2：createSession 覆盖移入 forCli 句柄
      capabilities: { ...base.capabilities, adoptSession: false, runOnce: false, listChildPids: false },
      forCli: () => ({
        createSession: async () => ({ sessionId: "s-send-fail" }),
        listModels: async () => [],
        listCommands: async () => [],
      }),
      sendTurn: async () => {
        throw new Error("boom");
      },
      interruptTurn: async () => {},
      resolveApproval: async () => {},
      readHistory: async () => [],
      resume: async () => {},
      dispose: async () => {},
      subscribe: () => () => undefined,
    };
    const deps = makeDeps(adapter as unknown as CliAdapter);
    const handle = (raw: unknown) => handleIpc(deps, raw);
    await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p" });
    const r = await handle({ channel: "session:send", sessionId: "s-send-fail", text: "失败消息" });
    expect(r.ok).toBe(false);
    expect(deps.sessions.get("s-send-fail")).toMatchObject({ title: "新会话 · Fake", titleSource: "default" });
  });

  it("session:rename：置 manual 并回带标题；此后 session:send 派生不覆盖（手动主权）", async () => {
    const deps = makeDeps(new FakeAdapter({ clock: new VirtualClock() }));
    const handle = (raw: unknown) => handleIpc(deps, raw);
    const created = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p" });
    const sessionId = created.ok ? created.sessionId! : "";
    const r = await handle({ channel: "session:rename", sessionId, title: "我起的名字" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.title).toBe("我起的名字");
    expect(deps.sessions.get(sessionId)).toMatchObject({ title: "我起的名字", titleSource: "manual" });
    // manual 终态：后续消息派生被门控拒绝
    const send = await handle({ channel: "session:send", sessionId, text: "重命名后的消息" });
    expect(send.ok).toBe(true);
    if (send.ok) expect(send.title).toBeUndefined();
    expect(deps.sessions.get(sessionId)).toMatchObject({ title: "我起的名字", titleSource: "manual" });
  });

  it("session:rename 未知会话 → E_SESSION_NOT_FOUND；空标题 → E_SCHEMA", async () => {
    const deps = makeDeps(new FakeAdapter({ clock: new VirtualClock() }));
    const handle = (raw: unknown) => handleIpc(deps, raw);
    const ghost = await handle({ channel: "session:rename", sessionId: "ghost", title: "x" });
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.error.code).toBe("E_SESSION_NOT_FOUND");
    const empty = await handle({ channel: "session:rename", sessionId: "ghost", title: "" });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe("E_SCHEMA");
  });

  it("session:rename PTY 行拒绝（review S5/C1：ADR 0003「PTY 永不进状态机」，标题/来源不被改写）", async () => {
    const deps = makeDeps(new FakeAdapter({ clock: new VirtualClock() }));
    const handle = (raw: unknown) => handleIpc(deps, raw);
    deps.sessions.insert({
      id: "tty-rn-1",
      kind: "pty",
      cli: "pty",
      nativeSessionId: null,
      projectId: null,
      title: "终端 · pwsh",
      cwd: null,
      permMode: null,
      lastActiveAt: null,
      archivedAt: null,
    });
    const r = await handle({ channel: "session:rename", sessionId: "tty-rn-1", title: "不该生效的名字" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("E_INTERNAL");
      expect(r.error.message).toContain("PTY");
    }
    expect(deps.sessions.get("tty-rn-1")).toMatchObject({ title: "终端 · pwsh", titleSource: "default" });
  });
});

describe("diff:ipc 通道（#43 spec #40 D 节：独立单通道 + 入站 zod + 经 project store 解析 cwd）", () => {
  /** diff 专用路由：真实 ProjectStore（临时目录注册）+ 注入 fake readWorkspaceDiff */
  function makeDiffRouter(readWorkspaceDiff: (cwd: string) => Promise<unknown>) {
    const db = openDatabase(":memory:");
    const projects = new ProjectStore(db);
    // realpath 归一：CI 的 TEMP 可能是 8.3 短名（RUNNER~1），cwd 断言须与 canonicalizePath 同形态
    const repoDir = join(tmpRoot || (tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "kb-diff-ipc-")))), "repo");
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

// ========== #58 会话归档通道（spec #57 D 节：归档/取消归档编排闭环） ============

/** 归档编排观察 adapter：interruptTurn/dispose/adoptSession 调用全记录，行为透传底层（可选注入失败模拟「进程已死/登记失败」）；arch D2 起目录面经 forCli 句柄包装（adopt 记录在句柄内） */
function spyAdapter(
  base: CliAdapter,
  fails: { interrupt?: boolean; dispose?: boolean; adopt?: boolean } = {},
): { adapter: CliAdapter; calls: string[] } {
  const calls: string[] = [];
  const adapter: CliAdapter = {
    capabilities: base.capabilities,
    forCli: (cli) => {
      const dir = base.forCli(cli);
      const baseAdopt = dir.adoptSession?.bind(dir); // 闭包内调用需先收窄并绑定 this（可选成员的窄化不跨闭包保持）
      return {
        createSession: (i) => dir.createSession(i),
        listModels: (i) => dir.listModels(i),
        listCommands: (i) => dir.listCommands(i),
        adoptSession: baseAdopt
          ? async (i) => {
              calls.push(`adopt:${i.sessionId}`);
              if (fails.adopt) throw new AdapterError("E_INTERNAL", `登记失败（注入）：${i.sessionId}`);
              return baseAdopt(i);
            }
          : undefined,
      };
    },
    setModel: (i) => base.setModel(i),
    summarizeTitle: (id) => base.summarizeTitle(id),
    sendTurn: (i) => base.sendTurn(i),
    interruptTurn: async (id) => {
      calls.push(`interrupt:${id}`);
      if (fails.interrupt) throw new AdapterError("E_SESSION_NOT_FOUND", `会话不存在（模拟进程已死）：${id}`);
      return base.interruptTurn(id);
    },
    resolveApproval: (i) => base.resolveApproval(i),
    readHistory: (id) => base.readHistory(id),
    readTranscript: (id) => base.readTranscript(id),
    resume: (id) => base.resume(id),
    dispose: async (i) => {
      calls.push(`dispose:${i?.sessionId ?? "*"}`);
      if (fails.dispose) throw new AdapterError("E_SESSION_NOT_FOUND", `会话不存在（模拟进程已死）：${i?.sessionId ?? ""}`);
      return base.dispose(i);
    },
    subscribe: (h) => base.subscribe(h),
  };
  return { adapter, calls };
}

/** 组装归档测试路由：FakeAdapter（VirtualClock）+ spy 包装 + 真库 deps */
function makeArchiveRouter(fails?: { interrupt?: boolean; dispose?: boolean; adopt?: boolean }) {
  const clock = new VirtualClock();
  const spy = spyAdapter(new FakeAdapter({ clock }), fails);
  const deps = makeDeps(spy.adapter);
  return { clock, spy, handle: (raw: unknown) => handleIpc(deps, raw) };
}

describe("会话归档通道（#58 spec #57）", () => {
  it("session:archive 结构化：在跑先中断 → 受控终止单会话（dispose）→ 写归档标记；session:list 不再返回该行，archivedList 含归档时间", async () => {
    const { clock, spy, handle } = makeArchiveRouter();
    const created = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p", title: "调研" });
    const sessionId = created.ok ? created.sessionId! : "";
    await handle({ channel: "session:send", sessionId, text: "拆类型" }); // turn 进行中
    const res = await handle({ channel: "session:archive", sessionId });
    expect(res.ok).toBe(true);
    expect(spy.calls[0]).toBe(`interrupt:${sessionId}`); // 顺序：先中断当前 turn
    expect(spy.calls[1]).toBe(`dispose:${sessionId}`); // 再受控终止单会话
    // 默认列表排除；归档视图含展示字段与归档时间
    const listed = await handle({ channel: "session:list" });
    expect(listed.ok && listed.sessions).toEqual([]);
    const archived = await handle({ channel: "session:archivedList" });
    expect(archived.ok && archived.sessions).toEqual([
      // #94：create 显式 title 仅为占位名，send「拆类型」成功后派生覆盖（default→derived）
      expect.objectContaining({ id: sessionId, cli: "fake", title: "拆类型", archivedAt: expect.any(String) }),
    ]);
    // 终止后 adapter 无该会话（readHistory 报 SESSION_NOT_FOUND）
    const read = await handle({ channel: "session:readHistory", sessionId });
    expect(read.ok).toBe(false);
    clock.runToIdle();
  });

  it("archive 终止失败（进程已死）不阻断归档；中断失败同样放行", async () => {
    const { spy, handle } = makeArchiveRouter({ interrupt: true, dispose: true });
    const created = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p" });
    const sessionId = created.ok ? created.sessionId! : "";
    const res = await handle({ channel: "session:archive", sessionId });
    expect(res.ok).toBe(true);
    expect(spy.calls).toEqual([`interrupt:${sessionId}`, `dispose:${sessionId}`]);
    const archived = await handle({ channel: "session:archivedList" });
    expect(archived.ok && archived.sessions).toHaveLength(1);
  });

  it("archive 未知会话 → E_SESSION_NOT_FOUND；重复归档幂等（返回成功、单条归档记录不重复）", async () => {
    const { handle } = makeArchiveRouter();
    const ghost = await handle({ channel: "session:archive", sessionId: "ghost" });
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.error.code).toBe("E_SESSION_NOT_FOUND");

    const created = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p" });
    const sessionId = created.ok ? created.sessionId! : "";
    expect((await handle({ channel: "session:archive", sessionId })).ok).toBe(true);
    expect((await handle({ channel: "session:archive", sessionId })).ok).toBe(true); // 幂等
    const archived = await handle({ channel: "session:archivedList" });
    expect(archived.ok && archived.sessions).toHaveLength(1);
  });

  it("archive PTY 会话：用终端终止（pty.kill），不触碰 adapter；行移出默认列表", async () => {
    const spy = spyAdapter(new FakeAdapter({ clock: new VirtualClock() }));
    const ptyRec = makePtyHost();
    const deps = makeDeps(spy.adapter, async () => null, ptyRec);
    const handle = (raw: unknown) => handleIpc(deps, raw);
    const created = await handle({ channel: "terminal:create", terminalId: randomUUID(), cwd: "C:\\p" }); // #60：id 由渲染端预生成
    const terminalId = created.ok ? created.sessionId! : "";
    const res = await handle({ channel: "session:archive", sessionId: terminalId });
    expect(res.ok).toBe(true);
    expect(ptyRec.killed).toEqual([terminalId]); // PTY 用终端终止
    expect(spy.calls).toEqual([]); // 不经 adapter dispose/interrupt
    const listed = await handle({ channel: "session:list" });
    expect(listed.ok && listed.sessions).toEqual([]);
  });

  it("session:unarchive 结构化：先 adopt 登记可恢复句柄 → 清标记刷新活跃时间；回默认列表（disconnected）、readHistory/resume 仍可用", async () => {
    const { spy, handle } = makeArchiveRouter();
    const created = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p", permMode: "auto" });
    const sessionId = created.ok ? created.sessionId! : "";
    await handle({ channel: "session:archive", sessionId });
    const res = await handle({ channel: "session:unarchive", sessionId });
    expect(res.ok).toBe(true);
    expect(spy.calls).toContain(`adopt:${sessionId}`); // 取消归档先重新登记
    const listed = await handle({ channel: "session:list" });
    expect(listed.ok && listed.sessions).toEqual([
      expect.objectContaining({ id: sessionId, status: "disconnected", archivedAt: null, lastActiveAt: expect.any(String) }),
    ]);
    const read = await handle({ channel: "session:readHistory", sessionId }); // adopt 后句柄可达
    expect(read.ok).toBe(true);
    const resume = await handle({ channel: "session:resume", sessionId });
    expect(resume.ok).toBe(true);
  });

  it("unarchive 登记失败：留在归档态并明确报错（可重试），不写活跃时间", async () => {
    const { spy, handle } = makeArchiveRouter({ adopt: true });
    const created = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p" });
    const sessionId = created.ok ? created.sessionId! : "";
    await handle({ channel: "session:archive", sessionId });
    const res = await handle({ channel: "session:unarchive", sessionId });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("登记失败");
    expect(spy.calls).toContain(`adopt:${sessionId}`);
    // 留在归档态：归档视图仍含该行、默认列表仍排除
    const archived = await handle({ channel: "session:archivedList" });
    expect(archived.ok && archived.sessions).toEqual([
      expect.objectContaining({ id: sessionId, lastActiveAt: null }),
    ]);
    const listed = await handle({ channel: "session:list" });
    expect(listed.ok && listed.sessions).toEqual([]);
  });

  it("unarchive PTY：无进程恢复（不走 adapter adopt），回列表显示已断开", async () => {
    const spy = spyAdapter(new FakeAdapter({ clock: new VirtualClock() }));
    const deps = makeDeps(spy.adapter);
    const handle = (raw: unknown) => handleIpc(deps, raw);
    const created = await handle({ channel: "terminal:create", terminalId: randomUUID(), cwd: "C:\\p" }); // #60：id 由渲染端预生成
    const terminalId = created.ok ? created.sessionId! : "";
    await handle({ channel: "session:archive", sessionId: terminalId });
    const res = await handle({ channel: "session:unarchive", sessionId: terminalId });
    expect(res.ok).toBe(true);
    expect(spy.calls).toEqual([]); // PTY 无 adopt
    const listed = await handle({ channel: "session:list" });
    expect(listed.ok && listed.sessions).toEqual([
      expect.objectContaining({ id: terminalId, kind: "pty", status: "disconnected" }),
    ]);
  });

  it("unarchive 未知会话 → E_SESSION_NOT_FOUND；重复取消归档幂等（活跃时间不重置）", async () => {
    const { handle } = makeArchiveRouter();
    const ghost = await handle({ channel: "session:unarchive", sessionId: "ghost" });
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.error.code).toBe("E_SESSION_NOT_FOUND");

    const created = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p" });
    const sessionId = created.ok ? created.sessionId! : "";
    const again = await handle({ channel: "session:unarchive", sessionId }); // 本就未归档：no-op 成功
    expect(again.ok).toBe(true);
    const listed = await handle({ channel: "session:list" });
    // 创建时 lastActiveAt=null，no-op 取消归档不得凭空写入活跃时间
    expect(listed.ok && listed.sessions).toEqual([expect.objectContaining({ id: sessionId, lastActiveAt: null })]);
  });

  it("archivedList：跨项目全部已归档行（含 PTY），按归档时间倒序，wire 行带展示字段", async () => {
    const spy = spyAdapter(new FakeAdapter({ clock: new VirtualClock() }));
    const ptyRec = makePtyHost();
    const deps = makeDeps(spy.adapter, async () => null, ptyRec);
    const handle = (raw: unknown) => handleIpc(deps, raw);
    const s1 = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p", title: "A" });
    const tty = await handle({ channel: "terminal:create", terminalId: randomUUID(), cwd: "C:\\p" }); // #60：id 由渲染端预生成
    await handle({ channel: "session:archive", sessionId: s1.ok ? s1.sessionId! : "" });
    await handle({ channel: "session:archive", sessionId: tty.ok ? tty.sessionId! : "" });
    const archived = await handle({ channel: "session:archivedList" });
    const rows = archived.ok ? archived.sessions! : [];
    expect(rows.map((r) => r.kind)).toEqual(["pty", "structured"]); // 后归档在前
    for (const r of rows) {
      expect(r.archivedAt).toBeTruthy();
      expect(r.title !== undefined).toBe(true);
      expect(r.cli.length).toBeGreaterThan(0);
    }
  });
});

// ========== #62 会话删除通道（spec #57 D 节：unlink → 终止 → 删记录编排） ============

/** 组装删除测试路由：spy adapter + 真库 deps + tracker 变更捕获（dbPath 注入文件库做重启重放；pick 固定目录——register 容忍 missing） */
function makeDeleteRouter(fails?: { interrupt?: boolean; dispose?: boolean }, opts?: { dbPath?: string; ptyHost?: ReturnType<typeof makePtyHost> }) {
  const clock = new VirtualClock();
  const spy = spyAdapter(new FakeAdapter({ clock }), fails);
  const db = opts?.dbPath ? openDatabase(opts.dbPath) : openDatabase(":memory:");
  const changes: TrackerChange[] = [];
  const ptyHost = opts?.ptyHost ?? makePtyHost();
  const sessions = new SessionStore(db);
  const deps: IpcDeps = {
    adapter: spy.adapter,
    engine: new TrackerEngine(db),
    projects: new ProjectStore(db),
    sessions,
    lifecycle: createSessionLifecycle({ sessions, procs: createAdapterSessionProcesses(spy.adapter, ptyHost.host) }),
    pickDirectory: async () => "C:\\del-repo",
    getCurrentProjectId: () => null,
    setCurrentProjectId: () => undefined,
    pty: ptyHost.host,
    emitTrackerChange: (c) => changes.push(c),
  };
  return { clock, spy, deps, changes, db, handle: (raw: unknown) => handleIpc(deps, raw) };
}

describe("会话删除通道（#62 spec #57）", () => {

  it("结构化删除全链：unlink 事件落库（session_unlinked 推送）→ 中断+受控终止 → 行删除；重启重放后映射干净、事件日志保留", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-del-"));
    const dbPath = join(tmpRoot, "state.db");
    const { clock, spy, deps, changes, handle } = makeDeleteRouter(undefined, { dbPath });
    // 建项目 + 需求 + 已关联会话（session:create+requirementId 原子关联）
    await handle({ channel: "project:register" });
    const projList = await handle({ channel: "project:list" });
    const projectId = projList.ok && projList.projects ? projList.projects[0].id : "";
    const req = await handle({ channel: "kanban:create", projectId, title: "删除链路" });
    const requirementId = req.ok ? req.requirementId! : "";
    const created = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\del-repo", projectId, requirementId, title: "调研" });
    const sessionId = created.ok ? created.sessionId! : "";
    await handle({ channel: "session:send", sessionId, text: "在跑" }); // turn 进行中

    const res = await handle({ channel: "session:delete", sessionId });
    expect(res.ok).toBe(true);
    // 编排顺序：先解关联（unlink 事件 → session_unlinked 推送）再中断再终止
    expect(changes.some((c) => c.type === "session_unlinked" && c.sessionId === sessionId && c.requirementId === requirementId)).toBe(true);
    expect(spy.calls[0]).toBe(`interrupt:${sessionId}`);
    expect(spy.calls[1]).toBe(`dispose:${sessionId}`);
    // 行删除：默认列表/归档视图均不可见；看板映射干净（REQ 徽标数据源）
    const listed = await handle({ channel: "session:list" });
    expect(listed.ok && listed.sessions).toEqual([]);
    const kanban = await handle({ channel: "kanban:list" });
    expect(kanban.ok && kanban.sessionToReq).toEqual({});
    expect(kanban.ok && kanban.requirements?.[0].sessions).toEqual([]);
    // 历史事件日志永不删除（link + unlink 均在）
    const eventKinds = deps.engine.store.listEvents().map((e) => e.kind);
    expect(eventKinds).toContain("link");
    expect(eventKinds).toContain("unlink");
    clock.runToIdle();
    // 重启重放：新 engine 读同一库 restore 后映射干净（无幽灵映射）；断言完关闭两条连接（Windows 文件锁）
    const replayDb = openDatabase(dbPath);
    const replayed = new TrackerEngine(replayDb);
    replayed.restore();
    expect(replayed.tracker.sessionToReq.get(sessionId)).toBeUndefined();
    expect(replayed.tracker.requirements.get(requirementId)?.sessions.has(sessionId)).toBe(false);
    replayed.close();
    deps.engine.close();
  });

  it("解关联失败即中止：ok:false 明确报错，行保留、进程未终止（可重试）", async () => {
    const base = makeDeleteRouter();
    // 注入解关联失败：engine.process 抛错（模拟事件落库失败）；setup 仍用真引擎建数据
    const failing: IpcDeps = {
      ...base.deps,
      engine: new Proxy(base.deps.engine, {
        get(target, prop, receiver) {
          if (prop === "process") return (): never => { throw new Error("sqlite 写入失败（注入）"); };
          return Reflect.get(target, prop, receiver);
        },
      }),
    };
    const handle = (raw: unknown) => handleIpc(failing, raw);
    const handleSetup = (raw: unknown) => handleIpc(base.deps, raw);
    // setup 用真引擎建关联会话
    await handleSetup({ channel: "project:register" });
    const projList = await handleSetup({ channel: "project:list" });
    const projectId = projList.ok && projList.projects ? projList.projects[0].id : "";
    const req = await handleSetup({ channel: "kanban:create", projectId });
    const requirementId = req.ok ? req.requirementId! : "";
    const created = await handleSetup({ channel: "session:create", cli: "fake", cwd: "C:\\p", projectId, requirementId });
    const sessionId = created.ok ? created.sessionId! : "";

    const res = await handle({ channel: "session:delete", sessionId });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("E_INTERNAL");
      expect(res.error.message).toContain("sqlite 写入失败");
    }
    // 中止：行保留（可重试）、进程未终止（未走到 interrupt/dispose）、关联未清
    expect(base.spy.calls).toEqual([]);
    const listed = await handleSetup({ channel: "session:list" });
    expect(listed.ok && listed.sessions).toHaveLength(1);
    const kanban = await handleSetup({ channel: "kanban:list" });
    expect(kanban.ok && kanban.sessionToReq).toEqual({ [sessionId]: requirementId });
  });

  it("重复删除幂等；未知会话（从未存在）同样返回成功（DELETE 语义）", async () => {
    const { clock, handle } = makeDeleteRouter();
    const created = await handle({ channel: "session:create", cli: "fake", cwd: "C:\\p" });
    const sessionId = created.ok ? created.sessionId! : "";
    expect((await handle({ channel: "session:delete", sessionId })).ok).toBe(true);
    expect((await handle({ channel: "session:delete", sessionId })).ok).toBe(true); // 重复删除幂等
    expect((await handle({ channel: "session:delete", sessionId: "ghost" })).ok).toBe(true); // 从未存在
    clock.runToIdle();
  });

  it("PTY 删除：用终端终止（pty.kill），不触碰 adapter；行删除", async () => {
    const ptyRec = makePtyHost();
    const { spy, handle } = makeDeleteRouter(undefined, { ptyHost: ptyRec });
    const terminalId = randomUUID(); // #60：渲染端草稿预生成的终端 id
    expect((await handle({ channel: "terminal:create", terminalId, cwd: "C:\\p" })).ok).toBe(true);
    const res = await handle({ channel: "session:delete", sessionId: terminalId });
    expect(res.ok).toBe(true);
    expect(ptyRec.killed).toEqual([terminalId]);
    expect(spy.calls).toEqual([]); // 不经 adapter
    const listed = await handle({ channel: "session:list" });
    expect(listed.ok && listed.sessions).toEqual([]);
  });
});
describe("config:ipc 通道（#61 spec #57 配置链路：读 autoArchive 子集 / 写经 LiveConfig.set 字段级合并 + 先持久化成功再变异）", () => {
  /** config 专用路由：真实 openLiveConfig + tmp 文件（内存/磁盘同源 = Main 生产形态）；缺省预置 currentProjectId=p-1；opts.writeFail 时写目标为目录（稳定注入写盘失败） */
  function makeConfigRouter(opts: { writeFail?: boolean } = {}) {
    tmpRoot = tmpRoot || mkdtempSync(join(tmpdir(), "kb-config-ipc-"));
    const configPath = opts.writeFail ? tmpRoot : join(tmpRoot, `config-${randomUUID()}.json`);
    if (!opts.writeFail) saveConfig(configPath, { ...defaultConfig(), currentProjectId: "p-1" });
    const live = openLiveConfig(configPath);
    const deps: ConfigIpcDeps = {
      config: live,
      isShuttingDown: () => false,
    };
    return {
      config: live.get(),
      /** 读回落盘形态（写成功断言用） */
      persisted: () => (opts.writeFail ? null : loadConfig(configPath)),
      handle: (raw: unknown) => handleConfigIpc(deps, raw),
    };
  }

  it("非法请求 → E_SCHEMA；退出门闸 → E_INTERNAL（对齐 diff:ipc 门闸惯例）", async () => {
    const { handle } = makeConfigRouter();
    const schema = await handle({ channel: "config:nuke" });
    expect(schema).toEqual({ ok: false, error: { code: "E_SCHEMA", message: expect.any(String) } });
    const badDays = await handle({ channel: "config:set", autoArchive: { enabled: true, days: 0 } });
    expect(badDays).toEqual({ ok: false, error: { code: "E_SCHEMA", message: expect.any(String) } });
  });

  it("config:get 返回 autoArchive 子集（默认关/30；不携带项目/CLI 路径等其余配置字段）", async () => {
    const { handle, config } = makeConfigRouter();
    const res = await handle({ channel: "config:get" });
    expect(res).toEqual({ ok: true, autoArchive: { enabled: false, days: 30 }, lastScan: null });
    expect(config.autoArchive).toEqual({ enabled: false, days: 30 }); // 只读不写
  });

  it("config:set 合法值：先持久化再改内存 —— 落盘收到完整配置（autoArchive 新值生效、currentProjectId 等其余字段原样保留）", async () => {
    const { handle, config, persisted } = makeConfigRouter();
    const res = await handle({ channel: "config:set", autoArchive: { enabled: true, days: 14 } });
    expect(res).toEqual({ ok: true, autoArchive: { enabled: true, days: 14 }, lastScan: null }); // 未注入扫描 → null
    // 落盘的是含新 autoArchive 的完整配置：与项目切换的写入互不覆盖（currentProjectId 不被清/不被越权值替换）
    expect(persisted()).toMatchObject({ currentProjectId: "p-1", autoArchive: { enabled: true, days: 14 } });
    // 写盘成功后内存对象（get 同一引用）才更新
    expect(config.autoArchive).toEqual({ enabled: true, days: 14 });
  });

  it("写盘失败：返回明确错误（E_INTERNAL + message）且新值不生效 —— 内存对象未被改（内存与磁盘不分叉）", async () => {
    const { handle, config, persisted } = makeConfigRouter({ writeFail: true });
    const res = await handle({ channel: "config:set", autoArchive: { enabled: true, days: 7 } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("E_INTERNAL");
      expect(res.error.message.length).toBeGreaterThan(0);
    }
    expect(config.autoArchive).toEqual({ enabled: false, days: 30 }); // 新值不生效
    expect(persisted()).toBeNull();
  });

  it("config:set 携带越权字段（currentProjectId/gitExe）被剥离：持久化值来自内存对象而非请求", async () => {
    const { handle, persisted } = makeConfigRouter();
    const res = await handle({
      channel: "config:set",
      autoArchive: { enabled: true, days: 60 },
      currentProjectId: "p-evil",
      gitExe: "C:/evil/git.exe",
    });
    expect(res.ok).toBe(true);
    expect(persisted()?.currentProjectId).toBe("p-1"); // 越权值不落盘
    expect(persisted()?.gitExe).toBeNull();
  });

  it("真实写盘往返（重启后生效）：set 落 tmp 文件 → loadConfig 读回新 autoArchive 与既有 currentProjectId", async () => {
    tmpRoot = tmpRoot || mkdtempSync(join(tmpdir(), "kb-config-ipc-"));
    const configPath = join(tmpRoot, `roundtrip-${randomUUID()}.json`);
    saveConfig(configPath, { ...defaultConfig(), currentProjectId: "p-2" });
    const handle = (raw: unknown) => handleConfigIpc({ config: openLiveConfig(configPath), isShuttingDown: () => false }, raw);
    const res = await handle({ channel: "config:set", autoArchive: { enabled: true, days: 90 } });
    expect(res.ok).toBe(true);
    // 重启读入侧：autoArchive 新值生效，项目切换写入的 currentProjectId 不被本次写覆盖
    const reloaded = loadConfig(configPath);
    expect(reloaded.autoArchive).toEqual({ enabled: true, days: 90 });
    expect(reloaded.currentProjectId).toBe("p-2");
  });
});

describe("config:ipc × 自动归档引擎接线（#64 spec #57：保存成功后扫描 + 摘要反馈）", () => {
  /** 最小 config 路由（真实 openLiveConfig + tmp 文件；可注入扫描回调/缓存） */
  function makeConfigRouterWith(over: { onAutoArchiveSaved?: ConfigIpcDeps["onAutoArchiveSaved"]; getLastScan?: ConfigIpcDeps["getLastScan"]; log?: LogFn }) {
    tmpRoot = tmpRoot || mkdtempSync(join(tmpdir(), "kb-config-ipc-"));
    const configPath = join(tmpRoot, `config-${randomUUID()}.json`);
    saveConfig(configPath, { ...defaultConfig() });
    const deps: ConfigIpcDeps = {
      config: openLiveConfig(configPath),
      onAutoArchiveSaved: over.onAutoArchiveSaved,
      getLastScan: over.getLastScan,
      log: over.log,
    };
    return { config: deps.config.get(), handle: (raw: unknown) => handleConfigIpc(deps, raw) };
  }

  it("config:get 应答携带上次扫描摘要（getLastScan 注入的缓存；未扫描为 null）", async () => {
    let cached: { archived: number; failed: number } | null = { archived: 3, failed: 1 };
    const { handle } = makeConfigRouterWith({ getLastScan: () => cached });
    expect(await handle({ channel: "config:get" })).toEqual({
      ok: true,
      autoArchive: { enabled: false, days: 30 },
      lastScan: { archived: 3, failed: 1 },
    });
    cached = null;
    expect(await handle({ channel: "config:get" })).toEqual({ ok: true, autoArchive: { enabled: false, days: 30 }, lastScan: null });
  });

  it("config:set 保存成功后触发扫描且读到更新后的新值：应答携带扫描摘要", async () => {
    const scans: AppConfig[] = [];
    const { handle } = makeConfigRouterWith({
      onAutoArchiveSaved: async (c) => {
        scans.push({ ...c });
        return { archived: 2, failed: 0 };
      },
    });
    const res = await handle({ channel: "config:set", autoArchive: { enabled: true, days: 14 } });
    expect(res).toEqual({ ok: true, autoArchive: { enabled: true, days: 14 }, lastScan: { archived: 2, failed: 0 } });
    expect(scans.length).toBe(1);
    // 扫描时机在内存更新之后：读到的已是新 autoArchive（fault：若先扫后存则此断言红）
    expect(scans[0]?.autoArchive).toEqual({ enabled: true, days: 14 });
  });

  it("写盘失败不触发扫描（保存未成功，无扫描副作用）", async () => {
    tmpRoot = tmpRoot || mkdtempSync(join(tmpdir(), "kb-config-ipc-"));
    let scanCalls = 0;
    // 写目标为 tmpRoot 目录本身：set 的 writeFileSync 稳定抛错（EISDIR）
    const deps: ConfigIpcDeps = {
      config: openLiveConfig(tmpRoot),
      onAutoArchiveSaved: async () => {
        scanCalls += 1;
        return { archived: 0, failed: 0 };
      },
    };
    const res = await handleConfigIpc(deps, { channel: "config:set", autoArchive: { enabled: true, days: 7 } });
    expect(res.ok).toBe(false);
    expect(scanCalls).toBe(0);
  });

  it("扫描抛错不改变保存成功的事实：应答仍 ok 且摘要 null、日志可查", async () => {
    const entries: Array<{ level: string; message: string }> = [];
    const { handle, config } = makeConfigRouterWith({
      onAutoArchiveSaved: async () => {
        throw new Error("扫描炸了");
      },
      log: (level, _scope, message) => entries.push({ level, message }),
    });
    const res = await handle({ channel: "config:set", autoArchive: { enabled: true, days: 7 } });
    expect(res).toEqual({ ok: true, autoArchive: { enabled: true, days: 7 }, lastScan: null });
    expect(config.autoArchive).toEqual({ enabled: true, days: 7 }); // 保存仍生效
    expect(entries.some((e) => e.level === "error" && e.message.includes("扫描炸了"))).toBe(true);
  });
});

describe("cli:status 通道（#80 spec #75 实现决策 3/7：三 CLI 安装状态聚合，注入 service 观察分发与错误形状）", () => {
  it("cli:status 分发到注入的探测服务：应答携带三 CLI 安装表（装/未装两态原样透传）", async () => {
    const res = await handleCliStatusIpc(
      { cliStatus: async () => ({ codex: true, claude: false, opencode: true }) },
      { channel: "cli:status" },
    );
    expect(res).toEqual({ ok: true, installed: { codex: true, claude: false, opencode: true } });
  });

  it("非法请求被拒：E_SCHEMA + 可读摘要（信封经共享工厂）", async () => {
    const res = await handleCliStatusIpc({ cliStatus: async () => ({ codex: true, claude: true, opencode: true }) }, {
      channel: "cli:nonsense",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("E_SCHEMA");
      expect(res.error.message.length).toBeGreaterThan(0);
    }
  });

  it("探测服务意外异常返回明确错误（ok:false E_INTERNAL 不 rethrow），日志可查", async () => {
    const entries: Array<{ level: string; message: string }> = [];
    const res = await handleCliStatusIpc(
      {
        cliStatus: async () => {
          throw new Error("探测炸了");
        },
        log: (level, _scope, message) => entries.push({ level, message }),
      },
      { channel: "cli:status" },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_INTERNAL");
    expect(entries.some((e) => e.message.includes("探测炸了"))).toBe(true);
  });

  it("退出中拒新请求（退出门闸与其它通道一致）", async () => {
    const res = await handleCliStatusIpc(
      { cliStatus: async () => ({ codex: true, claude: true, opencode: true }), isShuttingDown: () => true },
      { channel: "cli:status" },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_INTERNAL");
  });
});

describe("models:ipc 通道（#76 spec #75：models:list 按 cli 经 adapter 分发；默认项由 isDefault 派生）", () => {
  /** models 通道 deps：注入可换 adapter（缺省 FakeAdapter 演示链路） */
  function makeModelsDeps(adapter: CliAdapter = new FakeAdapter()): ModelsIpcDeps {
    return { adapter, isShuttingDown: () => false };
  }

  it("models:list 经 adapter 返回目录（fake 两条、首条默认）；无独立 defaultModel 字段", async () => {
    const handle = (raw: unknown) => handleModelsIpc(makeModelsDeps(), raw);
    const res = await handle({ channel: "models:list", cli: "fake", cwd: "C:\\p" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.models).toHaveLength(2);
      expect(res.models[0].isDefault).toBe(true);
      expect(res.models[1].isDefault).toBe(false);
      expect("defaultModel" in res).toBe(false); // 单一事实源：默认项由 isDefault 派生
    }
  });

  it("AdapterError 原码透传（E_SPAWN_NOT_FOUND 未装 / E_INTERNAL 暂未支持）", async () => {
    class SpawnFailModelsAdapter extends FakeAdapter {
      override async listModels(): Promise<never[]> {
        throw new AdapterError("E_SPAWN_NOT_FOUND", "未找到 CLI 可执行文件");
      }
    }
    class UnsupportedModelsAdapter extends FakeAdapter {
      override async listModels(): Promise<never[]> {
        throw new AdapterError("E_INTERNAL", "claude 模型目录暂未支持");
      }
    }
    const a = await handleModelsIpc(makeModelsDeps(new SpawnFailModelsAdapter()), { channel: "models:list", cli: "codex", cwd: "C:\\p" });
    expect(a).toMatchObject({ ok: false, error: { code: "E_SPAWN_NOT_FOUND" } });
    const b = await handleModelsIpc(makeModelsDeps(new UnsupportedModelsAdapter()), { channel: "models:list", cli: "claude", cwd: "C:\\p" });
    expect(b).toMatchObject({ ok: false, error: { code: "E_INTERNAL", message: expect.stringContaining("暂未支持") } });
  });

  it("非法请求 E_SCHEMA（未知 cli / 空 cwd / 非法通道 / 非对象）", async () => {
    const handle = (raw: unknown) => handleModelsIpc(makeModelsDeps(), raw);
    for (const raw of [null, "models:list", { channel: "models:list", cli: "grok", cwd: "C:\\p" }, { channel: "models:list", cli: "fake", cwd: "" }, { channel: "models:nuke", cli: "fake", cwd: "C:\\p" }]) {
      const res = await handle(raw);
      expect(res).toMatchObject({ ok: false, error: { code: "E_SCHEMA" } });
    }
  });

  it("退出门闸：shuttingDown 拒绝新请求（E_INTERNAL）", async () => {
    const res = await handleModelsIpc(
      { adapter: new FakeAdapter(), isShuttingDown: () => true },
      { channel: "models:list", cli: "fake", cwd: "C:\\p" },
    );
    expect(res).toMatchObject({ ok: false, error: { code: "E_INTERNAL", message: expect.stringContaining("退出") } });
  });
});


describe("composer:listCommands 通道（#89 斜杠命令列举）", () => {
  it("fake 环境：renderer 经 kanban:ipc 通道拿到空命令集（ADR 0004：fake 会话无命令源，菜单空态）", async () => {
    const deps = makeDeps(new FakeAdapter({ clock: new VirtualClock() }));
    const res = await handleIpc(deps, { channel: "composer:listCommands", cli: "fake", cwd: "C:\\demo" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.commands).toEqual([]);
  });

  it("短 TTL 缓存：注入 commandCatalog 时重复调用不重复扫描（适配器只被调用一次）", async () => {
    const counting = new (class extends FakeAdapter {
      listCommandsCalls = 0;
      override async listCommands(): Promise<import("@kanban/ipc-schema").CommandEntry[]> {
        this.listCommandsCalls += 1;
        return super.listCommands({ cwd: "C:\\demo" });
      }
    })();
    const deps: IpcDeps = { ...makeDeps(counting), commandCatalog: new CommandCatalog({ adapter: counting, now: () => 0 }) };
    const req = { channel: "composer:listCommands", cli: "fake", cwd: "C:\\demo" } as const;
    const first = await handleIpc(deps, req);
    const second = await handleIpc(deps, req);
    expect(first.ok && second.ok).toBe(true);
    expect(counting.listCommandsCalls).toBe(1); // TTL 内命中缓存，未重复扫描
  });

  it("非法载荷 E_SCHEMA（cli 枚举外 / 空 cwd）；AdapterError 原码透传", async () => {
    const deps = makeDeps(new FakeAdapter({ clock: new VirtualClock() }));
    const bad1 = await handleIpc(deps, { channel: "composer:listCommands", cli: "grok", cwd: "C:\\p" });
    expect(bad1).toMatchObject({ ok: false, error: { code: "E_SCHEMA" } });
    const bad2 = await handleIpc(deps, { channel: "composer:listCommands", cli: "fake", cwd: "" });
    expect(bad2).toMatchObject({ ok: false, error: { code: "E_SCHEMA" } });
    const failAdapter = new (class extends FakeAdapter {
      override async listCommands(): Promise<never[]> {
        throw new AdapterError("E_SPAWN_NOT_FOUND", "未找到 CLI 可执行文件");
      }
    })();
    const res = await handleIpc({ ...makeDeps(failAdapter), commandCatalog: new CommandCatalog({ adapter: failAdapter, now: () => 0 }) }, { channel: "composer:listCommands", cli: "opencode", cwd: "C:\\p" });
    expect(res).toMatchObject({ ok: false, error: { code: "E_SPAWN_NOT_FOUND" } });
  });
});

describe("composer:expandCommand 通道（#92 codex 客户端展开）", () => {
  it("读来源文件展开：剥 frontmatter + 占位符替换，返回普通文本（项目级 prompts 目录内）", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-expand-"));
    const prompts = join(tmpRoot, ".codex", "prompts");
    mkdirSync(prompts, { recursive: true });
    const file = join(prompts, "probe.md");
    writeFileSync(file, "---\ndescription: 探针\n---\n目标：$ARGUMENTS，第一=$1，标记 KB-CODEX-PROMPT-EXECUTED", "utf8");
    const deps = makeDeps(new FakeAdapter({ clock: new VirtualClock() }));
    const res = await handleIpc(deps, { channel: "composer:expandCommand", sourcePath: file, args: "alpha beta", cwd: tmpRoot });
    expect(res).toMatchObject({ ok: true, text: "目标：alpha beta，第一=alpha，标记 KB-CODEX-PROMPT-EXECUTED" });
  });

  it("用户级 prompts 目录（注入 codexHomeDir）同样可展开（扫描口径两层之一）", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-expand-"));
    const home = join(tmpRoot, "fake-home");
    const prompts = join(home, ".codex", "prompts");
    mkdirSync(prompts, { recursive: true });
    const file = join(prompts, "user.md");
    writeFileSync(file, "---\ndescription: 用户级\n---\n用户级正文", "utf8");
    const deps: IpcDeps = { ...makeDeps(new FakeAdapter({ clock: new VirtualClock() })), codexHomeDir: home };
    const res = await handleIpc(deps, { channel: "composer:expandCommand", sourcePath: file, args: "", cwd: join(tmpRoot, "proj") });
    expect(res).toMatchObject({ ok: true, text: "用户级正文" });
  });

  it("sourcePath 越界（两层 prompts 目录之外 / .. 逃逸）→ E_INTERNAL 拒读（安全收窄：renderer 不可借展开通道读任意文件）", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-expand-"));
    // 机密文件真实存在且可读：证明拒绝来自目录边界校验而非文件缺失
    const secret = join(tmpRoot, "secret.md");
    writeFileSync(secret, "---\ndescription: x\n---\n机密正文 $ARGUMENTS", "utf8");
    const home = join(tmpRoot, "fake-home");
    mkdirSync(join(home, ".codex", "prompts"), { recursive: true });
    const deps: IpcDeps = { ...makeDeps(new FakeAdapter({ clock: new VirtualClock() })), codexHomeDir: home };
    const proj = join(tmpRoot, "proj");
    const res1 = await handleIpc(deps, { channel: "composer:expandCommand", sourcePath: secret, args: "x", cwd: proj });
    expect(res1).toMatchObject({ ok: false, error: { code: "E_INTERNAL", message: expect.stringContaining("越界") } });
    // 保留字面 .. 的逃逸串（join 会归一化，改手工拼接）：resolve 后 = secret 绝对路径（prompts 外）
    const escape = [proj, ".codex", "prompts", "..", "..", "..", "secret.md"].join("\\");
    const res2 = await handleIpc(deps, { channel: "composer:expandCommand", sourcePath: escape, args: "x", cwd: proj });
    expect(res2).toMatchObject({ ok: false, error: { code: "E_INTERNAL", message: expect.stringContaining("越界") } });
  });

  it("文件不可读 → E_INTERNAL 明确报错（fail-closed 不静默）", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-expand-"));
    const deps = makeDeps(new FakeAdapter({ clock: new VirtualClock() }));
    const res = await handleIpc(deps, { channel: "composer:expandCommand", sourcePath: join(tmpRoot, ".codex", "prompts", "不存在.md"), args: "x", cwd: tmpRoot });
    expect(res).toMatchObject({ ok: false, error: { code: "E_INTERNAL", message: expect.stringContaining("不可读") } });
  });
});
