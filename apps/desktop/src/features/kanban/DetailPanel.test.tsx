// 用途：详情滑出面板组件测试（#19，spec #15 Testing seam 4）—— FakeAdapter 事件流直连驱动真实组件：面板开合（点击卡片开、关闭钮/遮罩关）、标题行内编辑持久化（模拟重启再水化仍为人工标题）、五段阶段修正条即时移列（含回未开始）、uncertain 提示条与确认清除、删除二次确认与卡片实时消失、手动建卡重启保留、删除墓碑 + 同会话再建卡（对照原型一致项 4/5）
/// <reference types="node" /> <!-- 本文件用 node:fs/os/path 建持久化 fixture（重启再水化用例） -->
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent, CliKind, IpcRequest, ModelsRequest, RequirementCardRow, TerminalEvent, TrackerChangeWire } from "@kanban/ipc-schema";
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
import { DetailPanel, type DetailActions } from "./DetailPanel";
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

/** FakeAdapter 直连 transport（与生产主进程同款接线，照 KanbanWorkspace.test.tsx）：adapter 事件泵 + kanban 通道 emitTrackerChange */
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

/** 进/出看板视图（侧栏底部入口按钮） */
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

/** 点卡片打开详情面板（面板数据源 = activeRequirementId） */
const openCard = (key: string, title: string): void => {
  fireEvent.click(within(col(key)).getByText(title));
};

/** 模拟重启：卸载 + 关库 → 同 db/state 二次启动（engine.restore 重放 + kanban:list 再水化） */
function restartFixture(opts: { dbPath: string; statePath: string }): ReturnType<typeof bootFixture> {
  cleanup();
  for (const db of openDbs.splice(0)) db.close();
  const t2 = bootFixture({ ...opts, pick: async () => null, restore: true });
  return t2;
}

describe("详情滑出面板（#19；原型一致项 4/5）", () => {
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

  /** 注册项目 + 建一个项目内 Claude(Fake) 会话（自动建卡的事件源） */
  async function bootWithProjectSession(): Promise<void> {
    fireEvent.click(screen.getByRole("button", { name: "＋ 注册本地目录…" }));
    await screen.findAllByText("demo-repo");
    await t.flush(); // 冲刷 passive effects：holder 里的 controller 须携带最新项目列表（openSessionDraft 依赖）
    await act(async () => {
      await createViaDraft(t.ctl, "claude", { projectId: await currentProjectId() });
    });
    await within(screen.getByRole("complementary")).findByText("默认演示"); // #94：标题=首条派生（与气泡同文，限侧栏）
    t.advance(); // 首条 turn 完成回空闲（供后续用例继续发消息）
  }

  /** 未开始列「＋」手动建卡并等待出现（#84 建卡即命名：Esc 放弃命名保留缺省标题） */
  async function createManualCard(): Promise<void> {
    fireEvent.click(within(col("none")).getByTitle("手动新建需求（归属当前项目）"));
    await waitFor(() => expect(within(col("none")).getByTestId("card-title-input")).toBeTruthy());
    fireEvent.keyDown(within(col("none")).getByTestId("card-title-input"), { key: "Escape" });
    await waitFor(() => expect(within(col("none")).getByText("待命名需求")).toBeTruthy());
  }

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-kanban-detail-"));
    projDir = join(tmpRoot, "demo-repo");
    mkdirSync(join(projDir, ".git"), { recursive: true });
    t = bootFixture({ dbPath: join(tmpRoot, "state.db"), statePath: join(tmpRoot, "app-state.json"), pick: async () => projDir });
    await t.flush();
  });

  it("面板开合：点卡片开（标题/五段条在）；关闭钮关；点看板遮罩区域关；再开不残留", async () => {
    await bootWithProjectSession();
    enterKanban();
    await createManualCard();

    // 点击卡片 → 面板滑出（标题行内编辑 + 五段阶段条 + 关联会话挂点 + 需求区）
    openCard("none", "待命名需求");
    expect(screen.getByTestId("detail-panel")).toBeTruthy();
    expect((screen.getByTestId("detail-title-input") as HTMLInputElement).value).toBe("待命名需求");
    for (const key of ["none", "Design", "Implement", "PR", "Retro"]) {
      expect(screen.getByTestId(`stage-seg-${key}`)).toBeTruthy();
    }
    expect(screen.getByTestId("detail-sessions")).toBeTruthy(); // #20 关联会话挂点

    // 关闭钮 → 面板收起
    fireEvent.click(screen.getByTestId("detail-close"));
    expect(screen.queryByTestId("detail-panel")).toBeNull();

    // 再开 → 点看板遮罩区域（列头一侧）关闭
    openCard("none", "待命名需求");
    expect(screen.getByTestId("detail-panel")).toBeTruthy();
    fireEvent.click(screen.getByTestId("detail-backdrop"));
    expect(screen.queryByTestId("detail-panel")).toBeNull();
  });

  it("标题行内编辑：改名实时落卡片；空串不落；模拟重启再水化仍为人工标题（不被「待命名需求」回退）", async () => {
    await bootWithProjectSession();
    enterKanban();
    await createManualCard();
    openCard("none", "待命名需求");

    // 行内编辑 → blur 提交（kanban:rename 经事件流 → requirement_renamed 推送 → 卡片实时更新）
    const input = screen.getByTestId("detail-title-input");
    fireEvent.change(input, { target: { value: "调研桌面端打包方案" } });
    fireEvent.blur(input);
    await waitFor(() => expect(within(col("none")).getByText("调研桌面端打包方案")).toBeTruthy());
    expect(within(col("none")).queryByText("待命名需求")).toBeNull();

    // 空串/纯空白不落 rename（恢复原标题，不产生非法请求）
    fireEvent.change(screen.getByTestId("detail-title-input"), { target: { value: "   " } });
    fireEvent.blur(screen.getByTestId("detail-title-input"));
    await t.flush();
    expect(within(col("none")).getByText("调研桌面端打包方案")).toBeTruthy();

    // 模拟重启（restore 重放 + kanban:list 再水化）：人工标题保留
    t = restartFixture({ dbPath: join(tmpRoot, "state.db"), statePath: join(tmpRoot, "app-state.json") });
    await t.flush();
    enterKanban();
    await waitFor(() => expect(within(col("none")).getByText("调研桌面端打包方案")).toBeTruthy());
    expect(within(col("none")).queryAllByTestId("requirement-card")).toHaveLength(1);
  });

  it("五段阶段修正条：各档即时生效移列（含回未开始），当前段高亮，依据显示手动修正", async () => {
    await bootWithProjectSession();
    enterKanban();
    await createManualCard();
    openCard("none", "待命名需求");

    // 未开始（初始）段高亮
    expect(screen.getByTestId("stage-seg-none").getAttribute("data-active")).toBe("true");

    // Design → 卡片即时移列 + 当前依据为手动修正
    fireEvent.click(screen.getByTestId("stage-seg-Design"));
    await waitFor(() => expect(within(col("Design")).getByText("待命名需求")).toBeTruthy());
    expect(screen.getByTestId("stage-seg-Design").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("stage-seg-none").getAttribute("data-active")).toBe("false");
    expect(screen.getByText(/当前依据：手动修正/)).toBeTruthy();

    // Implement / PR / Retro 逐档即时移列
    fireEvent.click(screen.getByTestId("stage-seg-Implement"));
    await waitFor(() => expect(within(col("Implement")).getByText("待命名需求")).toBeTruthy());
    fireEvent.click(screen.getByTestId("stage-seg-PR"));
    await waitFor(() => expect(within(col("PR")).getByText("待命名需求")).toBeTruthy());
    fireEvent.click(screen.getByTestId("stage-seg-Retro"));
    await waitFor(() => expect(within(col("Retro")).getByText("待命名需求")).toBeTruthy());

    // 回「未开始」：wire "none" → tracker 归一 null → 卡片回未开始列
    fireEvent.click(screen.getByTestId("stage-seg-none"));
    await waitFor(() => expect(within(col("none")).getByText("待命名需求")).toBeTruthy());
    expect(screen.getByTestId("stage-seg-none").getAttribute("data-active")).toBe("true");
    for (const key of ["Design", "Implement", "PR", "Retro"]) {
      expect(within(col(key)).queryAllByTestId("requirement-card")).toHaveLength(0);
    }
  });

  it("uncertain 提示条 +「确认当前阶段」：self_reported 驱动 → 卡片待确认徽标 + 面板提示；确认后徽标与提示条清除、阶段保持", async () => {
    await bootWithProjectSession();
    // verified design-feature 自动建卡（Design）→ self_reported implement-spec 驱动 Implement + uncertain
    await act(async () => {
      send("/design-feature verified");
    });
    t.advance();
    await act(async () => {
      send("/implement-spec");
    });
    t.advance();
    enterKanban();
    await waitFor(() => expect(within(col("Implement")).getAllByTestId("uncertain-badge").length).toBeGreaterThan(0));

    // 点卡片开面板：提示条含信号来源（skill · CLI），确认按钮在
    openCard("Implement", "待命名需求");
    expect(screen.getByTestId("uncertain-note").textContent).toContain("implement-spec");
    expect(screen.getByTestId("uncertain-note").textContent).toContain("Codex");
    expect(screen.getByTestId("confirm-stage-button")).toBeTruthy();

    // 确认 = setStage 当前阶段（manual verified 确认语义）→ 徽标与提示条清除、卡片保持 Implement 列
    fireEvent.click(screen.getByTestId("confirm-stage-button"));
    await waitFor(() => expect(within(col("Implement")).queryAllByTestId("uncertain-badge")).toHaveLength(0));
    expect(screen.queryByTestId("uncertain-note")).toBeNull();
    expect(within(col("Implement")).getAllByTestId("requirement-card")).toHaveLength(1); // 阶段保持
  });

  it("删除需求：二次确认弹层文案三要素；取消保留；确认后卡片实时消失（requirement_deleted 推送）且面板关闭", async () => {
    await bootWithProjectSession();
    enterKanban();
    await createManualCard();
    openCard("none", "待命名需求");

    // 删除按钮 → 二次确认弹层（原型一致项 5 文案：仅清需求与关联 / 会话与历史保留 / 不可撤销；
    // #35 spec #27 J 节：memory 处置如实说明——项目知识保留、需求总结与待审候选一并删除）
    fireEvent.click(screen.getByTestId("delete-requirement-button"));
    const dialog = screen.getByTestId("delete-confirm-dialog");
    expect(dialog.textContent).toContain("仅删除需求卡片与全部会话关联");
    expect(dialog.textContent).toContain("会话本身、聊天历史与事件日志保留");
    expect(dialog.textContent).toContain("已接受/已编辑的项目知识保留");
    expect(dialog.textContent).toContain("需求总结与待审候选一并删除");
    expect(dialog.textContent).toContain("不可撤销");

    // 取消 → 弹层关、卡片仍在
    fireEvent.click(screen.getByTestId("cancel-delete-button"));
    expect(screen.queryByTestId("delete-confirm-dialog")).toBeNull();
    expect(within(col("none")).getAllByTestId("requirement-card")).toHaveLength(1);

    // 确认删除 → 卡片实时消失 + 面板收起
    fireEvent.click(screen.getByTestId("delete-requirement-button"));
    fireEvent.click(screen.getByTestId("confirm-delete-button"));
    await waitFor(() => expect(within(col("none")).queryAllByTestId("requirement-card")).toHaveLength(0));
    expect(screen.queryByTestId("detail-panel")).toBeNull();
  });

  it("删除墓碑语义：删除后同会话再 verified design-feature 建新卡；重启后新卡保留、旧卡不复活", async () => {
    await bootWithProjectSession();
    await act(async () => {
      send("/design-feature verified");
    });
    t.advance();
    enterKanban();
    await waitFor(() => expect(within(col("Design")).getAllByText("待命名需求").length).toBeGreaterThan(0));

    // 删除自动建卡
    openCard("Design", "待命名需求");
    fireEvent.click(screen.getByTestId("delete-requirement-button"));
    fireEvent.click(screen.getByTestId("confirm-delete-button"));
    await waitFor(() => expect(within(col("Design")).queryAllByTestId("requirement-card")).toHaveLength(0));

    // 同会话再次 verified design-feature → 建新卡（delete 是墓碑不阻断后续建卡）
    backToChat();
    await act(async () => {
      send("/design-feature verified 再次建卡");
    });
    t.advance();
    enterKanban();
    await waitFor(() => expect(within(col("Design")).getAllByTestId("requirement-card").length).toBe(1));

    // 重启：新卡保留（kanban:list 再水化）、被删旧卡不复活（全库恰一张卡）
    t = restartFixture({ dbPath: join(tmpRoot, "state.db"), statePath: join(tmpRoot, "app-state.json") });
    await t.flush();
    enterKanban();
    await waitFor(() => expect(within(col("Design")).getAllByTestId("requirement-card").length).toBe(1));
    const allCards = ["none", "Design", "Implement", "PR", "Retro"].flatMap((k) => within(col(k)).queryAllByTestId("requirement-card"));
    expect(allCards).toHaveLength(1);
  });
});

describe("详情面板标题编辑失败与还原（#84 T2：失败不再静默）", () => {
  // 密封组件 seam：直接渲染 DetailPanel + stub actions（onRename 结果可注入）
  const CARD: RequirementCardRow = {
    id: "REQ-009",
    title: "原标题",
    stage: null,
    stageBasis: null,
    uncertain: false,
    projectId: "P1",
    sessions: [],
  };

  afterEach(() => {
    cleanup();
  });

  it("重命名失败：输入框回滚原值 + 行内错误提示；再次成功后提示清除", async () => {
    let fail = true;
    const actions: DetailActions = {
      onRename: async (_id, title) => (fail && title === "注定失败" ? "需求不存在：REQ-009" : null),
      onSetStage: () => undefined,
      onDelete: () => undefined,
      onClose: () => undefined,
    };
    render(<DetailPanel card={CARD} actions={actions} related={{ sessions: [] }} />);
    const input = screen.getByTestId("detail-title-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "注定失败" } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByTestId("detail-rename-error").textContent).toBe("重命名失败：需求不存在：REQ-009"));
    expect(input.value).toBe("原标题"); // 回滚为原值（store 未变，显式恢复）
    // 再次编辑成功 → 提示清除
    fireEvent.change(input, { target: { value: "成功的新标题" } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.queryByTestId("detail-rename-error")).toBeNull());
  });

  it("Esc 还原：放弃草稿不触发 onRename（陈旧草稿不得被 blur 提交）", async () => {
    const rename = vi.fn(async () => null);
    const actions: DetailActions = {
      onRename: rename,
      onSetStage: () => undefined,
      onDelete: () => undefined,
      onClose: () => undefined,
    };
    render(<DetailPanel card={CARD} actions={actions} related={{ sessions: [] }} />);
    const input = screen.getByTestId("detail-title-input") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "被放弃的草稿" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(input.value).toBe("原标题"));
    expect(rename).not.toHaveBeenCalled();
    expect(screen.queryByTestId("detail-rename-error")).toBeNull();
  });
});
