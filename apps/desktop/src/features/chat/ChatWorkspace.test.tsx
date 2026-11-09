// 用途：聊天区组件测试（spec Testing seam 4）—— FakeAdapter 事件流直连驱动真实组件：流式/工具卡/审批三键/取消/权限切换/切会话不中断/项目注册与重启恢复（对照原型一致项 2/3/5/6/7）
/// <reference types="node" /> <!-- 本文件用 node:fs/os/path 建持久化 fixture（重启恢复用例） -->
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent, IpcRequest, IpcResult, ProjectRow, TerminalEvent } from "@kanban/ipc-schema";
import { FakeAdapter, VirtualClock } from "@kanban/cli-host";
import { TrackerEngine } from "@kanban/tracker";
import { openDatabase } from "../../../electron/main/db";
import { handleIpc, type IpcDeps } from "../../../electron/main/ipc";
import { createPtyHost, type PtyLike, type PtyProcess } from "../../../electron/main/pty-host";
import { ProjectStore } from "../../../electron/main/project-store";
import { SessionStore } from "../../../electron/main/session-store";
import { ChatWorkspace } from "./ChatWorkspace";
import type { ChatController } from "./use-chat";
import { resolveSessionCwd } from "./use-chat";
import type { ChatTransport } from "../../lib/kanban-api";
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
function mount(transport?: ChatTransport) {
  const clock = new VirtualClock();
  const adapter = new FakeAdapter({ clock });
  const tr = transport ?? makeTransport(adapter);
  const holder: { controller?: ChatController } = {};
  const onController = (c: ChatController): void => {
    holder.controller = c;
  };
  function Host() {
    const projects = useProjects(tr);
    return <ChatWorkspace transport={tr} projects={projects} demoCwd={DEMO_CWD} onController={onController} />;
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

/** 输入并发送一条消息 */
function send(text: string): void {
  const box = screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…");
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "发送 ➤" }));
}

describe("聊天区（原型一致项 5/6/7）", () => {
  it("启动自动创建首个会话：侧栏会话行 + composer 可用", async () => {
    const t = mount();
    await t.flush();
    expect(screen.getByText("演示会话 · Fake")).toBeTruthy();
    expect(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "发送 ➤" })).toBeTruthy();
    expect(screen.getByText("空闲")).toBeTruthy();
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

  it("错误演示：⚠ 错误提示可见、不崩溃、可继续", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("错误演示");
    });
    t.advance();
    expect(screen.getByText(/Fake CLI 进程意外退出/)).toBeTruthy();
    expect(screen.getByText("空闲")).toBeTruthy();
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

  it("composer：OpenCode 会话明示权限档位为 server 级（同项目共享）；其他 CLI 无此说明（spec B UI 明示）", async () => {
    const t = mount();
    await t.flush();
    expect(screen.queryByText(/OpenCode 权限档位为 server 级/)).toBeNull(); // fake 会话不显示
    await act(async () => {
      await t.ctl().createSession("opencode", { cwd: DEMO_CWD, title: "演示会话 · OpenCode" });
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
    // A 流式中新建并切到 B
    await act(async () => {
      await t.ctl().createSession("fake");
    });
    const activeId = t.ctl().activeId;
    expect(activeId).toBeTruthy();
    expect(screen.getByText("新会话 · Fake")).toBeTruthy();
    t.advance(); // A 在后台完成
    expect(screen.queryByText(/基线全绿/)).toBeNull(); // 当前视图是 B，不显示 A 内容
    // 切回 A：全文在（流式未被切换打断）
    fireEvent.click(screen.getByText("演示会话 · Fake"));
    expect(
      screen.getByText("基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。"),
    ).toBeTruthy();
  });

  it("新建会话：侧栏「＋」菜单（一致项 2 的 Fake 入口）新增会话行并激活", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      await t.ctl().createSession("fake");
    });
    await t.flush();
    expect(screen.getByText("新会话 · Fake")).toBeTruthy();
    expect(screen.getAllByText("新会话 · Fake").length).toBeGreaterThanOrEqual(1);
  });

  it("真实 CLI 无显式 cwd：拒绝创建（不得以任何隐式演示目录创建真实会话，code-review 硬违规回归）", async () => {
    const t = mount();
    await t.flush();
    const before = t.ctl().sessions.length;
    await act(async () => {
      await t.ctl().createSession("claude");
    });
    await t.flush();
    expect(t.ctl().sessions.length).toBe(before);
  });

  it("Fake 无显式 cwd：用注入的演示目录创建（cwd 来自注入而非 renderer 内置路径）", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      await t.ctl().createSession("fake");
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
      send("任何消息");
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
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-ws-projects-"));
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

    // 「＋」菜单：Claude 新建会话（一致项 2/3：菜单四项入口 + CLI 色点 + 主仓库徽标）
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByText("Claude"));
    await t1.flush();
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
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-ws-pty-"));
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

  it("「＋」→ PTY 终端：PTY 分组出现会话行 + 面板挂起（xterm）；切换到结构化会话再切回：面板保留（进程不停止）", async () => {
    const { transport } = makePtyFixture();
    const t = await boot(transport);

    // 「＋」菜单建 PTY 会话（echo mock PTY：started + 提示符事件回流）
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByRole("button", { name: /PTY 终端/ }));
    await t.flush();
    expect((await findTitle("终端 · pwsh")).length).toBeGreaterThanOrEqual(1);

    // 激活 PTY 会话 → 面板渲染 xterm（banner 内容由 terminal-manager 单测覆盖；jsdom 下 xterm 不落 DOM 行文本）
    await waitFor(() => expect(document.querySelector(".xterm")).toBeTruthy());

    // 建一个结构化会话并切换：PTY 面板卸载但会话保留
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByText("Claude"));
    await t.flush();
    await screen.findByText("新会话 · Claude");
    expect(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…")).toBeTruthy();
    expect(document.querySelector(".xterm")).toBeNull();

    // 切回 PTY：面板保留（同一持久元素重新挂入，进程未停 —— mock PTY 仍可回显）
    fireEvent.click(screen.getAllByText("终端 · pwsh")[0]);
    await waitFor(() => expect(document.querySelector(".xterm")).toBeTruthy());
  });

  it("停止终端：exit 事件 → 状态已断开；重启恢复为断开态条目（进程不在）", async () => {
    const { dbPath, transport } = makePtyFixture();
    const t = await boot(transport);

    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByRole("button", { name: /PTY 终端/ }));
    await t.flush();
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
    send("拆类型");
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
    send("拆类型");
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

    // 注册项目 + 两个 Claude 会话（同一主仓库目录）
    fireEvent.click(screen.getByRole("button", { name: "＋ 注册本地目录…" }));
    await t.flush();
    expect(await screen.findByText("demo-repo")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByText("Claude"));
    await t.flush();
    expect(await screen.findByText("新会话 · Claude")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getAllByText("Claude")[0]);
    await t.flush();
    expect((await screen.findAllByText("新会话 · Claude")).length).toBe(2);

    // 两个会话各跑一个 turn（VirtualClock 不自动推进 → 保持 running）
    send("拆类型"); // 当前活跃（第二个会话）
    const rows = screen.getAllByText("新会话 · Claude");
    fireEvent.click(rows[0]); // 切到第一个会话并发送
    send("拆类型");
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
    const t = await boot(transport);
    expect(screen.queryByTestId("skill-conflict-banner")).toBeNull(); // 当前活跃为 boot 的 Fake 会话：不提示

    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByText("Claude"));
    await t.flush();
    expect(await screen.findByText("新会话 · Claude")).toBeTruthy();
    const banner = await screen.findByTestId("skill-conflict-banner");
    expect(banner.textContent).toContain("检测到同名 skill");
    expect(banner.textContent).toContain("design-feature"); // 冲突名（项目侧命名）
    expect(banner.textContent).toContain("项目级将优先生效");
    expect(banner.textContent).toContain("同名可能使模型行为不稳定");
  });

  it("可关闭：点「知道了」提示条消失；关闭后会话正常使用（发消息照常回显与回复）", async () => {
    const { clock, transport } = makeSkillConflictFixture(["design-feature"]);
    const t = await boot(transport);
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByText("Claude"));
    await t.flush();
    expect(await screen.findByTestId("skill-conflict-banner")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    await t.flush();
    expect(screen.queryByTestId("skill-conflict-banner")).toBeNull(); // 关闭仅隐藏

    // 会话正常：发消息本地回显 + Fake 全 turn 回复（非阻塞：关闭不影响会话）
    await act(async () => {
      send("继续工作");
    });
    act(() => {
      clock.runToIdle();
    });
    expect(screen.getByText("继续工作")).toBeTruthy();
    expect(screen.getByText("好的，我先跑一遍现有测试确认基线，然后开始拆分。")).toBeTruthy();
    expect(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…")).toHaveProperty("disabled", false);
  });

  it("无冲突（用户级无同名）：Claude 会话不出现提示条", async () => {
    const { transport } = makeSkillConflictFixture(["user-only"]);
    const t = await boot(transport);
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByText("Claude"));
    await t.flush();
    expect(await screen.findByText("新会话 · Claude")).toBeTruthy();
    expect(screen.queryByTestId("skill-conflict-banner")).toBeNull();
  });

  it("非 claude 会话不提示：同目录 Codex 会话无提示条（§7-4 决策：仅 Claude 检测）", async () => {
    const { transport } = makeSkillConflictFixture(["design-feature"]);
    const t = await boot(transport);
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByText("Codex"));
    await t.flush();
    expect(await screen.findByText("新会话 · Codex")).toBeTruthy();
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
