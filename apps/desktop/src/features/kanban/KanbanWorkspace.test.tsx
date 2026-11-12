// 用途：看板视图组件测试（#18，spec #15 Testing seam 4）—— FakeAdapter 事件流直连驱动真实组件：五列渲染与列映射、按项目过滤、verified skill 自动建卡实时出现、uncertain/verified 徽标、link/unlink 会话数、视图切换不断 CLI、删除实时移除、无项目空板、重启再水化（对照原型一致项 1/2/3）
/// <reference types="node" /> <!-- 本文件用 node:fs/os/path 建持久化 fixture（重启再水化用例） -->
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent, CliKind, IpcRequest, IpcResult, ModelsRequest, RequirementCardRow, TerminalEvent, TrackerChangeWire } from "@kanban/ipc-schema";
import { FakeAdapter, VirtualClock } from "@kanban/cli-host";
import { TrackerEngine } from "@kanban/tracker";
import { openDatabase } from "../../../electron/main/db";
import { createAdapterEventHandler } from "../../../electron/main/adapter-events";
import { handleIpc, handleModelsIpc, type IpcDeps } from "../../../electron/main/ipc";
import { createPtyHost, type PtyLike, type PtyProcess } from "../../../electron/main/pty-host";
import { createAdapterSessionProcesses, createSessionLifecycle } from "../../../electron/main/session-lifecycle";
import { ProjectStore } from "../../../electron/main/project-store";
import { SessionStore } from "../../../electron/main/session-store";
import { AppShell } from "../../App";
import type { ChatController } from "../chat/use-chat";
import type { ChatTransport } from "../../lib/kanban-api";

// 未关闭的 db 连接（afterEach 统一关，避免 Windows 上临时目录删除 EPERM）
const openDbs: Array<{ close(): void }> = [];

/** #59 草稿创建会话：打开草稿并发送首条消息（原 createSession 直建的草稿语义等价物；text 可携带剧本关键词） */
async function createViaDraft(ctl: () => ChatController, cli: CliKind, opts?: { projectId?: string | null }, text = "默认演示"): Promise<void> {
  // issue #71 S4：经 openSessionDraft 单入口（cwd 由 projectId 解析），updateDraft 为收窄动作；#77 单一就绪态：待目录就绪自动选中模型后提交
  const r = ctl().openSessionDraft({ projectId: opts?.projectId ?? null, cli });
  if (!r.ok) throw new Error(`草稿打开失败：${r.reason}`);
  ctl().updateDraft({ input: text });
  await waitFor(() => {
    const d = ctl().draft;
    if (d?.kind !== "structured") throw new Error("结构化草稿不在位");
    expect(d.data.model).toBeDefined();
  });
  await ctl().submitDraft();
}

// jsdom 缺 ResizeObserver：xterm 服务需要（生产 Chromium 原生具备）
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

/** 回显 mock PTY（IpcDeps 形状补齐；本套不建 PTY 会话） */
class EchoPty implements PtyLike {
  spawn(): PtyProcess {
    let onData: ((data: string) => void) | null = null;
    let onExit: ((info: { exitCode: number; signal?: number }) => void) | null = null;
    const proc: PtyProcess = {
      pid: 1,
      onData: (l) => {
        onData = l;
        return l;
      },
      onExit: (l) => {
        onExit = l;
        return l;
      },
      resize: () => undefined,
      write: (data) => onData?.(data),
      kill: () => onExit?.({ exitCode: 0 }),
    };
    return proc;
  }
}

/**
 * FakeAdapter 直连 transport（#18 版）：与生产主进程同款接线 —— adapter 事件泵（createAdapterEventHandler：
 * 会话状态落库 + SkillObservation 注入项目进 engine + 变更经 sendChange 推送）+ kanban 通道 emitTrackerChange；
 * renderer 侧 onEvent/onTrackerEvent 即主进程转发面
 */
function makeTransport(
  adapter: FakeAdapter,
  opts?: { dbPath?: string; statePath?: string; pick?: () => Promise<string | null>; restore?: boolean },
): ChatTransport {
  const db = opts?.dbPath ? openDatabase(opts.dbPath) : openDatabase(":memory:");
  openDbs.push(db);
  const state: { currentProjectId: string | null } = { currentProjectId: null };
  if (opts?.statePath) {
    try {
      const raw = JSON.parse(readFileSync(opts.statePath, "utf-8")) as { currentProjectId?: string | null };
      if (typeof raw.currentProjectId === "string") state.currentProjectId = raw.currentProjectId;
    } catch {
      // 首次运行无状态文件
    }
  }
  const chatListeners = new Set<(event: AdapterEvent) => void>();
  const trackerListeners = new Set<(change: TrackerChangeWire) => void>();
  const emitTracker = (change: TrackerChangeWire): void => {
    for (const l of trackerListeners) l(change);
  };
  const sessions = new SessionStore(db);
  const engine = new TrackerEngine(db);
  if (opts?.restore) engine.restore();
  // 主进程事件泵同款：skill 观察信号（带项目注入）进 engine，变更推送 renderer
  adapter.subscribe(
    createAdapterEventHandler({
      sessions,
      engine,
      send: (event) => {
        for (const l of chatListeners) l(event);
      },
      sendChange: emitTracker,
    }),
  );
  const pty = createPtyHost(
      {
        pty: new EchoPty(),
        execFileSync: () => undefined,
        execFileTextSync: () => "",
        existsSync: () => true,
        resolve: (p) => p,
        tmpdir: () => "C:\\tmp",
        env: { USERPROFILE: "C:\\home\\u" },
        platform: "win32",
        cwd: () => "C:\\cwd",
        shellOverride: () => null,
        cliExeOverride: () => null,
      },
      {
        started: () => undefined,
        data: () => undefined,
        exit: () => undefined,
        error: () => undefined,
      },
  );
  const deps: IpcDeps = {
    adapter,
    pty,
    projects: new ProjectStore(db),
    sessions,
    engine,
    emitTrackerChange: emitTracker,
    pickDirectory: opts?.pick ?? (async () => null),
    getCurrentProjectId: () => state.currentProjectId,
    setCurrentProjectId: (id) => {
      state.currentProjectId = id;
      if (opts?.statePath) writeFileSync(opts.statePath, JSON.stringify(state), "utf-8");
    },
    // #70 C2：归档/删除编排唯一写者（补齐依赖形状；本测试不触发相关通道）
    lifecycle: createSessionLifecycle({ sessions, procs: createAdapterSessionProcesses(adapter, pty) }),
  };
  return {
    invoke: (req: IpcRequest) => handleIpc(deps, req),
    invokeModels: (req: ModelsRequest) => handleModelsIpc(deps, req),
    onEvent: (h) => {
      chatListeners.add(h);
      return () => {
        chatListeners.delete(h);
      };
    },
    onTerminalEvent: (_h: (event: TerminalEvent) => void) => () => undefined,
    onTrackerEvent: (h) => {
      trackerListeners.add(h);
      return () => {
        trackerListeners.delete(h);
      };
    },
  };
}

// 测试注入的演示 cwd（等价生产 AppInfo.fakeDemoCwd）
const DEMO_CWD = join(tmpdir(), "kb-fake-demo");

/** 挂载 AppShell（App 的可注入骨架：视图切换 + 侧栏看板入口 + kanban controller）并暴露 chat controller */
function mountApp(transport: ChatTransport) {
  const holder: { controller?: ChatController } = {};
  render(<AppShell transport={transport} demoCwd={DEMO_CWD} onChatController={(c) => (holder.controller = c)} />);
  return {
    ctl: (): ChatController => {
      if (!holder.controller) throw new Error("controller 未就绪");
      return holder.controller;
    },
    transport,
    flush: async () =>
      act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      }),
  };
}

/** 组装完整 fixture：VirtualClock + FakeAdapter（事件泵进 engine）+ transport + AppShell 挂载 */
function bootFixture(opts?: { dbPath?: string; statePath?: string; pick?: () => Promise<string | null>; restore?: boolean }) {
  const clock = new VirtualClock();
  const transport = makeTransport(new FakeAdapter({ clock }), opts);
  const mounted = mountApp(transport);
  return {
    ...mounted,
    clock,
    advance: () =>
      act(() => {
        clock.runToIdle();
      }),
  };
}

/** 进/出看板视图（侧栏底部入口按钮；click 返回值显式丢弃以满足 void 返回类型） */
const enterKanban = (): void => {
  fireEvent.click(screen.getByTestId("kanban-entry"));
};
const backToChat = enterKanban;

/** 列定位（kanban-col-none / kanban-col-Design / ...） */
const col = (key: string): HTMLElement => screen.getByTestId(`kanban-col-${key}`);

/** 输入并发送一条消息（聊天视图 composer） */
function send(text: string): void {
  fireEvent.change(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "发送 ➤" }));
}

/** 经 transport 发一条请求（kanban:link 等动作面） */
async function invoke(t: { transport: ChatTransport }, req: IpcRequest): Promise<IpcResult> {
  let res: IpcResult = { ok: false, error: { code: "E_INTERNAL", message: "未执行" } };
  await act(async () => {
    res = await t.transport.invoke(req);
  });
  return res;
}

/** kanban:list 当前需求行（找 requirementId 用） */
async function listRequirements(t: { transport: ChatTransport }): Promise<RequirementCardRow[]> {
  const r = await invoke(t, { channel: "kanban:list" });
  return r.ok && r.requirements ? r.requirements : [];
}

describe("看板入口与无项目空板（#18；原型一致项 1）", () => {
  afterEach(() => {
    cleanup();
    for (const db of openDbs.splice(0)) db.close();
  });

  it("无项目上下文：入口进看板 → 空板（五列计数 0）+ 引导文案；入口按钮带「看板」标识", async () => {
    const t = bootFixture();
    await t.flush();
    expect(screen.getByTestId("kanban-entry").textContent).toContain("看板");
    enterKanban();
    expect(screen.getByTestId("kanban-board")).toBeTruthy();
    expect(screen.getByText("选择或注册项目后查看其需求")).toBeTruthy();
    for (const key of ["none", "Design", "Implement", "PR", "Retro"]) {
      expect(within(col(key)).queryAllByTestId("requirement-card")).toHaveLength(0);
    }
    backToChat();
    expect(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…")).toBeTruthy(); // 共享侧栏 + 聊天可回
  });

  it("注册项目后：入口右侧显示当前项目名指示；看板无引导文案", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "kb-kanban-entry-"));
    try {
      const projDir = join(tmpRoot, "demo-repo");
      mkdirSync(join(projDir, ".git"), { recursive: true });
      const t = bootFixture({ dbPath: join(tmpRoot, "state.db"), pick: async () => projDir });
      await t.flush();
      fireEvent.click(screen.getByRole("button", { name: "＋ 注册本地目录…" }));
      await screen.findAllByText("demo-repo");
      expect(screen.getByTestId("kanban-entry").textContent).toContain("demo-repo");
      enterKanban();
      expect(screen.queryByText("选择或注册项目后查看其需求")).toBeNull();
    } finally {
      cleanup();
      for (const db of openDbs.splice(0)) db.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("五列看板：列映射/建卡/移列/徽标/会话数/删除（#18；原型一致项 2/3）", () => {
  let tmpRoot = "";
  let projDir = "";
  let t: ReturnType<typeof bootFixture>;

  afterEach(() => {
    cleanup();
    for (const db of openDbs.splice(0)) db.close();
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = "";
    }
  });

  /** 注册项目 + 建一个项目内 Claude(Fake) 会话（自动建卡的事件源） */
  async function bootWithProjectSession(): Promise<void> {
    fireEvent.click(screen.getByRole("button", { name: "＋ 注册本地目录…" }));
    await screen.findAllByText("demo-repo");
    await t.flush(); // 冲刷 passive effects：holder 里的 controller 须携带最新项目列表（openSessionDraft 依赖）
    await act(async () => {
      await createViaDraft(t.ctl, "claude", { projectId: await currentProjectId() });
    });
    await screen.findByText("新会话 · Claude");
    t.advance(); // 首条 turn 完成回空闲（供后续用例继续发消息）
  }

  async function currentProjectId(): Promise<string> {
    const r = await invoke(t, { channel: "project:list" });
    return (r.ok && r.currentProjectId) || "";
  }

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-kanban-board-"));
    projDir = join(tmpRoot, "demo-repo");
    mkdirSync(join(projDir, ".git"), { recursive: true });
    t = bootFixture({ dbPath: join(tmpRoot, "state.db"), pick: async () => projDir });
    await t.flush();
  });

  it("「＋」手动建卡进未开始列（stage=null→列 0）+ verified design-feature 自动建卡进 Design 列；列头计数与会话数", async () => {
    await bootWithProjectSession();
    enterKanban();
    // 未开始列「＋」手动建卡（原型一致项 2）
    fireEvent.click(within(col("none")).getByTitle("手动新建需求（归属当前项目）"));
    await waitFor(() => expect(within(col("none")).getByText("待命名需求")).toBeTruthy());
    expect(within(col("none")).getAllByTestId("requirement-card")).toHaveLength(1);
    expect(within(col("none")).getByTestId("kanban-col-count").textContent).toBe("1"); // 列头计数
    // 聊天视图发 verified design-feature → 自动建卡实时出现（Design 列）
    backToChat();
    await act(async () => {
      send("/design-feature verified 设计阶段2看板");
    });
    t.advance();
    enterKanban();
    await waitFor(() => expect(within(col("Design")).getAllByText("待命名需求").length).toBeGreaterThan(0));
    expect(within(col("Design")).getByText("◍ 1 会话")).toBeTruthy(); // 自动建卡关联触发会话
    expect(within(col("Design")).getAllByTestId("verified-badge").length).toBeGreaterThan(0); // verified 绿徽标
    expect(within(col("Design")).getByText(/design-feature · Claude/)).toBeTruthy(); // 阶段依据行
    expect(within(col("Design")).getByTestId("kanban-col-count").textContent).toBe("1");
    // 未开始列的手动卡仍在（两张卡分列）
    expect(within(col("none")).getAllByTestId("requirement-card")).toHaveLength(1);
  });

  it("阶段变化移列 + uncertain/verified 徽标：self_reported → Implement+待确认；更新发生的 verified → 转正", async () => {
    await bootWithProjectSession();
    // verified design-feature 自动建卡（Design 列）
    await act(async () => {
      send("/design-feature verified");
    });
    t.advance();
    enterKanban();
    await waitFor(() => expect(within(col("Design")).getAllByText("待命名需求").length).toBeGreaterThan(0));
    backToChat();
    // self_reported implement-spec → 驱动阶段但标 uncertain
    await act(async () => {
      send("/implement-spec");
    });
    t.advance();
    enterKanban();
    await waitFor(() => expect(within(col("Implement")).getAllByTestId("uncertain-badge").length).toBeGreaterThan(0));
    expect(within(col("Implement")).getByText("待确认")).toBeTruthy();
    expect(within(col("Design")).queryAllByTestId("requirement-card")).toHaveLength(0); // 移列
    // 更新发生的 verified → 自动转正（uncertain 清除 + verified 徽标）
    backToChat();
    await act(async () => {
      send("/implement-spec verified");
    });
    t.advance();
    enterKanban();
    await waitFor(() => expect(within(col("Implement")).getAllByTestId("verified-badge").length).toBeGreaterThan(0));
    expect(within(col("Implement")).queryAllByTestId("uncertain-badge")).toHaveLength(0);
  });

  it("会话数随 link/unlink 变化（实时）+ 删除实时移除卡片", async () => {
    await bootWithProjectSession();
    // 再建第二个项目会话（link 用）
    await act(async () => {
      await createViaDraft(t.ctl, "claude", { projectId: await currentProjectId() });
    });
    enterKanban();
    fireEvent.click(within(col("none")).getByTitle("手动新建需求（归属当前项目）"));
    await waitFor(() => expect(within(col("none")).getByText("待命名需求")).toBeTruthy());
    expect(within(col("none")).getByText("◍ 0 会话")).toBeTruthy();
    // link 两个会话 → 会话数 2（经 tracker session_linked 实时更新）
    const req = (await listRequirements(t)).find((r) => r.stage === null)!;
    const pid = await currentProjectId();
    const sessionIds = t.ctl().sessions.filter((s) => s.projectId === pid).map((s) => s.sessionId);
    expect(sessionIds).toHaveLength(2);
    expect((await invoke(t, { channel: "kanban:link", sessionId: sessionIds[0]!, requirementId: req.id })).ok).toBe(true);
    await waitFor(() => expect(within(col("none")).getByText("◍ 1 会话")).toBeTruthy());
    expect((await invoke(t, { channel: "kanban:link", sessionId: sessionIds[1]!, requirementId: req.id })).ok).toBe(true);
    await waitFor(() => expect(within(col("none")).getByText("◍ 2 会话")).toBeTruthy());
    // unlink 一个 → 会话数回落
    expect((await invoke(t, { channel: "kanban:unlink", sessionId: sessionIds[0]! })).ok).toBe(true);
    await waitFor(() => expect(within(col("none")).getByText("◍ 1 会话")).toBeTruthy());
    // 删除需求 → 卡片实时移除
    expect((await invoke(t, { channel: "kanban:delete", requirementId: req.id })).ok).toBe(true);
    await waitFor(() => expect(within(col("none")).queryAllByTestId("requirement-card")).toHaveLength(0));
  });

  it("视图切换不停止 CLI：流式中进看板再回，会话后台完成、全文在", async () => {
    await t.flush(); // boot 演示会话（无项目亦可验证：会话生命周期与看板视图无关）
    await act(async () => {
      send("默认演示");
    });
    act(() => {
      t.clock.advance(700); // 进入流式
    });
    enterKanban();
    expect(screen.queryByPlaceholderText("输入消息，/ 开头触发 Skill…")).toBeNull(); // 看板视图（composer 不在）
    t.advance(); // 后台完成（切换不停止）
    backToChat();
    expect(screen.getByText("基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。")).toBeTruthy();
    expect(screen.getByText("空闲")).toBeTruthy();
  });
});

describe("按项目过滤（#18；S2-08）", () => {
  let tmpRoot = "";

  afterEach(() => {
    cleanup();
    for (const db of openDbs.splice(0)) db.close();
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = "";
    }
  });

  it("两项目各一张卡：看板只显示当前项目的需求，切项目即换卡", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-kanban-filter-"));
    const dirA = join(tmpRoot, "repo-a");
    const dirB = join(tmpRoot, "repo-b");
    mkdirSync(join(dirA, ".git"), { recursive: true });
    mkdirSync(join(dirB, ".git"), { recursive: true });
    const picks = [dirA, dirB];
    const t = bootFixture({ dbPath: join(tmpRoot, "state.db"), pick: async () => picks.shift() ?? null });
    await t.flush();

    // 注册项目 A + 建 A 会话发 verified design-feature（A 得一张 Design 卡）
    fireEvent.click(screen.getByRole("button", { name: "＋ 注册本地目录…" }));
    await screen.findAllByText("repo-a");
    const listA = await invoke(t, { channel: "project:list" });
    const pidA = listA.ok ? listA.currentProjectId ?? "" : "";
    await act(async () => {
      await createViaDraft(t.ctl, "claude", { projectId: pidA }, "/design-feature verified");
    });
    await screen.findByText("新会话 · Claude");
    t.advance();
    enterKanban();
    await waitFor(() => expect(within(col("Design")).getAllByText("待命名需求").length).toBeGreaterThan(0));

    // 注册项目 B（currentProjectId 切到 B）：A 卡隐藏、B 空板（无引导文案，已有项目上下文）
    fireEvent.click(screen.getByRole("button", { name: "＋ 注册" }));
    await screen.findAllByText("repo-b");
    await waitFor(() => expect(within(col("Design")).queryAllByTestId("requirement-card")).toHaveLength(0));
    expect(screen.queryByText("选择或注册项目后查看其需求")).toBeNull();
    // B 手动建卡（未开始列）
    fireEvent.click(within(col("none")).getByTitle("手动新建需求（归属当前项目）"));
    await waitFor(() => expect(within(col("none")).getAllByText("待命名需求").length).toBeGreaterThan(0));

    // 切回 A：A 的 Design 卡在、B 的未开始卡不在（TopBar 徽标与项目行同名，取侧栏行）
    fireEvent.click(within(screen.getByRole("complementary")).getByText("repo-a"));
    await waitFor(() => expect(within(col("Design")).getAllByText("待命名需求").length).toBeGreaterThan(0));
    expect(within(col("none")).queryAllByTestId("requirement-card")).toHaveLength(0);
  });
});

describe("重启再水化（#18；S2-17）", () => {
  let tmpRoot = "";

  afterEach(() => {
    cleanup();
    for (const db of openDbs.splice(0)) db.close();
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = "";
    }
  });

  it("退出前 Design 列有卡 → 同 db 二次启动看板一致（kanban:list 再水化）", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-kanban-restart-"));
    const projDir = join(tmpRoot, "demo-repo");
    mkdirSync(join(projDir, ".git"), { recursive: true });
    const dbPath = join(tmpRoot, "state.db");
    const statePath = join(tmpRoot, "app-state.json");

    // 第一次启动：注册 + 项目会话 verified design-feature 建卡
    const t1 = bootFixture({ dbPath, statePath, pick: async () => projDir, restore: true });
    await t1.flush();
    fireEvent.click(screen.getByRole("button", { name: "＋ 注册本地目录…" }));
    await screen.findAllByText("demo-repo");
    await t1.flush(); // 冲刷 passive effects：holder 里的 controller 须携带最新项目列表（openSessionDraft 依赖）
    const listA = await invoke(t1, { channel: "project:list" });
    const pid = listA.ok ? listA.currentProjectId ?? "" : "";
    await act(async () => {
      await createViaDraft(t1.ctl, "claude", { projectId: pid }, "/design-feature verified");
    });
    await screen.findByText("新会话 · Claude");
    act(() => {
      t1.advance();
    });
    enterKanban();
    await waitFor(() => expect(within(col("Design")).getAllByText("待命名需求").length).toBeGreaterThan(0));

    // 「重启」：新 engine（restore 重放事件日志）+ 新 store（kanban:list 再水化）→ 看板一致
    cleanup();
    for (const db of openDbs.splice(0)) db.close();
    const t2 = bootFixture({ dbPath, statePath, pick: async () => null, restore: true });
    await t2.flush();
    enterKanban();
    await waitFor(() => expect(within(col("Design")).getAllByText("待命名需求").length).toBeGreaterThan(0));
    expect(within(col("Design")).getByText("◍ 1 会话")).toBeTruthy();
    expect(within(col("Design")).getAllByTestId("verified-badge").length).toBeGreaterThan(0);
  });
});
