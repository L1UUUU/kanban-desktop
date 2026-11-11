// 用途：详情面板「关联会话」区组件测试（#20，spec #15 Testing seam 4）—— FakeAdapter 事件流直连驱动真实组件：关联列表渲染（CLI 色点/状态徽标/US18 分离）、解除后阶段保持与会话数更新、关联已有仅列同项目未关联（含 PTY）、PTY 手动关联、从卡片建会话四 CLI 菜单（创建即关联出现在列表与侧栏）、跳转两方向（面板→聊天选中 / 侧栏徽标→看板选中）；轻量组直挂组件验证 link 三类拒绝原因直达呈现（对照原型一致项 4 关联区/项 6）
/// <reference types="node" /> <!-- 本文件用 node:fs/os/path 建持久化 fixture -->
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent, IpcRequest, TerminalEvent, TrackerChangeWire } from "@kanban/ipc-schema";
import { FakeAdapter, VirtualClock } from "@kanban/cli-host";
import { TrackerEngine } from "@kanban/tracker";
import { openDatabase } from "../../../electron/main/db";
import { createAdapterEventHandler } from "../../../electron/main/adapter-events";
import { handleIpc, type IpcDeps } from "../../../electron/main/ipc";
import { createPtyHost, type PtyLike, type PtyProcess } from "../../../electron/main/pty-host";
import { ProjectStore } from "../../../electron/main/project-store";
import { SessionStore } from "../../../electron/main/session-store";
import { AppShell } from "../../App";
import type { ChatController } from "../chat/use-chat";
import type { SessionView } from "../chat/chat-store";
import type { ChatTransport } from "../../lib/kanban-api";
import { RelatedSessionsArea } from "./RelatedSessionsArea";

// 未关闭的 db 连接（afterEach 统一关，避免 Windows 上临时目录删除 EPERM）
const openDbs: Array<{ close(): void }> = [];

// jsdom 缺 ResizeObserver/matchMedia：xterm 服务需要（生产 Chromium 原生具备；PTY 会话激活时 TerminalPanel 挂载）
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (() => ({
    matches: false,
    media: "",
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** 回显 mock PTY（IpcDeps 形状补齐；经 terminal:create 建 PTY 会话时使用） */
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

/** FakeAdapter 直连 transport（与生产主进程同款接线，照 DetailPanel.test.tsx）：adapter 事件泵 + kanban 通道 emitTrackerChange */
function makeTransport(
  adapter: FakeAdapter,
  opts?: { dbPath?: string; statePath?: string; pick?: () => Promise<string | null> },
): ChatTransport {
  const db = opts?.dbPath ? openDatabase(opts.dbPath) : openDatabase(":memory:");
  openDbs.push(db);
  const state: { currentProjectId: string | null } = { currentProjectId: null };
  const chatListeners = new Set<(event: AdapterEvent) => void>();
  const trackerListeners = new Set<(change: TrackerChangeWire) => void>();
  const emitTracker = (change: TrackerChangeWire): void => {
    for (const l of trackerListeners) l(change);
  };
  const sessions = new SessionStore(db);
  const engine = new TrackerEngine(db);
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
  const deps: IpcDeps = {
    adapter,
    pty: createPtyHost(
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
    ),
    projects: new ProjectStore(db),
    sessions,
    engine,
    emitTrackerChange: emitTracker,
    pickDirectory: opts?.pick ?? (async () => null),
    getCurrentProjectId: () => state.currentProjectId,
    setCurrentProjectId: (id) => {
      state.currentProjectId = id;
    },
  };
  return {
    invoke: (req: IpcRequest) => handleIpc(deps, req),
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

/** 挂载 AppShell 并暴露 chat controller */
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
function bootFixture(opts?: { dbPath?: string; pick?: () => Promise<string | null> }) {
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

/** 进/出看板视图（侧栏底部入口按钮） */
const enterKanban = (): void => {
  fireEvent.click(screen.getByTestId("kanban-entry"));
};

/** 列定位（kanban-col-none / kanban-col-Design / ...） */
const col = (key: string): HTMLElement => screen.getByTestId(`kanban-col-${key}`);

/** 输入并发送一条消息（聊天视图 composer，发往当前活跃会话） */
function send(text: string): void {
  fireEvent.change(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "发送 ➤" }));
}

/** 点卡片打开详情面板 */
const openCard = (key: string, title: string): void => {
  fireEvent.click(within(col(key)).getByText(title));
};

/** 侧栏结构化/PTY 会话行按标题定位 */
const sidebarRow = (title: string): HTMLElement => {
  const row = screen.getAllByTestId("session-row").find((r) => r.textContent?.includes(title));
  if (!row) throw new Error(`侧栏会话行未找到：${title}`);
  return row;
};

describe("详情面板关联区（#20；原型一致项 4 关联区）", () => {
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

  async function currentProjectId(): Promise<string> {
    const r = await act(async () => t.transport.invoke({ channel: "project:list" }));
    return (r.ok && r.currentProjectId) || "";
  }

  /** 注册项目 + 建 Claude 会话 + verified design-feature 自动建卡（Design、关联该会话） */
  async function bootWithLinkedCard(): Promise<void> {
    fireEvent.click(screen.getByRole("button", { name: "＋ 注册本地目录…" }));
    await screen.findAllByText("demo-repo");
    await act(async () => {
      await t.ctl().createSession("claude", { cwd: projDir, projectId: await currentProjectId() });
    });
    await screen.findByText("新会话 · Claude");
    await act(async () => {
      send("/design-feature verified");
    });
    t.advance();
  }

  /** 等待自动建卡出现在 Design 列并打开详情面板 */
  async function openLinkedCardPanel(): Promise<void> {
    enterKanban();
    await waitFor(() => expect(within(col("Design")).getAllByTestId("requirement-card").length).toBeGreaterThan(0));
    openCard("Design", "待命名需求");
    expect(screen.getByTestId("detail-panel")).toBeTruthy();
  }

  /** 建一个同项目 OpenCode 会话（未关联；建后成为活跃会话） */
  async function createOpencodeSession(): Promise<string> {
    const projectId = await currentProjectId();
    await act(async () => {
      await t.ctl().createSession("opencode", { cwd: projDir, projectId });
    });
    await screen.findByText("新会话 · OpenCode");
    const s = t.ctl().sessions.find((x) => x.cli === "opencode");
    if (!s) throw new Error("OpenCode 会话未登记");
    return s.sessionId;
  }

  /** 经侧栏项目行「＋」菜单建一个同项目 PTY 终端会话（未关联；#60 草稿：点菜单只开草稿，键入首字符才创建） */
  async function createPtyViaSidebarMenu(): Promise<string> {
    fireEvent.click(screen.getByTitle("新建会话（选择 CLI）"));
    fireEvent.click(screen.getByRole("button", { name: /PTY 终端/ }));
    await typeDraftFirstInput();
    const s = t.ctl().sessions.find((x) => x.cli === "pty");
    if (!s) throw new Error("PTY 会话未登记");
    return s.sessionId;
  }

  /** 草稿终端键入首字符触发创建（xterm 隐藏 textarea keyDown → onData → terminal:create） */
  async function typeDraftFirstInput(): Promise<void> {
    await waitFor(() => expect(document.querySelector(".xterm-helper-textarea")).toBeTruthy());
    fireEvent.keyDown(document.querySelector(".xterm-helper-textarea") as Element, { key: "a", code: "KeyA", keyCode: 97 });
    await screen.findAllByText(/终端 · pwsh/);
  }

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-kanban-related-"));
    projDir = join(tmpRoot, "demo-repo");
    mkdirSync(join(projDir, ".git"), { recursive: true });
    t = bootFixture({ dbPath: join(tmpRoot, "state.db"), pick: async () => projDir });
    await t.flush();
  });

  it("关联列表渲染：CLI 色点/标题/活动状态徽标/跳转与解除钮；US18 分离——卡片不显示活动状态", async () => {
    await bootWithLinkedCard();
    await openLinkedCardPanel();

    // 关联行：CLI 色点（claude）+ 标题 + 状态徽标（空闲）+ 跳转 + 解除
    const row = screen.getByTestId("related-session");
    expect(row.textContent).toContain("新会话 · Claude");
    expect(row.querySelector(".bg-claude")).toBeTruthy();
    expect(within(row).getByText("空闲")).toBeTruthy();
    expect(within(row).getByTestId("related-jump")).toBeTruthy();
    expect(within(row).getByTestId("related-unlink")).toBeTruthy();
    // 区块标题带关联计数
    expect(screen.getByTestId("detail-sessions").textContent).toContain("关联会话（1）");

    // US18 分离呈现：活动状态只在会话行显示，卡片无活动状态徽标
    const card = within(col("Design")).getByTestId("requirement-card");
    expect(card.textContent).not.toContain("空闲");
    expect(card.textContent).not.toContain("运行中");
  });

  it("解除关联：卡片会话数即时更新（1→0）、阶段保持不回退、面板列表清空、侧栏 REQ 徽标消失", async () => {
    await bootWithLinkedCard();
    await openLinkedCardPanel();
    await waitFor(() => expect(within(col("Design")).getByText("◍ 1 会话")).toBeTruthy());
    expect(within(sidebarRow("新会话 · Claude")).getByTestId("req-badge").textContent).toBe("REQ-001");

    // 解除 → 卡片会话数即时更新 + 阶段保持（卡片仍在 Design 列）
    fireEvent.click(within(screen.getByTestId("related-session")).getByTestId("related-unlink"));
    await waitFor(() => expect(within(col("Design")).getByText("◍ 0 会话")).toBeTruthy());
    expect(within(col("Design")).getAllByTestId("requirement-card")).toHaveLength(1);
    expect(within(col("none")).queryAllByTestId("requirement-card")).toHaveLength(0);

    // 面板列表清空 + 侧栏徽标消失
    await waitFor(() => expect(screen.getByTestId("detail-sessions").textContent).toContain("暂无关联会话"));
    await waitFor(() => expect(within(sidebarRow("新会话 · Claude")).queryByTestId("req-badge")).toBeNull());
  });

  it("关联已有：仅列当前项目未关联会话（含 PTY；排除已关联与无项目）；选择即关联——面板行/会话数/侧栏徽标实时出现", async () => {
    await bootWithLinkedCard();
    const openId = await createOpencodeSession();
    await createPtyViaSidebarMenu();
    await openLinkedCardPanel();

    // 候选过滤：同项目未关联（OpenCode + PTY）入选；已关联本卡的 Claude 与无项目演示会话排除
    const select = screen.getByTestId("link-existing-select") as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent ?? "");
    expect(options.some((txt) => txt.includes("新会话 · OpenCode"))).toBe(true);
    expect(options.some((txt) => txt.includes("终端 · pwsh"))).toBe(true);
    expect(options.some((txt) => txt.includes("新会话 · Claude"))).toBe(false);
    expect(options.some((txt) => txt.includes("演示会话"))).toBe(false);

    // 选择 OpenCode 会话 → 关联成功：会话数 1→2、面板出现第二行、侧栏徽标出现
    fireEvent.change(select, { target: { value: openId } });
    await waitFor(() => expect(within(col("Design")).getByText("◍ 2 会话")).toBeTruthy());
    await waitFor(() => expect(screen.getAllByTestId("related-session").length).toBe(2));
    await waitFor(() => expect(within(sidebarRow("新会话 · OpenCode")).getByTestId("req-badge").textContent).toBe("REQ-001"));
    // 已关联会话从候选中消失（再列会被拒绝，列表应只剩 PTY）
    const optionsAfter = Array.from(select.querySelectorAll("option")).map((o) => o.textContent ?? "");
    expect(optionsAfter.some((txt) => txt.includes("新会话 · OpenCode"))).toBe(false);
    expect(optionsAfter.some((txt) => txt.includes("终端 · pwsh"))).toBe(true);
  });

  it("PTY 会话可手动关联：面板出现 PTY 行（pty 色点）、侧栏 PTY 行徽标出现、阶段不被信号驱动", async () => {
    await bootWithLinkedCard();
    const ptyId = await createPtyViaSidebarMenu();
    await openLinkedCardPanel();

    fireEvent.change(screen.getByTestId("link-existing-select"), { target: { value: ptyId } });
    await waitFor(() => expect(within(col("Design")).getByText("◍ 2 会话")).toBeTruthy());

    // 面板 PTY 行：pty 色点 + 终端标题 + 跳转/解除在
    const ptyRow = screen.getAllByTestId("related-session").find((r) => r.textContent?.includes("终端 · pwsh"));
    if (!ptyRow) throw new Error("PTY 关联行未出现");
    expect(ptyRow.querySelector(".bg-pty")).toBeTruthy();
    expect(within(ptyRow).getByTestId("related-jump")).toBeTruthy();

    // 侧栏 PTY 会话行徽标出现；阶段保持 Design（PTY 无 skill 信号）
    await waitFor(() => expect(within(sidebarRow("终端 · pwsh")).getByTestId("req-badge").textContent).toBe("REQ-001"));
    expect(within(col("Design")).getAllByTestId("requirement-card")).toHaveLength(1);
  });

  it("从卡片建会话：四 CLI 菜单（PTY 项标注「无 skill 信号」）；OpenCode/PTY 创建即自动关联——出现在关联列表与侧栏", async () => {
    await bootWithLinkedCard();
    await openLinkedCardPanel();

    // ＋新建会话菜单：三 CLI + PTY 终端；PTY 项标注无 skill 信号
    fireEvent.click(screen.getByTestId("new-session-menu"));
    for (const cli of ["codex", "claude", "opencode", "pty"]) {
      expect(screen.getByTestId(`new-session-item-${cli}`)).toBeTruthy();
    }
    expect(screen.getByTestId("new-session-item-pty").textContent).toContain("无 skill 信号");

    // OpenCode：创建即出现在侧栏 + 关联列表 + 会话数（session:create+requirementId 原子关联）
    fireEvent.click(screen.getByTestId("new-session-item-opencode"));
    await screen.findAllByText("新会话 · OpenCode"); // 侧栏行 + 面板关联行（同名多处，易踩坑 3）
    await waitFor(() => expect(within(col("Design")).getByText("◍ 2 会话")).toBeTruthy());
    await waitFor(() => expect(screen.getAllByTestId("related-session").length).toBe(2));
    await waitFor(() => expect(within(sidebarRow("新会话 · OpenCode")).getByTestId("req-badge").textContent).toBe("REQ-001"));

    // PTY 终端：草稿首输入触发创建即关联（terminal:create+requirementId 随首输入落）；
    // #60：点菜单项自动切回聊天视图显示草稿 → 键入后回看板断言
    fireEvent.click(screen.getByTestId("new-session-menu"));
    fireEvent.click(screen.getByTestId("new-session-item-pty"));
    await typeDraftFirstInput();
    enterKanban();
    await waitFor(() => expect(within(col("Design")).getByText("◍ 3 会话")).toBeTruthy());
    await waitFor(() => expect(within(sidebarRow("终端 · pwsh")).getByTestId("req-badge").textContent).toBe("REQ-001"));
  });

  it("跳转两方向：面板「跳转」→ 聊天视图并选中该会话；侧栏 REQ 徽标点击 → 看板选中该需求开详情面板", async () => {
    await bootWithLinkedCard();
    await createOpencodeSession(); // OpenCode 为活跃会话（验证跳转真正切换选中）
    await openLinkedCardPanel();

    // 方向 A：面板 Claude 行「跳转」→ 切回聊天视图 + 选中 Claude（OpenCode 让位）
    const claudeRow = screen.getAllByTestId("related-session").find((r) => r.textContent?.includes("新会话 · Claude"));
    if (!claudeRow) throw new Error("Claude 关联行未出现");
    fireEvent.click(within(claudeRow).getByTestId("related-jump"));
    expect(screen.queryByTestId("kanban-board")).toBeNull();
    expect(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…")).toBeTruthy();
    await waitFor(() => expect(sidebarRow("新会话 · Claude").getAttribute("data-active")).toBe("true"));
    expect(sidebarRow("新会话 · OpenCode").getAttribute("data-active")).toBe("false");

    // 方向 B：侧栏 Claude 行 REQ 徽标点击 → 进入看板 + 选中该需求（详情面板打开）
    fireEvent.click(within(sidebarRow("新会话 · Claude")).getByTestId("req-badge"));
    expect(screen.getByTestId("kanban-board")).toBeTruthy();
    expect(screen.getByTestId("detail-panel")).toBeTruthy();
    expect((screen.getByTestId("detail-title-input") as HTMLInputElement).value).toBe("待命名需求");
  });
});

describe("link 拒绝原因直达呈现（三类，#20）", () => {
  /** 最小 SessionView fixture（轻量组件直挂，mock actions） */
  const fakeSession = (sessionId: string, projectId: string | null): SessionView => ({
    sessionId,
    cli: "codex",
    title: `会话 ${sessionId}`,
    status: "idle",
    permMode: "auto",
    model: "默认模型",
    projectId,
    cwd: null,
    dirIdentity: "none",
    worktreeName: null,
    items: [],
    pendingApproval: null,
    lastTurnInterrupted: false,
    lastError: null,
    skillConflicts: [],
    skillConflictDismissed: false,
    resumeState: { phase: "idle" },
  });

  const card = {
    id: "REQ-002",
    title: "轻量需求",
    stage: "Design" as const,
    stageBasis: null,
    uncertain: false,
    projectId: "p1",
    sessions: [],
  };

  const REASONS = [
    "会话已关联需求 REQ-001，请先解除关联",
    "会话未归属项目，无法关联需求（请先在项目中创建会话）",
    "跨项目关联被拒绝：会话属项目 pA，需求属项目 pB",
  ];

  it("onLinkExisting 返回的拒绝原因逐条呈现；成功（null）后清除", async () => {
    const onLinkExisting = vi.fn<(sessionId: string) => Promise<string | null>>();
    render(
      <RelatedSessionsArea
        card={card}
        sessions={[fakeSession("s1", "p1")]}
        sessionToReq={{}}
        actions={{ onUnlink: () => undefined, onLinkExisting, onJumpToSession: () => undefined, onCreateSession: () => undefined }}
      />,
    );
    for (const reason of REASONS) {
      onLinkExisting.mockResolvedValueOnce(reason);
      fireEvent.change(screen.getByTestId("link-existing-select"), { target: { value: "s1" } });
      await waitFor(() => expect(screen.getByTestId("link-reject-reason").textContent).toContain(reason));
    }
    // 成功关联（null）→ 拒绝提示清除
    onLinkExisting.mockResolvedValueOnce(null);
    fireEvent.change(screen.getByTestId("link-existing-select"), { target: { value: "s1" } });
    await waitFor(() => expect(screen.queryByTestId("link-reject-reason")).toBeNull());
    expect(onLinkExisting).toHaveBeenCalledWith("s1", "REQ-002");
  });
});
