// 用途：renderer 终端多路复用管理器 —— 每个 terminalId 持久持有 xterm 实例与 DOM 元素（切换会话仅搬移元素、缓冲内容保留、PTY 不停）；挂载前事件缓冲、首挂载冲刷；主题/字体/banner 文案沿用旧 Kanban TerminalPanel（载荷形状不变复用，PoC 6 实证）
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalEvent } from "@kanban/ipc-schema";

/** 出站 io：写入/尺寸透传（由 use-terminals 接 transport） */
export interface TerminalIO {
  write(terminalId: string, data: string): void;
  resize(terminalId: string, cols: number, rows: number): void;
}

interface ManagedTerminal {
  term: Terminal;
  fit: FitAddon;
  /** 持久宿主元素：脱离容器后仍由 manager 持有（切换不销毁） */
  element: HTMLDivElement;
  attached: boolean;
}

// 旧 Kanban TerminalPanel 同款渲染配置（暗色主题基调保留，spec I 可调整项）
const XTERM_OPTIONS = {
  fontFamily: '"IBM Plex Mono", "JetBrains Mono", Consolas, "Cascadia Code", "Courier New", monospace',
  fontSize: 13,
  lineHeight: 1.35,
  cursorBlink: true,
  convertEol: true,
  allowProposedApi: true,
  theme: {
    background: "#0b0d12",
    foreground: "#e6e9f2",
    cursor: "#c5ff3a",
    cursorAccent: "#0b0d12",
    selectionBackground: "rgba(197, 255, 58, 0.22)",
    black: "#11141b",
    red: "#ff6b5c",
    green: "#7fe3a8",
    yellow: "#ffb547",
    blue: "#5eb1ff",
    magenta: "#b794ff",
    cyan: "#7fe3a8",
    white: "#e6e9f2",
    brightBlack: "#3d4256",
    brightRed: "#ff8b7d",
    brightGreen: "#a4f0c2",
    brightYellow: "#ffd07a",
    brightBlue: "#8ecbff",
    brightMagenta: "#d4b5ff",
    brightCyan: "#a4f0c2",
    brightWhite: "#ffffff",
  },
} as const;

export class TerminalManager {
  private readonly terminals = new Map<string, ManagedTerminal>();
  /** attach 前到达的事件缓冲（后台 PTY 输出不丢） */
  private readonly pending = new Map<string, TerminalEvent[]>();

  constructor(private readonly io: TerminalIO) {}

  /** 该终端是否已有 xterm 实例（区分「从未挂载的断开会话」与「看过内容的终端」） */
  has(terminalId: string): boolean {
    return this.terminals.has(terminalId);
  }

  /** terminal:event 入口：按 terminalId 路由（无实例则缓冲） */
  handleEvent(event: TerminalEvent): void {
    const t = this.terminals.get(event.terminalId);
    if (!t) {
      const buf = this.pending.get(event.terminalId) ?? [];
      buf.push(event);
      this.pending.set(event.terminalId, buf);
      return;
    }
    this.apply(t, event);
  }

  /** 面板挂载：创建（或复用）xterm 元素并入容器；冲刷挂载前缓冲 */
  attach(terminalId: string, container: HTMLElement): void {
    let t = this.terminals.get(terminalId);
    if (!t) {
      const element = document.createElement("div");
      element.style.width = "100%";
      element.style.height = "100%";
      const term = new Terminal(XTERM_OPTIONS);
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(element);
      term.onData((input) => this.io.write(terminalId, input));
      t = { term, fit, element, attached: false };
      this.terminals.set(terminalId, t);
    }
    if (t.element.parentElement !== container) container.appendChild(t.element);
    t.attached = true;
    const buffered = this.pending.get(terminalId);
    if (buffered) {
      this.pending.delete(terminalId);
      for (const ev of buffered) this.apply(t, ev);
    }
    // 初始 fit（布局就绪后微任务时机）
    queueMicrotask(() => this.fit(terminalId));
  }

  /** 面板卸载：元素脱离容器，实例与缓冲内容保留（切换/关标签不停止） */
  detach(terminalId: string): void {
    const t = this.terminals.get(terminalId);
    if (!t) return;
    t.element.remove();
    t.attached = false;
  }

  /** 容器尺寸变化：fit 本地 + 尺寸透传 PTY */
  fit(terminalId: string): void {
    const t = this.terminals.get(terminalId);
    if (!t || !t.attached) return;
    try {
      t.fit.fit();
      this.io.resize(terminalId, t.term.cols, t.term.rows);
    } catch {
      // 容器未布局好（0 尺寸）等场景忽略，下次 resize 重试
    }
  }

  /** 销毁实例（进程终结后释放；dispose 延后一个宏任务让 xterm 内部 rAF 排空 —— 旧 Kanban Viewport rAF 竞态修复） */
  dispose(terminalId: string): void {
    const t = this.terminals.get(terminalId);
    if (!t) return;
    t.element.remove();
    this.terminals.delete(terminalId);
    this.pending.delete(terminalId);
    setTimeout(() => t.term.dispose(), 0);
  }

  /** 缓冲全文（测试断言与诊断用） */
  bufferText(terminalId: string): string {
    const t = this.terminals.get(terminalId);
    if (!t) return "";
    const lines: string[] = [];
    for (let i = 0; i < t.term.buffer.active.length; i += 1) {
      lines.push(t.term.buffer.active.getLine(i)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  }

  /** 单事件落终端：data 直写；started/exit/error 以 banner 呈现（旧 Kanban 文案原样） */
  private apply(t: ManagedTerminal, event: TerminalEvent): void {
    switch (event.type) {
      case "data":
        t.term.write(event.data);
        break;
      case "started":
        t.term.writeln(`\x1b[32m[已启动 ${event.shell} 路径 ${event.cwd} pid=${event.pid}]\x1b[0m\r\n`);
        break;
      case "exit":
        t.term.writeln(`\r\n\x1b[33m[进程退出 code=${event.exitCode} signal=${event.signal ?? 0}]\x1b[0m`);
        break;
      case "error":
        t.term.writeln(`\r\n\x1b[31m[错误] ${event.message}\x1b[0m`);
        break;
    }
  }
}
