// 用途：聊天区组件测试（spec Testing seam 4）—— FakeAdapter 事件流直连驱动真实组件：流式/工具卡/审批三键/取消/权限切换/切会话不中断/项目注册与重启恢复（对照原型一致项 2/3/5/6/7）
/// <reference types="node" /> <!-- 本文件用 node:fs/os/path 建持久化 fixture（重启恢复用例） -->
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent, CliKind, ErrorCode, IpcRequest, IpcResult, ProjectRow, TerminalEvent } from "@kanban/ipc-schema";
import { AdapterError, FakeAdapter, VirtualClock, type SendTurnInput } from "@kanban/cli-host";
import { TrackerEngine } from "@kanban/tracker";
import { openDatabase } from "../../../electron/main/db";
import { handleIpc, type IpcDeps } from "../../../electron/main/ipc";
import { createPtyHost, type PtyLike, type PtyProcess } from "../../../electron/main/pty-host";
import { ProjectStore } from "../../../electron/main/project-store";
import { SessionStore } from "../../../electron/main/session-store";
import { ChatWorkspace } from "./ChatWorkspace";
import type { ChatController, OpenDraftOptions } from "./use-chat";
import { resolveSessionCwd } from "./use-chat";
import type { ChatTransport } from "../../lib/kanban-api";
import { setLogSinkForTest } from "../../lib/logger";
import { useProjects } from "../projects/use-projects";

// 未关闭的 db 连接（afterEach 统一关，避免 Windows 上临时目录删除 EPERM）
const openDbs: Array<{ close(): void }> = [];

// jsdom 缺 matchMedia/ResizeObserver：xterm 5 浏览器服务与 TerminalPanel 需要（测试环境 polyfill，生产 Chromium 原生具备）
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

/** 回显 mock PTY（old-kanban mock PTY 模式）：spawn 后发提示符，write 原样回显，kill 触发 exit —— 驱动 TerminalPanel 全链路（不含真实 ConPTY） */
class EchoPty implements PtyLike {
  readonly spawns: Array<{ file: string; args: string[] }> = [];
  private nextPid = 700;
  spawn(file: string, args: string[]): PtyProcess {
    this.spawns.push({ file, args });
    const pid = this.nextPid++;
    let onData: ((data: string) => void) | null = null;
    let onExit: ((info: { exitCode: number; signal?: number }) => void) | null = null;
    const proc: PtyProcess = {
      pid,
      onData: (l) => {
        onData = l;
        return l;
      },
      onExit: (l) => {
        onExit = l;
        return l;
      },
      resize: () => undefined,
      write: (data) => {
        onData?.(data);
      },
      kill: () => {
        onExit?.({ exitCode: 0 });
      },
    };
    queueMicrotask(() => onData?.("PS> "));
    return proc;
  }
}

/** FakeAdapter 直连 transport：复用 Main 路由（handleIpc）做请求侧，adapter.subscribe 做 chat 事件侧，真实 createPtyHost + 回显 mock PTY 做 terminal 事件侧 —— 组件测试即全栈（除 Electron IPC/dialog） */
function makeTransport(
  adapter: FakeAdapter,
  opts?: { dbPath?: string; statePath?: string; pick?: () => Promise<string | null>; userClaudeDir?: string },
): ChatTransport {
  const db = opts?.dbPath ? openDatabase(opts.dbPath) : openDatabase(":memory:");
  openDbs.push(db);
  const state: { currentProjectId: string | null } = { currentProjectId: null };
  if (opts?.statePath) {
    try {
      const raw = JSON.parse(readFileSync(opts?.statePath, "utf-8")) as { currentProjectId?: string | null };
      if (typeof raw.currentProjectId === "string") state.currentProjectId = raw.currentProjectId;
    } catch {
      // 首次运行无状态文件
    }
  }
  // terminal 事件订阅侧：pty 宿主 sink → renderer 订阅者集合
  const terminalListeners = new Set<(event: TerminalEvent) => void>();
  const emitTerminal = (event: TerminalEvent): void => {
    for (const l of terminalListeners) l(event);
  };
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
      started: (terminalId, payload) => emitTerminal({ terminalId, type: "started", ...payload }),
      data: (terminalId, data) => emitTerminal({ terminalId, type: "data", data }),
      exit: (terminalId, payload) => emitTerminal({ terminalId, type: "exit", ...payload }),
      error: (terminalId, payload) => emitTerminal({ terminalId, type: "error", message: payload.message }),
    },
  );
  const deps: IpcDeps = {
    adapter,
    pty,
    // #17：IpcDeps 必挂 TrackerEngine（kanban 通道落事件流；本测试不触发 kanban 通道，仅补齐依赖形状）
    engine: new TrackerEngine(db),
    projects: new ProjectStore(db),
    sessions: new SessionStore(db),
    pickDirectory: opts?.pick ?? (async () => null),
    getCurrentProjectId: () => state.currentProjectId,
    setCurrentProjectId: (id) => {
      state.currentProjectId = id;
      if (opts?.statePath) writeFileSync(opts?.statePath, JSON.stringify(state), "utf-8");
    },
    // #21：注入用户级 Claude 基准目录（同名 skill 检测；缺省走 process.env/主目录的路径组件测试不覆盖）
    ...(opts?.userClaudeDir ? { resolveUserClaudeDir: () => opts.userClaudeDir! } : {}),
  };
  return {
    invoke: (req: IpcRequest) => handleIpc(deps, req),
    onEvent: (h: (e: AdapterEvent) => void) => adapter.subscribe(h),
    onTerminalEvent: (h: (e: TerminalEvent) => void) => {
      terminalListeners.add(h);
      return () => {
        terminalListeners.delete(h);
      };
    },
    // 本套不驱动看板：tracker 订阅空实现（形状补齐，kanban 套见 KanbanWorkspace.test.tsx）
    onTrackerEvent: () => () => undefined,
  };
}

// 测试注入的演示 cwd（等价生产 AppInfo.fakeDemoCwd：Main 经 KANBAN_FAKE_DEMO_CWD/主目录注入，renderer 不内置任何路径）
const DEMO_CWD = join(tmpdir(), "kb-fake-demo");

/** 挂载工作区（含真实 useProjects host）并暴露 controller（供测试直接驱动动作） */
function mount(transport?: ChatTransport, opts?: { configPath?: string | null }) {
  const clock = new VirtualClock();
  const adapter = new FakeAdapter({ clock });
  const tr = transport ?? makeTransport(adapter);
  const holder: { controller?: ChatController } = {};
  const onController = (c: ChatController): void => {
    holder.controller = c;
  };
  function Host() {
    const projects = useProjects(tr);
    return (
      <ChatWorkspace
        transport={tr}
        projects={projects}
        demoCwd={DEMO_CWD}
        onController={onController}
        configPath={opts?.configPath ?? null}
      />
    );
  }
  render(<Host />);
  const ctl = (): ChatController => {
    if (!holder.controller) throw new Error("controller 未就绪");
    return holder.controller;
  };
  return {
    clock,
    ctl,
    advance: () =>
      act(() => {
        clock.runToIdle();
      }),
    /** 冲刷微任务链（invoke → adapter → store → 重渲染） */
    flush: async () =>
      act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      }),
  };
}

/** 输入并发送一条消息（草稿面板与会话 composer 同款 placeholder：首条消息即草稿提交） */
function send(text: string): void {
  const box = screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…");
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "发送 ➤" }));
}

/** #59 经草稿建立会话：打开草稿 → 输入首条消息 → 提交（原 createSession 直建的草稿语义等价物） */
async function createViaDraft(ctl: ChatController, cli: CliKind, opts?: OpenDraftOptions, text = "默认演示"): Promise<void> {
  ctl.openDraft(cli, opts);
  ctl.store.updateDraft({ input: text });
  await ctl.submitDraft();
}

/** #59 点项目行「＋」菜单选 CLI 后在草稿面板发首条消息（草稿 → 会话出现在侧栏） */
async function createViaMenu(cliLabel = "Claude", text = "默认演示"): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "＋" }));
  fireEvent.click(screen.getByText(cliLabel));
  await act(async () => {
    send(text);
  });
  await screen.findByText(`新会话 · ${cliLabel}`);
}

describe("聊天区（原型一致项 5/6/7）", () => {
  it("启动打开演示草稿（#59）：中央区草稿面板可交互，侧栏无会话行（空会话永不进历史）", async () => {
    const t = mount();
    await t.flush();
    expect(screen.getByTestId("draft-hint").textContent).toContain("演示会话 · Fake");
    expect(screen.getByTestId("draft-hint").textContent).toContain("发出第一条消息后才创建会话");
    expect(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "发送 ➤" })).toBeTruthy();
    // 不落库不进列表：无会话行、无「空闲」状态徽标（会话尚未创建）
    expect(screen.queryAllByTestId("session-row")).toHaveLength(0);
    expect(screen.queryByText("空闲")).toBeNull();
  });

  it("默认演示：用户回显 + 助手全文 + 工具卡完成（名称/参数/时长/输出）", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("把 ipc-schema 的类型拆成独立文件");
    });
    t.advance();
    expect(screen.getByText("把 ipc-schema 的类型拆成独立文件")).toBeTruthy();
    expect(screen.getByText("好的，我先跑一遍现有测试确认基线，然后开始拆分。")).toBeTruthy();
    expect(
      screen.getByText("基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。"),
    ).toBeTruthy();
    // 工具卡：工具名 + 参数摘要 + 终态时长 + 输出
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getAllByText(/pnpm vitest run --filter ipc-schema/).length).toBeGreaterThanOrEqual(2); // 卡头参数 + 输出行
    expect(screen.getByText("完成 · 3.6s")).toBeTruthy();
    expect(screen.getByText(/Tests\s+13 passed/)).toBeTruthy();
  });

  it("流式中：光标可见、输入禁用、发送钮替换为「⏹ 停止输出」；完成后恢复", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("默认演示");
    });
    act(() => {
      t.clock.advance(700); // 过 600ms 等待后进入流式
    });
    expect(screen.getByText("▍")).toBeTruthy();
    expect(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "⏹ 停止输出" })).toBeTruthy();
    t.advance();
    expect(screen.queryByText("▍")).toBeNull();
    expect(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…")).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "发送 ➤" })).toBeTruthy();
    expect(screen.getByText("空闲")).toBeTruthy();
  });

  it("取消：停止后显示「本轮已取消」提示 + 状态已中断；可继续发消息（一致项 7）", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("默认演示");
    });
    act(() => {
      t.clock.advance(700);
    });
    fireEvent.click(screen.getByRole("button", { name: "⏹ 停止输出" }));
    expect(await screen.findByText("— 本轮已取消，会话保留，可继续发消息 —")).toBeTruthy();
    expect(screen.getByText("已中断")).toBeTruthy();
    // 会话保留：可继续发消息
    await act(async () => {
      send("再来一轮");
    });
    t.advance();
    expect(screen.getByText("空闲")).toBeTruthy();
    expect(screen.getByText("再来一轮")).toBeTruthy();
  });

  it("审批卡：命令 + suggestions 文案 + 三键；拒绝 → 工具已拒绝 + 道歉文本 + 回到空闲", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("审批演示");
    });
    t.advance();
    expect(screen.getByText(/⚙ 需要审批：Edit packages\/ipc-schema\/src\/index\.ts/)).toBeTruthy();
    expect(screen.getByText("允许规则")).toBeTruthy();
    expect(screen.getByText(/Edit\(src\/\*\*\) 后续免询问/)).toBeTruthy();
    expect(screen.getByText(/packages\/ipc-schema\/\*\* 整目录/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "允许一次" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "总是允许" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeTruthy();
    expect(screen.getByText("等待审批")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    t.advance();
    expect(screen.getByText("已拒绝")).toBeTruthy();
    expect(screen.getByText("好的，我不改这个文件。需要我先列出计划再逐条确认吗？")).toBeTruthy();
    expect(screen.getByText("空闲")).toBeTruthy();
  });

  it("审批：允许一次 → 「仅本次允许」且第二个审批仍会询问；再允许后完成", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("审批演示");
    });
    t.advance();
    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    t.advance();
    expect(screen.getByText(/仅本次允许/)).toBeTruthy();
    // 第二次审批再次出现（once 不记住规则）—— 决定即时改变后续输出（一致项 7）
    expect(screen.getByText(/⚙ 需要审批：Edit packages\/ipc-schema\/src\/session\/create\.ts/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "总是允许" }));
    t.advance();
    expect(screen.getByText("拆分完成，index.ts 的导出面保持不变，测试仍然全绿。")).toBeTruthy();
  });

  it("审批：总是允许 → 「记住规则」且第二个审批直接跳过", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("审批演示");
    });
    t.advance();
    fireEvent.click(screen.getByRole("button", { name: "总是允许" }));
    t.advance();
    expect(screen.getAllByText(/记住规则，后续同类不再询问/).length).toBeGreaterThanOrEqual(2); // 首个决定 + 第二个自动放行
    // 第二个审批不再询问：直接出现终文
    expect(screen.getByText("拆分完成，index.ts 的导出面保持不变，测试仍然全绿。")).toBeTruthy();
  });

  it("审批过期：5s 内展示审批卡，过期后卡片消失 + 过期文案（服务端终态演示）", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("过期演示");
    });
    act(() => {
      t.clock.advance(3000); // 到审批等待、未过期
    });
    expect(screen.getByText("rm -rf node_modules")).toBeTruthy(); // 工具卡参数（审批卡命令含 Bash 前缀）
    expect(screen.getByRole("button", { name: "允许一次" })).toBeTruthy();
    t.advance(); // 5000ms 过期触发
    expect(screen.queryByRole("button", { name: "允许一次" })).toBeNull();
    expect(screen.getByText(/审批已过期/)).toBeTruthy();
    expect(screen.getByText("已拒绝")).toBeTruthy();
  });

  it("错误演示（升级 #46）：ErrorBanner 卡呈现 CLI 进程异常退出（标题+原因+动作），不崩溃、可继续", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("错误演示");
    });
    t.advance();
    const card = screen.getByTestId("error-card");
    expect(card.textContent).toContain("CLI 进程异常退出");
    expect(card.textContent).toContain("Fake CLI 进程意外退出");
    expect(card.textContent).toContain("已产生的对话与文件修改不受影响");
    // 旧红字一行形态（居中 ⚠ 一行）不再存在：动作按钮在卡内
    expect(screen.getByRole("button", { name: "读取原生历史并恢复" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "知道了" })).toBeTruthy();
    expect(screen.getByText("空闲")).toBeTruthy();
    // 「知道了」关闭错误卡（仅隐藏，不影响会话）
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(screen.queryByTestId("error-card")).toBeNull();
  });

  it("composer（一致项 6）：权限 chip 三档切换（菜单含说明文案）+ 模型选择", async () => {
    const t = mount();
    await t.flush();
    expect(screen.getByText("⚡ 权限：自动 ▾")).toBeTruthy();
    fireEvent.click(screen.getByText("⚡ 权限：自动 ▾"));
    // 三档菜单 + 说明（原型文案硬约束）
    expect(screen.getByText("🔒 请求")).toBeTruthy();
    expect(screen.getByText("所有工具调用前弹出审批卡片")).toBeTruthy();
    expect(screen.getByText("⚡ 自动（推荐）")).toBeTruthy();
    expect(screen.getByText("安全操作放行，风险操作（写文件/命令）弹审批")).toBeTruthy();
    expect(screen.getByText("🔓 完全访问")).toBeTruthy();
    expect(screen.getByText("全部自动放行，不弹任何审批")).toBeTruthy();
    fireEvent.click(screen.getByText("🔒 请求"));
    expect(screen.getByText("🔒 权限：请求 ▾")).toBeTruthy();
    fireEvent.click(screen.getByText("🔒 权限：请求 ▾"));
    fireEvent.click(screen.getByText("🔓 完全访问"));
    expect(screen.getByText("🔓 权限：完全访问 ▾")).toBeTruthy();
    // 模型选择
    const model = screen.getByRole("combobox");
    expect((model as HTMLSelectElement).value).toBe("默认模型");
    fireEvent.change(model, { target: { value: "gpt-5.6-luna" } });
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("gpt-5.6-luna");
  });

  it("composer 模型选择：选定值随草稿提交下发（firstMessage 携带），默认模型占位不下发", async () => {
    const seen: IpcRequest[] = [];
    const base = makeTransport(new FakeAdapter({ clock: new VirtualClock() }));
    const spy: ChatTransport = { ...base, invoke: (req) => { seen.push(req); return base.invoke(req); } };
    const t = mount(spy);
    await t.flush();
    const creates = () => seen.filter((r) => r.channel === "session:create") as Array<IpcRequest & { model?: string; title?: string; firstMessage?: string }>;
    // boot 演示草稿发首条消息：默认模型为占位值不下发（后端按各 CLI 探测链自选）；首条消息随 create 携带
    await act(async () => {
      send("默认演示");
    });
    const boot = creates().find((r) => r.title === "演示会话 · Fake");
    expect(boot, "boot 演示草稿提交应发出 session:create").toBeTruthy();
    expect(boot!.model, "默认模型为占位值，不下发").toBeUndefined();
    expect(boot!.firstMessage).toBe("默认演示");

    // 选具体模型 → 再开草稿提交：继承选定值随 session:create 下发，且新会话 composer 回显该值
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "gpt-5.6-luna" } });
    await act(async () => {
      await createViaDraft(t.ctl(), "fake", { cwd: DEMO_CWD, title: "带模型的会话" });
    });
    const withModel = creates().find((r) => r.title === "带模型的会话");
    expect(withModel, "草稿提交应发出 session:create").toBeTruthy();
    expect(withModel!.model).toBe("gpt-5.6-luna");
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("gpt-5.6-luna");

    // 切回默认模型 → 再开草稿提交：占位值仍不下发
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "默认模型" } });
    await act(async () => {
      await createViaDraft(t.ctl(), "fake", { cwd: DEMO_CWD, title: "默认模型会话" });
    });
    const withoutModel = creates().find((r) => r.title === "默认模型会话");
    expect(withoutModel, "默认模型会话应发出 session:create").toBeTruthy();
    expect(withoutModel!.model).toBeUndefined();
  });

  it("composer：OpenCode 会话明示权限档位为 server 级（同项目共享）；其他 CLI 无此说明（spec B UI 明示）", async () => {
    const t = mount();
    await t.flush();
    expect(screen.queryByText(/OpenCode 权限档位为 server 级/)).toBeNull(); // boot 演示草稿（fake）不显示
    await act(async () => {
      send("默认演示"); // boot 演示草稿提交 → fake 会话（供稍后切回）
    });
    expect(screen.queryByText(/OpenCode 权限档位为 server 级/)).toBeNull(); // fake 会话也不显示
    await act(async () => {
      await createViaDraft(t.ctl(), "opencode", { cwd: DEMO_CWD, title: "演示会话 · OpenCode" });
    });
    expect(screen.getByText(/OpenCode 权限档位为 server 级（同项目下会话共享）；切换后新会话生效/)).toBeTruthy();
    // 切回 fake 会话：说明消失
    fireEvent.click(screen.getByText("演示会话 · Fake"));
    expect(screen.queryByText(/OpenCode 权限档位为 server 级/)).toBeNull();
  });

  it("切会话不中断（一致项 7）：会话 A 流式中切到 B，A 持续推进，切回 A 全文在", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("默认演示"); // A 开始流式
    });
    const aId = t.ctl().activeId;
    // A 流式中经草稿新建并切到 B（B 的首条也跑默认剧本，与 A 同文 → 用激活态区分视图）
    await act(async () => {
      await createViaDraft(t.ctl(), "fake");
    });
    const bId = t.ctl().activeId;
    expect(bId).toBeTruthy();
    expect(bId).not.toBe(aId);
    expect(screen.getByText("新会话 · Fake")).toBeTruthy();
    t.advance(); // A/B 都在后台完成
    expect(t.ctl().activeId).toBe(bId); // 当前视图仍是 B
    // 切回 A：全文在（流式未被切换打断）
    fireEvent.click(screen.getByText("演示会话 · Fake"));
    expect(
      screen.getByText("基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。"),
    ).toBeTruthy();
  });

  it("打开草稿（#59）：不落库、不进侧栏；发出首条消息后行出现、草稿消失并激活", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      t.ctl().openDraft("fake", { cwd: DEMO_CWD });
    });
    // 草稿就位：中央区草稿面板，侧栏无会话行
    expect(screen.getByTestId("draft-hint").textContent).toContain("新会话 · Fake");
    expect(screen.queryAllByTestId("session-row")).toHaveLength(0);
    // 发出首条消息：经创建链落库，侧栏新增一行并激活，草稿面板消失
    await act(async () => {
      send("默认演示");
    });
    expect(screen.getByText("新会话 · Fake")).toBeTruthy();
    expect(screen.queryByTestId("draft-hint")).toBeNull();
    expect(t.ctl().draft).toBeNull();
  });

  it("#58 归档：会话行 hover「归档」→ Main 编排（中断+终止+写标记）→ 侧栏行移除", async () => {
    const t = mount();
    await t.flush();
    // #59：boot 演示草稿先发首条消息建立会话（行出现后才可 hover 归档）
    await act(async () => {
      send("默认演示");
    });
    expect(screen.getByText("演示会话 · Fake")).toBeTruthy();
    fireEvent.click(screen.getByTitle("归档（移出默认列表，可在设置找回）"));
    await t.flush();
    expect(screen.queryByText("演示会话 · Fake")).toBeNull(); // 行移出默认列表（全无则空态）
  });

  it("#62 删除：hover「删除」→ 二次确认 → Main 编排（unlink+终止+删记录）→ 侧栏行移除（唯一会话删除后空态）", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("默认演示"); // #59：boot 演示草稿先发首条消息建立会话（行出现后才可 hover 删除）
    });
    await t.flush();
    expect(screen.getByText("演示会话 · Fake")).toBeTruthy();
    fireEvent.click(screen.getAllByTitle("删除（终止进程并移除会话记录，不可撤销）")[0]);
    expect(screen.getByTestId("delete-session-dialog")).toBeTruthy(); // 先弹二次确认
    fireEvent.click(screen.getByTestId("delete-session-confirm"));
    await t.flush();
    expect(screen.queryByText("演示会话 · Fake")).toBeNull(); // 行移除（记录已删，唯一会话 → 空态）
    expect(screen.getAllByText("暂无会话").length).toBeGreaterThanOrEqual(1); // 侧栏结构化分组空态
    expect(t.ctl().activeId).toBeNull(); // 激活切空态
  });

  it("#62 删除激活会话：切到排序中的相邻会话（上一条档；下一条/空态档由 chat-store removeSession 三态覆盖）", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("默认演示"); // #59：boot 演示草稿先成会话（作为删除后切换的相邻目标）
    });
    await t.flush();
    await act(async () => {
      await createViaDraft(t.ctl(), "fake"); // #59：再经草稿建第二个会话，登记为激活（排序最前，演示会话在后）
    });
    await t.flush();
    const deleted = t.ctl().activeId;
    expect(deleted).toBeTruthy();
    await act(async () => {
      await t.ctl().deleteSession(deleted!);
    });
    await t.flush();
    expect(t.ctl().activeId).not.toBe(deleted);
    expect(screen.getByText("演示会话 · Fake")).toBeTruthy(); // 激活切到相邻（上一条）会话，行保留
  });

  it("#62 删除失败（IPC 错误）：行保留并在会话上呈现错误（可重试）", async () => {
    // 桩 transport：session:create 成功、session:delete 返回错误（模拟解关联失败中止）
    const stub: ChatTransport = {
      invoke: async (req: IpcRequest): Promise<IpcResult> => {
        if (req.channel === "session:create") {
          return { ok: true, sessionId: "s-1", cli: "fake", title: "演示会话 · Fake" };
        }
        if (req.channel === "session:delete") {
          return { ok: false, error: { code: "E_INTERNAL", message: "sqlite 写入失败（注入）" } };
        }
        return { ok: true };
      },
      onEvent: () => () => undefined,
      onTerminalEvent: () => () => undefined,
      onTrackerEvent: () => () => undefined,
    };
    const t = mount(stub);
    await t.flush();
    await act(async () => {
      send("默认演示"); // #59：boot 演示草稿经 stub 的 session:create（含 firstMessage 原子链）成会话
    });
    await t.flush();
    expect(screen.getByText("演示会话 · Fake")).toBeTruthy();
    fireEvent.click(screen.getAllByTitle("删除（终止进程并移除会话记录，不可撤销）")[0]);
    fireEvent.click(screen.getByTestId("delete-session-confirm"));
    await t.flush();
    expect(screen.getByText("演示会话 · Fake")).toBeTruthy(); // 失败中止：行保留
    expect(await screen.findByText(/sqlite 写入失败/)).toBeTruthy(); // 错误在会话上呈现
  });

  it("真实 CLI 无显式 cwd：拒绝打开草稿（不得以任何隐式演示目录创建真实会话，code-review 硬违规回归）", async () => {
    const t = mount();
    await t.flush();
    const before = t.ctl().sessions.length;
    await act(async () => {
      t.ctl().openDraft("claude");
    });
    await t.flush();
    expect(t.ctl().sessions.length).toBe(before);
    expect(t.ctl().draft?.cli).toBe("fake"); // boot 演示草稿保留，未被 claude 草稿替换（不以隐式路径创建）
  });

  it("Fake 无显式 cwd：用注入的演示目录创建（cwd 来自注入而非 renderer 内置路径）", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      await createViaDraft(t.ctl(), "fake");
    });
    await t.flush();
    const created = t.ctl().sessions.filter((s) => s.title === "新会话 · Fake");
    expect(created).toHaveLength(1);
    expect(created[0]?.cwd).toBe(DEMO_CWD);
  });

  it("IPC 错误结果展示：发送失败（错误码）在聊天区显示错误提示", async () => {
    // 桩 transport：session:create 成功、send 返回错误（模拟 Main 校验拒绝/会话失效）
    let seq = 0;
    const stub: ChatTransport = {
      invoke: async (req: IpcRequest): Promise<IpcResult> => {
        if (req.channel === "session:create") {
          seq += 1;
          return { ok: true, sessionId: `s-${seq}`, cli: "fake", title: "演示会话 · Fake" };
        }
        return { ok: false, error: { code: "E_SESSION_NOT_FOUND", message: "会话不存在：s-1" } };
      },
      onEvent: () => () => undefined,
      onTerminalEvent: () => () => undefined,
      onTrackerEvent: () => () => undefined,
    };
    const t = mount(stub);
    await t.flush();
    await act(async () => {
      send("任何消息"); // 首条 = 草稿提交（session:create+firstMessage，stub 返回 ok）
    });
    await act(async () => {
      send("任何消息"); // 第二条走 session:send → stub 返回错误
    });
    expect(await screen.findByText(/会话不存在/)).toBeTruthy();
  });
});

describe("项目注册与会话恢复（#7 全链，除 Electron dialog）", () => {
  let tmpRoot = "";

  afterEach(() => {
    cleanup();
    for (const db of openDbs.splice(0)) db.close();
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = "";
    }
  });

  /** 临时项目目录（.git 目录=主仓库 fixture）+ 固定返回它的 pick + db/状态文件路径 */
  function makeProjectFixture(): { projDir: string; dbPath: string; statePath: string; transport: ChatTransport } {
    // realpath 归一：CI 的 TEMP 可能是 8.3 短名（RUNNER~1），夹具须与 canonicalizePath 同形态
    tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "kb-ws-projects-")));
    const projDir = join(tmpRoot, "demo-repo");
    mkdirSync(join(projDir, ".git"), { recursive: true });
    const dbPath = join(tmpRoot, "state.db");
    const statePath = join(tmpRoot, "app-state.json");
    const adapter = new FakeAdapter({ clock: new VirtualClock() });
    return { projDir, dbPath, statePath, transport: makeTransport(adapter, { dbPath, statePath, pick: async () => projDir }) };
  }

  it("注册项目 → 「＋」菜单新建 Claude 会话（挂项目 + 主仓库徽标）→ 重启恢复（项目/会话/当前项目/断开态）", async () => {
    const { projDir, dbPath, statePath, transport } = makeProjectFixture();

    // 第一次启动：空态引导 → 注册 → 项目行出现（boot 演示会话先就位，注册后被当前项目过滤隐藏）
    const t1 = mount(transport);
    await t1.flush();
    expect(screen.getByText("演示会话 · Fake")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "＋ 注册本地目录…" }));
    await t1.flush();
    expect(await screen.findByText("demo-repo")).toBeTruthy();

    // 「＋」菜单选 Claude 打开草稿（一致项 2/3：菜单四项入口 + CLI 色点）；发出首条消息才建会话（#59）
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByText("Claude"));
    await t1.flush();
    expect(screen.getByTestId("draft-hint").textContent).toContain("新会话 · Claude");
    expect(screen.queryAllByTestId("session-row")).toHaveLength(0); // 草稿不进侧栏
    await act(async () => {
      send("首条消息");
    });
    expect(await screen.findByText("新会话 · Claude")).toBeTruthy();
    expect(screen.getByTitle(`工作在主仓库（${projDir}）`)).toBeTruthy();
    // 当前项目过滤：boot 演示会话（无项目）不显示
    expect(screen.queryByText("演示会话 · Fake")).toBeNull();

    // 第二次启动（同一 db/状态文件）：项目、当前项目与会话恢复，会话为断开态
    cleanup();
    const adapter2 = new FakeAdapter({ clock: new VirtualClock() });
    const transport2 = makeTransport(adapter2, { dbPath, statePath, pick: async () => null });
    const t2 = mount(transport2);
    await t2.flush();
    expect(await screen.findByText("demo-repo")).toBeTruthy();
    expect(await screen.findByText("新会话 · Claude")).toBeTruthy();
    expect(screen.getByText("已断开")).toBeTruthy();
    // 断开会话视图提示（#42：顶部恢复引导条，含会话名与「缓存消息不替代原生历史」说明）
    fireEvent.click(screen.getByText("新会话 · Claude"));
    const banner1 = screen.getByTestId("resume-banner");
    expect(banner1.textContent).toContain("新会话 · Claude");
    expect(banner1.textContent).toContain("缓存消息不替代原生历史");
    // boot 演示会话不再创建（已有项目）
    expect(screen.queryByText("演示会话 · Fake")).toBeNull();
    void t2;
  });
});

describe("PTY 终端链路（#12：mock PTY 驱动 TerminalPanel 与多路复用路由）", () => {
  let tmpRoot = "";

  afterEach(() => {
    cleanup();
    for (const db of openDbs.splice(0)) db.close();
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = "";
    }
  });

  function makePtyFixture() {
    tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "kb-ws-pty-")));
    const projDir = join(tmpRoot, "demo-repo");
    mkdirSync(join(projDir, ".git"), { recursive: true });
    const dbPath = join(tmpRoot, "state.db");
    const statePath = join(tmpRoot, "app-state.json");
    const adapter = new FakeAdapter({ clock: new VirtualClock() });
    return { projDir, dbPath, transport: makeTransport(adapter, { dbPath, statePath, pick: async () => projDir }) };
  }

  /** 注册项目并挂载工作区（返回 flush） */
  async function boot(transport: ChatTransport) {
    const t = mount(transport);
    await t.flush();
    fireEvent.click(screen.getByRole("button", { name: "＋ 注册" }));
    await t.flush();
    await screen.findByText("demo-repo");
    return t;
  }

  /** 等待标题出现（侧栏行与终端面板头同名，断言取全部命中，点击取首项=侧栏行） */
  const findTitle = (title: string) => screen.findAllByText(title);

  /** 在终端面板键入文本（xterm 隐藏 textarea 的 keyDown → onData；#60 草稿首输入触发创建） */
  function typeInXterm(text: string): void {
    const textarea = document.querySelector(".xterm-helper-textarea");
    if (!textarea) throw new Error("xterm textarea 未挂载");
    for (const ch of text) fireEvent.keyDown(textarea, { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.charCodeAt(0) });
  }

  /** 包一层 invoke 记录（断言 terminal:create/write 请求序） */
  function recordInvoke(transport: ChatTransport): { transport: ChatTransport; calls: IpcRequest[] } {
    const calls: IpcRequest[] = [];
    const base = transport.invoke;
    const wrapped: ChatTransport = { ...transport, invoke: (req) => { calls.push(req); return base(req); } };
    return { transport: wrapped, calls };
  }

  it("「＋」→ PTY 终端：先开草稿（无会话行、无创建请求、面板可交互）；首输入触发创建 → 会话行 + 标题回写；后续输入直写通道", async () => {
    const fixture = makePtyFixture();
    const { transport, calls } = recordInvoke(fixture.transport);
    const t = await boot(transport);

    // 「＋」菜单点 PTY 项：中央出现终端草稿（提示 + xterm 挂起），侧栏 PTY 分组仍为空态
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByRole("button", { name: /PTY 终端/ }));
    await t.flush();
    expect(screen.getByText(/终端草稿 · 尚未启动进程/)).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".xterm")).toBeTruthy());
    expect(screen.getByText("暂无终端会话")).toBeTruthy();
    expect(calls.filter((c) => c.channel === "terminal:create")).toHaveLength(0); // 不落库不起进程

    // 首输入触发创建：请求携带渲染端预生成 uuid id + 首输入缓冲；成功后会话行出现、草稿提示消失
    typeInXterm("a");
    await t.flush();
    const creates = calls.filter((c) => c.channel === "terminal:create");
    expect(creates).toHaveLength(1);
    if (creates[0].channel !== "terminal:create") throw new Error("非 create 请求");
    expect(creates[0].terminalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(creates[0].firstInput).toBe("a");
    expect(creates[0].cwd).toBe(fixture.projDir);
    expect((await findTitle("终端 · pwsh")).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/终端草稿 · 尚未启动进程/)).toBeNull();
    expect(screen.queryByText("暂无终端会话")).toBeNull();
    expect(screen.getByText("空闲")).toBeTruthy();

    // 创建后的输入直写 terminal:write（不再进草稿缓冲、不再触发创建）
    typeInXterm("b");
    await t.flush();
    expect(calls.filter((c) => c.channel === "terminal:create")).toHaveLength(1);
    const writes = calls.filter((c) => c.channel === "terminal:write");
    expect(writes).toHaveLength(1);
    if (writes[0].channel !== "terminal:write") throw new Error("非 write 请求");
    expect(writes[0].data).toBe("b");

    // 切到结构化会话（#59 草稿：发首条消息建 Claude）再切回：面板保留（同一持久元素重新挂入，进程未停）
    await createViaMenu("Claude");
    expect(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…")).toBeTruthy();
    expect(document.querySelector(".xterm")).toBeNull();
    fireEvent.click(screen.getAllByText("终端 · pwsh")[0]);
    await waitFor(() => expect(document.querySelector(".xterm")).toBeTruthy());
  });

  it("草稿被切换动作丢弃（不弹确认无残留）：点「＋」建 Claude 会话即弃草稿，无创建请求", async () => {
    const { transport, calls } = recordInvoke(makePtyFixture().transport);
    const t = await boot(transport);

    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByRole("button", { name: /PTY 终端/ }));
    await t.flush();
    expect(screen.getByText(/终端草稿 · 尚未启动进程/)).toBeTruthy();

    // 点「＋」建结构化会话 = 切换焦点：草稿静默丢弃（提示消失、xterm 卸载、无 terminal:create）
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByText("Claude"));
    await t.flush();
    await screen.findByText("新会话 · Claude");
    expect(screen.queryByText(/终端草稿 · 尚未启动进程/)).toBeNull();
    expect(document.querySelector(".xterm")).toBeNull();
    expect(calls.filter((c) => c.channel === "terminal:create")).toHaveLength(0);
  });

  it("结构化草稿打开时点「＋」→ PTY 终端：PTY 草稿替换结构化草稿（全局仅一个，双向替换）", async () => {
    const { transport } = recordInvoke(makePtyFixture().transport);
    const t = await boot(transport);

    // 先开结构化草稿（点菜单 Claude，不发首条消息）
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByText("Claude"));
    await t.flush();
    expect(screen.getByTestId("draft-hint")).toBeTruthy();

    // 再点「＋」→ PTY 终端：结构化草稿被静默替换（DraftPane 让位终端草稿；#65 整机验收发现反向替换缺失）
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByRole("button", { name: /PTY 终端/ }));
    await t.flush();
    expect(screen.getByText(/终端草稿 · 尚未启动进程/)).toBeTruthy();
    expect(screen.queryByTestId("draft-hint")).toBeNull();
  });

  it("再点「＋」→ PTY 终端：替换已有 PTY 草稿并显示明确提示（与结构化草稿同款替换文案，Story 4）", async () => {
    const { transport } = recordInvoke(makePtyFixture().transport);
    const t = await boot(transport);

    // 首开 PTY 草稿：无替换提示
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByRole("button", { name: /PTY 终端/ }));
    await t.flush();
    expect(screen.getByText(/终端草稿 · 尚未启动进程/)).toBeTruthy();
    expect(screen.queryByText(/已替换上一个草稿/)).toBeNull();

    // 再点「＋」→ PTY 终端：草稿被替换，提示行给出与结构化草稿（DraftPane）同款的明确反馈
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByRole("button", { name: /PTY 终端/ }));
    await t.flush();
    expect(screen.getByText(/终端草稿 · 尚未启动进程/)).toBeTruthy();
    expect(screen.getByText(/已替换上一个草稿：全局仅一个/)).toBeTruthy();
  });

  it("切换项目丢弃 PTY 草稿（register 成功自动切项目路径同样覆盖）：提示消失、xterm 卸载、无创建请求（Story 5）", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-ws-pty-proj-"));
    const projA = join(tmpRoot, "proj-a");
    const projB = join(tmpRoot, "proj-b");
    mkdirSync(join(projA, ".git"), { recursive: true });
    mkdirSync(join(projB, ".git"), { recursive: true });
    const dirs = [projA, projB];
    const adapter = new FakeAdapter({ clock: new VirtualClock() });
    const base = makeTransport(adapter, { dbPath: join(tmpRoot, "state.db"), pick: async () => dirs.shift() ?? null });
    const { transport, calls } = recordInvoke(base);
    const t = mount(transport);
    await t.flush();

    // 注册项目 A → 开 PTY 草稿（不输入：无创建请求、无会话行）
    fireEvent.click(screen.getByRole("button", { name: "＋ 注册本地目录…" }));
    await t.flush();
    expect(await screen.findByText("proj-a")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByRole("button", { name: /PTY 终端/ }));
    await t.flush();
    expect(screen.getByText(/终端草稿 · 尚未启动进程/)).toBeTruthy();

    // 注册项目 B（成功后 Main 自动切到 B，不经侧栏点击路径）→ PTY 草稿被丢弃
    fireEvent.click(screen.getByRole("button", { name: "＋ 注册" }));
    await t.flush();
    expect(await screen.findByText("proj-b")).toBeTruthy();
    expect(screen.queryByText(/终端草稿 · 尚未启动进程/)).toBeNull();
    expect(document.querySelector(".xterm")).toBeNull();
    expect(calls.filter((c) => c.channel === "terminal:create")).toHaveLength(0);
  });

  it("创建失败：草稿保留 + 错误提示 + 缓冲保留；再输入合并缓冲重试成功入库", async () => {
    const fixture = makePtyFixture();
    const calls: IpcRequest[] = [];
    const base = fixture.transport.invoke;
    let failCreate = true;
    const transport: ChatTransport = {
      ...fixture.transport,
      invoke: (req) => {
        calls.push(req);
        if (req.channel === "terminal:create" && failCreate) {
          failCreate = false;
          return Promise.resolve({ ok: false, error: { code: "E_INTERNAL", message: "启动失败：spawn boom" } });
        }
        return base(req);
      },
    };
    const t = await boot(transport);

    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByRole("button", { name: /PTY 终端/ }));
    await t.flush();
    typeInXterm("ec");
    await t.flush();

    // 失败：草稿保留（提示仍在）、错误可见、侧栏仍无行；缓冲输入保留
    expect(screen.getByText(/终端草稿 · 尚未启动进程/)).toBeTruthy();
    expect(screen.getByText(/启动失败：spawn boom/)).toBeTruthy();
    expect(screen.getByText("暂无终端会话")).toBeTruthy();

    // 再输入触发重试：触发字符合并历史缓冲（ec+h=ech）随 create 重放；重试在途的「o」经 write 补写（顺序不丢）
    typeInXterm("ho");
    await t.flush();
    const creates = calls.filter((c) => c.channel === "terminal:create");
    expect(creates).toHaveLength(2);
    if (creates[1].channel !== "terminal:create") throw new Error("非 create 请求");
    expect(creates[1].firstInput).toBe("ech");
    const writes = calls.filter((c) => c.channel === "terminal:write");
    expect(writes.map((w) => (w.channel === "terminal:write" ? w.data : ""))).toEqual(["o"]);
    expect((await findTitle("终端 · pwsh")).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/启动失败：spawn boom/)).toBeNull();
  });

  it("停止终端：exit 事件 → 状态已断开；重启恢复为断开态条目（进程不在）", async () => {
    const { dbPath, transport } = makePtyFixture();
    const t = await boot(transport);

    // 经草稿首输入建真实终端（停止按钮的既有行为回归）
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByRole("button", { name: /PTY 终端/ }));
    await t.flush();
    typeInXterm("a");
    await findTitle("终端 · pwsh");
    await waitFor(() => expect(document.querySelector(".xterm")).toBeTruthy());

    // 停止按钮（显式终止唯一入口）→ mock PTY exit 事件 → 会话状态已断开
    fireEvent.click(screen.getByTitle("停止终端（终止进程，保留会话记录）"));
    await screen.findByText("已断开");

    // 重启（同 db/状态文件）：PTY 会话恢复为断开态条目（进程不在，可重新新建）
    cleanup();
    const adapter2 = new FakeAdapter({ clock: new VirtualClock() });
    const transport2 = makeTransport(adapter2, { dbPath, statePath: join(tmpRoot, "app-state.json"), pick: async () => null });
    const t2 = mount(transport2);
    await t2.flush();
    expect((await findTitle("终端 · pwsh")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("已断开")).toBeTruthy();
    fireEvent.click(screen.getAllByText("终端 · pwsh")[0]);
    expect(screen.getByText(/该终端进程已结束/)).toBeTruthy();
  });
});

describe("断开会话「读取原生历史并恢复」（#9 / #42 顶部恢复引导条三态）", () => {
  let tmpRoot = "";

  afterEach(() => {
    cleanup();
    for (const db of openDbs.splice(0)) db.close();
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = "";
    }
  });

  it("重启恢复为断开态 → 点「读取原生历史并恢复」→ readHistory 快照重建消息流 → resume 回 idle → 续聊无缝拼接", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-ws-resume-"));
    const dbPath = join(tmpRoot, "state.db");

    // 第一次运行：boot 演示会话跑一个完整 turn（事件日志留在 adapter 内存 = Fake 的原生历史）
    const clock1 = new VirtualClock();
    const adapter = new FakeAdapter({ clock: clock1 });
    const t1 = mount(makeTransport(adapter, { dbPath }));
    await t1.flush();
    await act(async () => {
      send("拆类型"); // 首条消息 = 草稿提交（创建+落库+发送原子链）
    });
    act(() => {
      clock1.runToIdle();
    });
    expect(screen.getByText("好的，我先跑一遍现有测试确认基线，然后开始拆分。")).toBeTruthy();

    // 「重启」：UI/store 重建、会话行来自 DB（断开态）；adapter 保留（Fake 的 CLI 进程未退出场景）
    cleanup();
    const t2 = mount(makeTransport(adapter, { dbPath })); // mount 的内部 clock 与本 adapter 无关；驱动用 clock1
    await t2.flush();
    expect(await screen.findByText("已断开")).toBeTruthy();
    // 激活该会话后聊天区顶部呈现恢复引导条（#42：待恢复态，恢复登记不自动激活；底部弱入口已移除）
    fireEvent.click(screen.getByText("演示会话 · Fake"));
    const banner = screen.getByTestId("resume-banner");
    expect(banner.textContent).toContain("演示会话 · Fake"); // 会话名进引导条
    expect(banner.textContent).toContain("缓存消息不替代原生历史");
    expect(screen.queryByText("好的，我先跑一遍现有测试确认基线，然后开始拆分。")).toBeNull(); // 缓存不替代原生历史：恢复前消息流为空

    // 恢复入口（顶部条主按钮，文案保留「读取原生历史并恢复」）：readHistory 快照重建 → resume 回 idle → banner 消失
    fireEvent.click(screen.getByRole("button", { name: "读取原生历史并恢复" }));
    await t2.flush();
    expect(screen.getByText("好的，我先跑一遍现有测试确认基线，然后开始拆分。")).toBeTruthy();
    expect(screen.getByText("基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。")).toBeTruthy();
    expect(screen.queryByText("已断开")).toBeNull(); // resume 后实时 session_status(idle) 驱动状态
    expect(screen.getByText("空闲")).toBeTruthy();
    expect(screen.queryByTestId("resume-banner")).toBeNull(); // 恢复成功收敛：banner 消失

    // 续聊：快照后新事件无缝续上（恢复的会话可继续对话；默认脚本同文案 → 用 getAllByText 计数两次出现）
    send("第二 turn");
    act(() => {
      clock1.runToIdle();
    });
    expect(screen.getAllByText("好的，我先跑一遍现有测试确认基线，然后开始拆分。")).toHaveLength(2); // 快照 1 次 + 实时 1 次
    expect(screen.getAllByText("基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。")).toHaveLength(2);
  });

  it("恢复失败 → 引导条失败态（IPC 错误原因/错误码 + 重试 + 复制详情）→ 重试走同一链成功收敛（#42）", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-ws-resume-fail-"));
    const dbPath = join(tmpRoot, "state.db");

    // 第一次运行跑一个完整 turn；重启时 adapter 保留但注入「首次 resume 失败」（FakeAdapter e2e 钩子）
    const clock1 = new VirtualClock();
    const adapter = new FakeAdapter({ clock: clock1, failResumeFirst: 1 });
    const t1 = mount(makeTransport(adapter, { dbPath }));
    await t1.flush();
    await act(async () => {
      send("拆类型");
    });
    act(() => {
      clock1.runToIdle();
    });
    cleanup();
    const t2 = mount(makeTransport(adapter, { dbPath }));
    await t2.flush();
    expect(await screen.findByText("已断开")).toBeTruthy();
    fireEvent.click(screen.getByText("演示会话 · Fake"));

    // 恢复：readHistory 成功（快照重建）→ resume 注入失败 → 引导条失败态，会话仍断开
    fireEvent.click(screen.getByRole("button", { name: "读取原生历史并恢复" }));
    await t2.flush();
    const failed = screen.getByTestId("resume-banner");
    expect(failed.textContent).toContain("恢复失败");
    expect(failed.textContent).toContain("注入的恢复失败");
    expect(failed.textContent).toContain("E_INTERNAL");
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制错误详情" })).toBeTruthy();
    expect(screen.getByText("已断开")).toBeTruthy();
    expect(screen.getByText("好的，我先跑一遍现有测试确认基线，然后开始拆分。")).toBeTruthy(); // readHistory 已重建消息流

    // 重试（同一 resumeSession 链）→ 成功收敛：banner 消失、状态徽标回 idle
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await t2.flush();
    expect(screen.queryByTestId("resume-banner")).toBeNull();
    expect(screen.getByText("空闲")).toBeTruthy();
  });
});

describe("主仓库并行冲突提示条（spec I-4/#13）", () => {
  let tmpRoot = "";

  afterEach(() => {
    cleanup();
    for (const db of openDbs.splice(0)) db.close();
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = "";
    }
  });

  it("同目录 ≥2 会话运行中：聊天区顶部提示条出现（列出会话名/计数）；完成后消失；仅提示不阻止（composer 仍可用）", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-ws-conflict-"));
    const projDir = join(tmpRoot, "demo-repo");
    mkdirSync(join(projDir, ".git"), { recursive: true });
    const clock = new VirtualClock(); // 持有时钟驱动完成态（VirtualClock 不自动推进 → send 后保持 running）
    const adapter = new FakeAdapter({ clock });
    const transport = makeTransport(adapter, { dbPath: join(tmpRoot, "state.db"), pick: async () => projDir });
    const t = mount(transport);
    await t.flush();

    // 注册项目 + 经草稿建两个 Claude 会话（同一主仓库目录）
    fireEvent.click(screen.getByRole("button", { name: "＋ 注册本地目录…" }));
    await t.flush();
    expect(await screen.findByText("demo-repo")).toBeTruthy();
    // 两个会话各以首条消息起一个 turn（VirtualClock 不自动推进 → 保持 running）
    await createViaMenu("Claude", "拆类型");
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getAllByText("Claude")[0]);
    await act(async () => {
      send("拆类型"); // 第二个会话的首条（草稿提交，起 turn 后保持 running）
    });
    expect((await screen.findAllByText("新会话 · Claude")).length).toBe(2);
    await t.flush();
    // 提示条出现：计数 2 + 会话名（同默认标题出现两次）
    const banner = await screen.findByTestId("conflict-banner");
    expect(banner.textContent).toContain("主仓库并行会话（2 个）");
    expect(banner.textContent).toContain("新会话 · Claude、新会话 · Claude");
    // 仅提示不阻止：composer 仍可用
    expect(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…")).toBeTruthy();

    // 完成：全部 idle → 提示条消失
    act(() => {
      clock.runToIdle();
    });
    await t.flush();
    expect(screen.queryByTestId("conflict-banner")).toBeNull();
  });
});

describe("Claude 同名 skill 提示条（#21 / 原型一致项 7：warn 样式、列冲突名、项目级优先生效说明、可关闭）", () => {
  let tmpRoot = "";

  afterEach(() => {
    cleanup();
    for (const db of openDbs.splice(0)) db.close();
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = "";
    }
  });

  /** 项目含 .claude/skills/design-feature（主仓库 fixture）；userSkills 决定用户级与项目的交集（空=无冲突） */
  function makeSkillConflictFixture(userSkills: string[]) {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-ws-skillconf-"));
    const projDir = join(tmpRoot, "demo-repo");
    mkdirSync(join(projDir, ".git"), { recursive: true });
    mkdirSync(join(projDir, ".claude", "skills", "design-feature"), { recursive: true });
    const userDir = join(tmpRoot, "user-claude");
    for (const n of userSkills) mkdirSync(join(userDir, "skills", n), { recursive: true });
    const clock = new VirtualClock();
    const adapter = new FakeAdapter({ clock });
    const transport = makeTransport(adapter, {
      dbPath: join(tmpRoot, "state.db"),
      pick: async () => projDir,
      userClaudeDir: userDir,
    });
    return { clock, transport };
  }

  /** 注册项目并挂载（返回驱动句柄） */
  async function boot(transport: ChatTransport) {
    const t = mount(transport);
    await t.flush();
    fireEvent.click(screen.getByRole("button", { name: "＋ 注册本地目录…" }));
    await t.flush();
    await screen.findByText("demo-repo");
    return t;
  }

  it("有冲突：Claude 会话顶部出现提示条（列冲突名 + 项目级优先生效 + 行为不稳定说明）；出现前（Fake 会话）不出现", async () => {
    const { transport } = makeSkillConflictFixture(["Design-Feature", "user-only"]);
    await boot(transport);
    expect(screen.queryByTestId("skill-conflict-banner")).toBeNull(); // 当前活跃为 boot 的 Fake 演示草稿：不提示

    await createViaMenu("Claude");
    const banner = await screen.findByTestId("skill-conflict-banner");
    expect(banner.textContent).toContain("检测到同名 skill");
    expect(banner.textContent).toContain("design-feature"); // 冲突名（项目侧命名）
    expect(banner.textContent).toContain("项目级将优先生效");
    expect(banner.textContent).toContain("同名可能使模型行为不稳定");
  });

  it("可关闭：点「知道了」提示条消失；关闭后会话正常使用（发消息照常回显与回复）", async () => {
    const { clock, transport } = makeSkillConflictFixture(["design-feature"]);
    const t = await boot(transport);
    // 首条消息即「继续工作」（建会话 + 起 turn 一步完成）
    await createViaMenu("Claude", "继续工作");
    expect(await screen.findByTestId("skill-conflict-banner")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    await t.flush();
    expect(screen.queryByTestId("skill-conflict-banner")).toBeNull(); // 关闭仅隐藏

    // 会话正常：turn 推进完成（本地回显 + Fake 全 turn 回复；非阻塞：关闭不影响会话）
    act(() => {
      clock.runToIdle();
    });
    expect(screen.getByText("继续工作")).toBeTruthy();
    expect(screen.getByText("好的，我先跑一遍现有测试确认基线，然后开始拆分。")).toBeTruthy();
    expect(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…")).toHaveProperty("disabled", false);
  });

  it("无冲突（用户级无同名）：Claude 会话不出现提示条", async () => {
    const { transport } = makeSkillConflictFixture(["user-only"]);
    await boot(transport);
    await createViaMenu("Claude");
    expect(screen.queryByTestId("skill-conflict-banner")).toBeNull();
  });

  it("非 claude 会话不提示：同目录 Codex 会话无提示条（§7-4 决策：仅 Claude 检测）", async () => {
    const { transport } = makeSkillConflictFixture(["design-feature"]);
    await boot(transport);
    await createViaMenu("Codex");
    expect(screen.queryByTestId("skill-conflict-banner")).toBeNull();
  });
});

describe("「＋」新建 cwd 解析（resolveSessionCwd：项目查不到不回退任何路径，code-review 硬违规回归）", () => {
  const proj: ProjectRow = { id: "p1", name: "repo", canonicalPath: "C:\\repo", status: "ok", createdAt: "2026-01-01T00:00:00Z" };

  it("项目在列表：返回 canonicalPath", () => {
    expect(resolveSessionCwd([proj], "p1", "claude", null)).toBe("C:\\repo");
    expect(resolveSessionCwd([proj], "p1", "pty", null)).toBe("C:\\repo");
  });

  it("项目查不到 + 真实 CLI/PTY：返回 null（不得回退演示目录或任何内置路径）", () => {
    expect(resolveSessionCwd([proj], "ghost", "claude", "C:\\demo")).toBeNull();
    expect(resolveSessionCwd([proj], "ghost", "codex", "C:\\demo")).toBeNull();
    expect(resolveSessionCwd([proj], "ghost", "pty", "C:\\demo")).toBeNull();
  });

  it("项目查不到 + Fake：回落注入的演示 cwd；未注入则 null", () => {
    expect(resolveSessionCwd([proj], "ghost", "fake", "C:\\demo")).toBe("C:\\demo");
    expect(resolveSessionCwd([proj], "ghost", "fake", null)).toBeNull();
  });
});

describe("草稿提交失败卡（#59：session:create+firstMessage 失败在草稿面板呈现，输入保留可重试；卡 3 信息结构沿 #46）", () => {
  /** spy transport：session:create 首次返回注入错误（之后透传真实链路）——驱动草稿失败卡 */
  function makeFailingTransport(fail: { code: ErrorCode; message: string }): ChatTransport {
    const base = makeTransport(new FakeAdapter({ clock: new VirtualClock() }));
    let failed = false;
    return {
      ...base,
      invoke: (req): Promise<IpcResult> => {
        if (req.channel === "session:create" && !failed) {
          failed = true;
          return Promise.resolve({ ok: false, error: { code: fail.code, message: fail.message } });
        }
        return base.invoke(req);
      },
    };
  }

  it("创建失败（E_SPAWN_NOT_FOUND）：失败卡信息结构（标题/指引/配置路径）+「重试发送」+「复制配置路径」+「知道了」；草稿与输入保留", async () => {
    const transport = makeFailingTransport({ code: "E_SPAWN_NOT_FOUND", message: "未找到 claude 可执行文件（已尝试：npm 全局；where）" });
    const t = mount(transport, { configPath: "C:\\UserData\\config.json" });
    await t.flush();
    await act(async () => {
      t.ctl().openDraft("claude", { cwd: DEMO_CWD });
    });
    await act(async () => {
      send("首条消息");
    });
    const card = screen.getByTestId("create-error-card");
    expect(card.textContent).toContain("找不到 CLI 程序（Claude）");
    expect(card.textContent).toContain("确认已安装并在 PATH 中");
    expect(card.textContent).toContain("C:\\UserData\\config.json");
    expect(screen.getByRole("button", { name: "重试发送" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制配置路径" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "知道了" })).toBeTruthy();
    // 失败保留：草稿还在、输入未清、无会话行
    expect(screen.getByTestId("draft-hint").textContent).toContain("新会话 · Claude");
    expect((screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…") as HTMLTextAreaElement).value).toBe("首条消息");
    expect(screen.queryAllByTestId("session-row")).toHaveLength(0);
    // 「知道了」仅清除错误（草稿与输入仍保留）
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(screen.queryByTestId("create-error-card")).toBeNull();
    expect(t.ctl().draft?.input).toBe("首条消息");
  });

  it("「重试发送」：重新执行创建+发送，成功后卡消失 + 会话登记 + 草稿丢弃", async () => {
    const transport = makeFailingTransport({ code: "E_SPAWN_NOT_FOUND", message: "未找到 claude 可执行文件" });
    const t = mount(transport, { configPath: "C:\\UserData\\config.json" });
    await t.flush();
    await act(async () => {
      t.ctl().openDraft("claude", { cwd: DEMO_CWD });
    });
    await act(async () => {
      send("要重试的首条");
    });
    expect(screen.getByTestId("create-error-card")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试发送" }));
    await t.flush();
    // 重试走真实链路成功：卡消失 + 新会话登记 + 草稿消失
    expect(screen.queryByTestId("create-error-card")).toBeNull();
    expect(screen.getByText("新会话 · Claude")).toBeTruthy();
    expect(screen.queryByTestId("draft-hint")).toBeNull();
  });

  it("非 spawn 提交失败：未知卡保留 code 与 message 原文 +「复制错误详情」", async () => {
    const transport = makeFailingTransport({ code: "E_INTERNAL", message: "thread/start 未返回 thread id（协议异常）" });
    const t = mount(transport);
    await t.flush();
    await act(async () => {
      t.ctl().openDraft("codex", { cwd: DEMO_CWD });
    });
    await act(async () => {
      send("首条");
    });
    const card = screen.getByTestId("create-error-card");
    expect(card.textContent).toContain("E_INTERNAL");
    expect(card.textContent).toContain("thread/start 未返回 thread id（协议异常）");
    expect(screen.getByRole("button", { name: "重试发送" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制错误详情" })).toBeTruthy();
  });

  it("提交失败留痕（#55 spec #52 G 节 / issue #69）：注入 sink 断言 error/chat 条目（cli/code/message/cwd）—— jsdom 不再静默 no-op", async () => {
    const entries: Array<{ level: string; scope: string; message: string; ctx?: Record<string, string | number | boolean> }> = [];
    const restore = setLogSinkForTest((level, scope, message, ctx) => entries.push({ level, scope, message, ctx }));
    try {
      const transport = makeFailingTransport({ code: "E_SPAWN_NOT_FOUND", message: "未找到 claude 可执行文件（已尝试：npm 全局；where）" });
      const t = mount(transport);
      await t.flush();
      await act(async () => {
        t.ctl().openDraft("claude", { cwd: DEMO_CWD });
      });
      await act(async () => {
        send("首条消息");
      });
      expect(screen.getByTestId("create-error-card")).toBeTruthy();
      expect(entries).toContainEqual({
        level: "error",
        scope: "chat",
        message: "草稿提交失败（创建+发送首条消息）",
        ctx: { cli: "claude", code: "E_SPAWN_NOT_FOUND", message: "未找到 claude 可执行文件（已尝试：npm 全局；where）", cwd: DEMO_CWD },
      });
    } finally {
      restore();
    }
  });
});

describe("会话内错误卡五类（#46：fake 脚本分支驱动 ChatPane → ErrorBanner）", () => {
  it("认证失效：claude 会话按 CLI 显示指引命令块 +「重试」重发最近消息 +「打开 PTY 终端」新建终端并切到终端视图", async () => {
    const t = mount(undefined, { configPath: "C:\\UserData\\config.json" });
    await t.flush();
    // 建 claude（Fake 链路）会话：cli 记录为 claude → 指引命令按 claude 定制
    // 首条消息即「认证演示」（建会话 + 触发认证剧本一步完成）
    await act(async () => {
      await createViaDraft(t.ctl(), "claude", { cwd: DEMO_CWD, title: "认证演示会话" }, "认证演示");
    });
    t.advance();
    const card = screen.getByTestId("error-card");
    expect(card.textContent).toContain("登录已失效（Claude）");
    expect(screen.getByTestId("auth-cmd").textContent).toContain("/login");
    // 「重试」= 重发最近一条用户消息（消息流出现第二条同文回显）
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await t.flush();
    t.advance();
    expect(screen.getAllByText("认证演示").length).toBeGreaterThanOrEqual(2);
    // 「打开 PTY 终端」= 在会话 cwd 打开终端草稿（#60：首输入才创建）→ 键入后切到终端视图并出会话行
    fireEvent.click(screen.getByRole("button", { name: "打开 PTY 终端" }));
    await t.flush();
    expect(screen.getByText(/终端草稿 · 尚未启动进程/)).toBeTruthy();
    const textarea = document.querySelector(".xterm-helper-textarea");
    if (!textarea) throw new Error("xterm textarea 未挂载");
    fireEvent.keyDown(textarea, { key: "a", code: "KeyA", keyCode: 97 });
    await t.flush();
    expect(screen.getAllByText(/终端 · /).length).toBeGreaterThanOrEqual(1);
  });

  it("协议断连：原因说明 + 按需重拉 server 说明 +「恢复会话」触发与恢复条同一 resumeSession 动作（D4）", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("断连演示");
    });
    t.advance();
    const card = screen.getByTestId("error-card");
    expect(card.textContent).toContain("连接中断");
    expect(card.textContent).toContain("恢复时将按需重新拉起 server");
    // 「恢复会话」= 同一 resume 动作：readHistory 快照重建（fake 事件溯源回放）→ lastError 清除 → 卡消失
    fireEvent.click(screen.getByRole("button", { name: "恢复会话" }));
    await t.flush();
    expect(screen.queryByTestId("error-card")).toBeNull();
  });

  it("未知错误：保留原始 code 与 message 原文 +「复制错误详情」", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("未知错误演示");
    });
    t.advance();
    const card = screen.getByTestId("error-card");
    expect(card.textContent).toContain("未知错误");
    expect(card.textContent).toContain("UNKNOWN");
    expect(card.textContent).toContain("某种未覆盖的错误形态（演示）");
    expect(screen.getByRole("button", { name: "复制错误详情" })).toBeTruthy();
  });
});

describe("结构化会话草稿创建（#59：点「＋」只开草稿，首条消息原子创建+发送；单草稿；切走即丢）", () => {
  let tmpRoot = "";

  afterEach(() => {
    cleanup();
    for (const db of openDbs.splice(0)) db.close();
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = "";
    }
  });

  /** 首次 sendTurn 抛错的自定义 FakeAdapter（驱动「创建成功但发送失败」全链：Main 回滚不留空会话） */
  class FailFirstSendAdapter extends FakeAdapter {
    private sendCalls = 0;
    override async sendTurn(input: SendTurnInput): Promise<void> {
      this.sendCalls += 1;
      if (this.sendCalls === 1) throw new AdapterError("E_INTERNAL", "发送失败（注入：首条消息发送失败）");
      return super.sendTurn(input);
    }
  }

  it("点「＋」选 CLI：只开草稿——无 session:create 请求（不落库、不起 CLI）、侧栏无新行、可输入可改权限/模型", async () => {
    const seen: IpcRequest[] = [];
    const base = makeTransport(new FakeAdapter({ clock: new VirtualClock() }));
    const spy: ChatTransport = { ...base, invoke: (req) => { seen.push(req); return base.invoke(req); } };
    const t = mount(spy);
    await t.flush();
    seen.length = 0; // 排除 bootstrap 的 project/session 拉取
    await act(async () => {
      t.ctl().openDraft("claude", { cwd: DEMO_CWD });
    });
    // 无任何创建请求；侧栏无行；草稿可交互（输入 + 权限/模型控件）
    expect(seen).toHaveLength(0);
    expect(screen.queryAllByTestId("session-row")).toHaveLength(0);
    expect((screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText("⚡ 权限：自动 ▾")).toBeTruthy();
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("默认模型");
    // 权限/模型在草稿上可改
    fireEvent.click(screen.getByText("⚡ 权限：自动 ▾"));
    fireEvent.click(screen.getByText("🔒 请求"));
    expect(screen.getByText("🔒 权限：请求 ▾")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "gpt-5.6-luna" } });
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("gpt-5.6-luna");
  });

  it("首条消息原子创建+发送：权限/模型/首条文本随 create 携带，消息送达（用户回显 + 助手回复）", async () => {
    const seen: IpcRequest[] = [];
    const clock = new VirtualClock();
    const base = makeTransport(new FakeAdapter({ clock }));
    const spy: ChatTransport = { ...base, invoke: (req) => { seen.push(req); return base.invoke(req); } };
    const t = mount(spy);
    await t.flush();
    seen.length = 0;
    await act(async () => {
      t.ctl().openDraft("claude", { cwd: DEMO_CWD });
    });
    // 权限改 ask、模型选具体值 → 随提交一并下发
    fireEvent.click(screen.getByText("⚡ 权限：自动 ▾"));
    fireEvent.click(screen.getByText("🔒 请求"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "gpt-5.6-luna" } });
    await act(async () => {
      send("带参数的首条");
    });
    const create = seen.find((r) => r.channel === "session:create") as
      | (IpcRequest & { permMode?: string; model?: string; firstMessage?: string })
      | undefined;
    expect(create).toBeTruthy();
    expect(create!.firstMessage).toBe("带参数的首条");
    expect(create!.permMode).toBe("ask");
    expect(create!.model).toBe("gpt-5.6-luna");
    // 消息送达：用户回显 + 助手回复（Fake 默认剧本）
    expect(screen.getByText("带参数的首条")).toBeTruthy();
    act(() => {
      clock.runToIdle();
    });
    expect(screen.getByText("好的，我先跑一遍现有测试确认基线，然后开始拆分。")).toBeTruthy();
  });

  it("创建成功但发送失败（全链注入）：不留空会话（DB 无记录）、失败卡明确报错、草稿与输入保留、重试成功后正常入库", async () => {
    const adapter = new FailFirstSendAdapter({ clock: new VirtualClock() });
    const transport = makeTransport(adapter);
    const t = mount(transport);
    await t.flush();
    await act(async () => {
      t.ctl().openDraft("claude", { cwd: DEMO_CWD });
    });
    await act(async () => {
      send("注定失败的首条");
    });
    // 失败卡（草稿面板中央区）+ 明确错误；草稿与输入保留
    const card = screen.getByTestId("create-error-card");
    expect(card.textContent).toContain("发送失败（注入：首条消息发送失败）");
    expect((screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…") as HTMLTextAreaElement).value).toBe("注定失败的首条");
    // 不留空会话：侧栏无行 + session:list（DB）为空（Main 已回滚删除记录 → 重启也不被恢复）
    expect(screen.queryAllByTestId("session-row")).toHaveLength(0);
    const list = await transport.invoke({ channel: "session:list" });
    expect(list.ok && list.sessions).toHaveLength(0);
    // 重试：同参数重新执行创建+发送 → 成功入库（DB 一行、侧栏一行、草稿丢弃）
    fireEvent.click(screen.getByRole("button", { name: "重试发送" }));
    await t.flush();
    expect(screen.queryByTestId("create-error-card")).toBeNull();
    expect(screen.getByText("新会话 · Claude")).toBeTruthy();
    expect(screen.queryByTestId("draft-hint")).toBeNull();
    const list2 = await transport.invoke({ channel: "session:list" });
    expect(list2.ok && list2.sessions).toHaveLength(1);
  });

  it("再点「＋」：替换现有草稿并显示明确提示；原输入不保留", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      t.ctl().openDraft("claude", { cwd: DEMO_CWD });
    });
    // 在草稿输入框写入未发送的内容
    fireEvent.change(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…"), { target: { value: "旧草稿的输入" } });
    await act(async () => {
      t.ctl().openDraft("codex", { cwd: DEMO_CWD });
    });
    expect(screen.getByTestId("draft-hint").textContent).toContain("新会话 · Codex");
    expect(screen.getByTestId("draft-hint").textContent).toContain("已替换上一个草稿");
    expect((screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…") as HTMLTextAreaElement).value).toBe(""); // 旧输入不保留
  });

  it("切会话丢弃草稿且不弹确认、输入不保留；草稿丢弃后中央区回到原会话", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("默认演示"); // boot 演示草稿提交 → fake 会话
    });
    const fakeId = t.ctl().activeId;
    await act(async () => {
      t.ctl().openDraft("claude", { cwd: DEMO_CWD });
    });
    fireEvent.change(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…"), { target: { value: "将被丢弃的输入" } });
    // 点侧栏会话行切换：草稿丢弃（无确认弹层）、输入消失、回到会话视图
    fireEvent.click(screen.getByText("演示会话 · Fake"));
    expect(t.ctl().draft).toBeNull();
    expect(screen.queryByTestId("draft-hint")).toBeNull();
    expect(t.ctl().activeId).toBe(fakeId);
  });

  it("切换项目丢弃草稿（不弹确认、输入不保留）", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-ws-draft-proj-"));
    const projA = join(tmpRoot, "proj-a");
    const projB = join(tmpRoot, "proj-b");
    mkdirSync(join(projA, ".git"), { recursive: true });
    mkdirSync(join(projB, ".git"), { recursive: true });
    const dirs = [projA, projB];
    const clock = new VirtualClock();
    const adapter = new FakeAdapter({ clock });
    const transport = makeTransport(adapter, { dbPath: join(tmpRoot, "state.db"), pick: async () => dirs.shift() ?? null });
    const t = mount(transport);
    await t.flush();
    // 注册项目 A（pick 首次返回 projA）→ 项目行出现
    fireEvent.click(screen.getByRole("button", { name: "＋ 注册本地目录…" }));
    await t.flush();
    expect(await screen.findByText("proj-a")).toBeTruthy();
    // 在 A 上开草稿并输入
    await act(async () => {
      t.ctl().openDraft("claude", { cwd: projA, projectId: "pa" });
    });
    fireEvent.change(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…"), { target: { value: "A 项目的草稿" } });
    expect(t.ctl().draft).toBeTruthy();
    // 注册 B（自动切到 B 项目）→ 草稿被丢弃
    fireEvent.click(screen.getByRole("button", { name: "＋ 注册" }));
    await t.flush();
    expect(await screen.findByText("proj-b")).toBeTruthy();
    expect(t.ctl().draft).toBeNull();
    expect(screen.queryByTestId("draft-hint")).toBeNull();
  });

  it("boot 演示草稿不落库：首启无 session:create、session:list 为空；发首条消息成会话；重启恢复为断开态", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-ws-draft-boot-"));
    const seen: IpcRequest[] = [];
    const dbPath = join(tmpRoot, "state.db");
    const base = makeTransport(new FakeAdapter({ clock: new VirtualClock() }), { dbPath });
    const spy: ChatTransport = { ...base, invoke: (req) => { seen.push(req); return base.invoke(req); } };
    const t = mount(spy);
    await t.flush();
    // 首启：boot 演示草稿打开但无任何 session:create（空会话永不进历史）
    expect(t.ctl().draft?.title).toBe("演示会话 · Fake");
    expect(seen.filter((r) => r.channel === "session:create")).toHaveLength(0);
    const empty = await spy.invoke({ channel: "session:list" });
    expect(empty.ok && empty.sessions).toHaveLength(0);
    // 发首条消息：草稿成会话（落库一行）
    await act(async () => {
      send("默认演示");
    });
    expect(seen.filter((r) => r.channel === "session:create")).toHaveLength(1);
    expect(screen.getByText("演示会话 · Fake")).toBeTruthy();
    // 重启（同 db）：该会话恢复为断开态行（产生过实际对话的会话重启可见，#57 US12）
    cleanup();
    const t2 = mount(makeTransport(new FakeAdapter({ clock: new VirtualClock() }), { dbPath }));
    await t2.flush();
    expect(await screen.findByText("演示会话 · Fake")).toBeTruthy();
    expect(screen.getByText("已断开")).toBeTruthy();
    void t2;
  });
});
