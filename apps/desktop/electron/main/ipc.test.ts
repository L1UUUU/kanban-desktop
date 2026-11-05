// 用途：Main 入站 IPC 路由单测 —— zod 强制校验（非法消息明确错误码 E_SCHEMA）+ 各通道路由到 Adapter/store + AdapterError 错误码透传（spec E/#6 验收第 4 条/#7 project/session 通道）
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAdapter, VirtualClock, type CliAdapter } from "@kanban/cli-host";
import { openDatabase } from "./db";
import { handleIpc, type IpcDeps } from "./ipc";
import { ProjectStore } from "./project-store";
import { SessionStore } from "./session-store";

let tmpRoot = "";

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

/** 构造 VirtualClock 驱动的 FakeAdapter + 路由器（无持久化通道，#6 既有行为回归用） */
function makeRouter() {
  const clock = new VirtualClock();
  const adapter = new FakeAdapter({ clock });
  const deps = makeDeps(adapter);
  return { clock, adapter, deps, handle: (raw: unknown) => handleIpc(deps, raw) };
}

/** 完整 deps：内存 store + 可注入的目录选择与当前项目存取 */
function makeDeps(adapter: CliAdapter, pick: () => Promise<string | null> = async () => null): IpcDeps {
  const db = openDatabase(":memory:");
  let currentProjectId: string | null = null;
  return {
    adapter,
    projects: new ProjectStore(db),
    sessions: new SessionStore(db),
    pickDirectory: pick,
    getCurrentProjectId: () => currentProjectId,
    setCurrentProjectId: (id) => {
      currentProjectId = id;
    },
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
