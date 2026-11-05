// mock 实现：在浏览器里替代 Electron preload 注入的 window.terminalApi。
// 证明 TerminalPanel 渲染层只依赖 terminalApi.ts 的 46 行类型契约，
// 不依赖 Electron / node-pty / Go daemon。
// 行为：一个本地回显 shell——启动后打印横幅，回显输入，识别 clear/exit。
import type { TerminalApi } from "./terminalApi";

export function installMockTerminalApi(): void {
  let running = false;
  let started = false;
  let cwd = "C:\\demo\\project";
  let dataHandler: ((data: string) => void) | null = null;
  let exitHandler: ((info: { exitCode: number; signal?: number }) => void) | null = null;
  let errorHandler: ((info: { message: string }) => void) | null = null;
  let startedHandler:
    | ((info: { shell: string; cwd: string; pid: number }) => void)
    | null = null;
  let inputBuffer = "";
  // 诊断：记录 onData 注册/注销计数（验证 TerminalPanel 的 handler 生命周期）
  (window as unknown as { __mockOnDataCount?: number }).__mockOnDataCount = 0;

  const emit = (text: string) => dataHandler?.(text);

  const shell = "mock-sh (browser)";

  const api: TerminalApi = {
    async start(args) {
      if (started) {
        return { ok: true, cwd };
      }
      started = true;
      running = true;
      if (args?.cwd) cwd = args.cwd;
      emit(`\r\n\x1b[1m[mock PTY] shell=${shell} cwd=${cwd}\x1b[0m\r\n`);
      emit(`\x1b[2m输入任意字符回显；clear 清屏；exit 退出（模拟 PTY 生命周期）\x1b[0m\r\n\r\n`);
      startedHandler?.({ shell, cwd, pid: 4242 });
      emit(`\x1b[32m${cwd}>\x1b[0m `);
      return { ok: true, cwd };
    },
    async write(data) {
      if (!running) {
        errorHandler?.({ message: "PTY 未运行（已 exit）" });
        return { ok: true };
      }
      for (const ch of data) {
        if (ch === "\r") {
          emit("\r\n");
          const line = inputBuffer;
          inputBuffer = "";
          if (line === "clear") {
            emit("\x1b[2J\x1b[H");
          } else if (line === "exit") {
            running = false;
            emit(`\x1b[33m[mock] 进程退出 code=0\x1b[0m\r\n`);
            exitHandler?.({ exitCode: 0 });
            return { ok: true };
          } else if (line.length > 0) {
            emit(`\x1b[2m[mock echo] ${line}\x1b[0m\r\n`);
          }
          emit(`\x1b[32m${cwd}>\x1b[0m `);
        } else if (ch === "\u007f") {
          if (inputBuffer.length > 0) {
            inputBuffer = inputBuffer.slice(0, -1);
            emit("\b \b");
          }
        } else if (ch >= " ") {
          inputBuffer += ch;
          emit(ch);
        }
      }
      return { ok: true };
    },
    async resize(args) {
      void args;
      return { ok: true };
    },
    async kill() {
      running = false;
      return { ok: true };
    },
    async setCwd(next) {
      cwd = next;
      return { ok: true, cwd };
    },
    async status() {
      return { running, cwd, shell };
    },
    onData(handler) {
      dataHandler = handler;
      (window as unknown as { __mockOnDataCount?: number }).__mockOnDataCount =
        ((window as unknown as { __mockOnDataCount?: number }).__mockOnDataCount ?? 0) + 1;
      return () => {
        if (dataHandler === handler) dataHandler = null;
        const w = window as unknown as { __mockOnDataCount?: number };
        w.__mockOnDataCount = (w.__mockOnDataCount ?? 1) - 1;
      };
    },
    onExit(handler) {
      exitHandler = handler;
      return () => {
        exitHandler = null;
      };
    },
    onError(handler) {
      errorHandler = handler;
      return () => {
        errorHandler = null;
      };
    },
    onStarted(handler) {
      startedHandler = handler;
      return () => {
        startedHandler = null;
      };
    },
  };

  window.terminalApi = api;
}
