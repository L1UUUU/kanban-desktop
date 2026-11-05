// 用途：TerminalManager 单测（mock 事件流驱动，jsdom）—— data/started/exit 按 terminalId 路由不串台、挂载前缓冲冲刷、detach→reattach 内容保留（切换会话不丢终端）、dispose 清理
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalEvent } from "@kanban/ipc-schema";
import { TerminalManager } from "./TerminalManager";

// jsdom 缺 matchMedia：xterm 5 浏览器服务（CoreBrowserService）需要（测试环境 polyfill，生产 Chromium 原生具备）
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

/** io 记录器：write/resize 调用落表 */
function makeIo() {
  const writes: Array<[string, string]> = [];
  const resizes: Array<[string, number, number]> = [];
  return {
    writes,
    resizes,
    io: {
      write: (id: string, data: string) => writes.push([id, data]),
      resize: (id: string, cols: number, rows: number) => resizes.push([id, cols, rows]),
    },
  };
}

/** 独立挂载容器（挂到 body 以具备布局属性） */
function container(): HTMLDivElement {
  const el = document.createElement("div");
  el.style.width = "800px";
  el.style.height = "600px";
  document.body.appendChild(el);
  return el;
}

const started = (terminalId: string): TerminalEvent => ({
  terminalId,
  type: "started",
  shell: "pwsh.exe",
  cwd: "C:\\repo",
  pid: 4242,
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("事件路由（多终端多路复用）", () => {
  it("data 按 terminalId 路由：t-1 的输出不写入 t-2 缓冲", async () => {
    const { io } = makeIo();
    const m = new TerminalManager(io);
    m.attach("t-1", container());
    m.attach("t-2", container());

    m.handleEvent({ terminalId: "t-1", type: "data", data: "HELLO_T1" });
    m.handleEvent({ terminalId: "t-2", type: "data", data: "HELLO_T2" });

    await vi.waitFor(() => expect(m.bufferText("t-1")).toContain("HELLO_T1"));
    expect(m.bufferText("t-1")).not.toContain("HELLO_T2");
    await vi.waitFor(() => expect(m.bufferText("t-2")).toContain("HELLO_T2"));
    expect(m.bufferText("t-2")).not.toContain("HELLO_T1");
  });

  it("started/exit banner 写入对应终端缓冲（载荷形状沿用旧 Kanban 文案）", async () => {
    const { io } = makeIo();
    const m = new TerminalManager(io);
    m.attach("t-1", container());

    m.handleEvent(started("t-1"));
    await vi.waitFor(() => expect(m.bufferText("t-1")).toContain("[已启动 pwsh.exe 路径 C:\\repo pid=4242]"));

    m.handleEvent({ terminalId: "t-1", type: "exit", exitCode: 0 });
    await vi.waitFor(() => expect(m.bufferText("t-1")).toContain("[进程退出 code=0 signal=0]"));

    m.handleEvent({ terminalId: "t-1", type: "error", message: "boom" });
    await vi.waitFor(() => expect(m.bufferText("t-1")).toContain("[错误] boom"));
  });
});

describe("挂载前缓冲与切换保留", () => {
  it("attach 前到达的事件（started/早期 data）缓冲，首次 attach 后冲刷不丢", async () => {
    const { io } = makeIo();
    const m = new TerminalManager(io);

    m.handleEvent(started("t-1"));
    m.handleEvent({ terminalId: "t-1", type: "data", data: "EARLY_OUT" });

    m.attach("t-1", container());
    await vi.waitFor(() => {
      expect(m.bufferText("t-1")).toContain("[已启动 pwsh.exe 路径 C:\\repo pid=4242]");
      expect(m.bufferText("t-1")).toContain("EARLY_OUT");
    });
  });

  it("detach → 重新 attach：缓冲内容保留 + 同一 DOM 元素搬移（切走再切回，终端内容不丢）", async () => {
    const { io } = makeIo();
    const m = new TerminalManager(io);
    const first = container();
    m.attach("t-1", first);
    m.handleEvent({ terminalId: "t-1", type: "data", data: "KEEP_ME" });
    await vi.waitFor(() => expect(m.bufferText("t-1")).toContain("KEEP_ME"));
    const xtermEl = first.querySelector(".xterm");
    expect(xtermEl).toBeTruthy();

    // 切走（卸载面板）：元素脱离 DOM 但终端实例存活
    m.detach("t-1");
    expect(first.querySelector(".xterm")).toBeNull();
    expect(m.has("t-1")).toBe(true);

    // 切回：内容仍在，元素搬入新容器
    const second = container();
    m.attach("t-1", second);
    expect(second.querySelector(".xterm")).toBeTruthy();
    expect(m.bufferText("t-1")).toContain("KEEP_ME");
  });
});

describe("dispose 与健壮性", () => {
  it("dispose：元素移除 + has=false；未知 id 的 detach/fit 不抛", () => {
    const { io } = makeIo();
    const m = new TerminalManager(io);
    const el = container();
    m.attach("t-1", el);

    m.dispose("t-1");
    expect(m.has("t-1")).toBe(false);
    expect(el.querySelector(".xterm")).toBeNull();

    expect(() => m.detach("t-1")).not.toThrow();
    expect(() => m.fit("t-1")).not.toThrow();
    expect(() => m.fit("ghost")).not.toThrow();
  });

  it("未知终端的 data 事件被缓冲（不创建实例），dispose 后缓冲一并清理", async () => {
    const { io } = makeIo();
    const m = new TerminalManager(io);
    m.handleEvent({ terminalId: "t-9", type: "data", data: "ORPHAN" });
    m.attach("t-9", container());
    await vi.waitFor(() => expect(m.bufferText("t-9")).toContain("ORPHAN"));

    m.dispose("t-9");
    m.handleEvent({ terminalId: "t-9", type: "data", data: "AFTER" });
    m.attach("t-9", container());
    expect(m.bufferText("t-9")).not.toContain("AFTER");
  });
});
