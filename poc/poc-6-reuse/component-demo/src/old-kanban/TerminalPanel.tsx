import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { getTerminalApi } from './terminalApi';

export type TerminalPanelHandle = {
  clear: () => void;
  write: (data: string) => void;
  fit: () => void;
};

export type TerminalPanelProps = {
  onError?: (message: string) => void;
  onExit?: (info: { exitCode: number; signal?: number }) => void;
  onStarted?: (info: { shell: string; cwd: string; pid: number }) => void;
};

export const TerminalPanel = forwardRef<TerminalPanelHandle, TerminalPanelProps>(function TerminalPanel(
  { onError, onExit, onStarted },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      clear: () => {
        termRef.current?.reset();
      },
      write: (data) => {
        termRef.current?.write(data);
      },
      fit: () => {
        try {
          fitRef.current?.fit();
        } catch {
          // ignore
        }
      },
    }),
    [],
  );

  useEffect(() => {
    if (!containerRef.current) return;

    // Closure flag: drop late resize callbacks so they never reach a
    // disposed Terminal (StrictMode dev double-invoke + window-resize
    // landing during cleanup can otherwise hit @xterm/xterm.js's
    // Viewport rAF → "Cannot read properties of undefined (reading 'dimensions')").
    let cancelled = false;

    const term = new Terminal({
      fontFamily:
        '"IBM Plex Mono", "JetBrains Mono", Consolas, "Cascadia Code", "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
      convertEol: true,
      allowProposedApi: true,
      theme: {
        background: '#0b0d12',
        foreground: '#e6e9f2',
        cursor: '#c5ff3a',
        cursorAccent: '#0b0d12',
        selectionBackground: 'rgba(197, 255, 58, 0.22)',
        black: '#11141b',
        red: '#ff6b5c',
        green: '#7fe3a8',
        yellow: '#ffb547',
        blue: '#5eb1ff',
        magenta: '#b794ff',
        cyan: '#7fe3a8',
        white: '#e6e9f2',
        brightBlack: '#3d4256',
        brightRed: '#ff8b7d',
        brightGreen: '#a4f0c2',
        brightYellow: '#ffd07a',
        brightBlue: '#8ecbff',
        brightMagenta: '#d4b5ff',
        brightCyan: '#a4f0c2',
        brightWhite: '#ffffff',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    termRef.current = term;
    fitRef.current = fit;

    // initial fit
    try {
      fit.fit();
    } catch {
      // container not ready yet, will retry on resize
    }

    const api = getTerminalApi();

    const offData = api.onData((data) => term.write(data));
    const offError = api.onError((info) => {
      term.writeln(`\r\n\x1b[31m[错误] ${info.message}\x1b[0m`);
      onError?.(info.message);
    });
    const offExit = api.onExit((info) => {
      term.writeln(`\r\n\x1b[33m[进程退出 code=${info.exitCode} signal=${info.signal ?? 0}]\x1b[0m`);
      onExit?.(info);
    });
    const offStarted = api.onStarted((info) => {
      term.writeln(`\x1b[32m[已启动 ${info.shell} 路径 ${info.cwd} pid=${info.pid}]\x1b[0m\r\n`);
      onStarted?.(info);
    });

    const dataDisp = term.onData((input) => {
      api.write(input).catch((err) => {
        term.writeln(`\r\n\x1b[31m[写入失败] ${(err as Error).message}\x1b[0m`);
      });
    });

    const resize = () => {
      if (cancelled) return;
      try {
        fit.fit();
        api.resize({ cols: term.cols, rows: term.rows }).catch(() => {});
      } catch {
        // ignore
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(containerRef.current);
    window.addEventListener('resize', resize);

    // Best-effort initial sync
    queueMicrotask(resize);

    return () => {
      cancelled = true;
      window.removeEventListener('resize', resize);
      ro.disconnect();
      dataDisp.dispose();
      offData();
      offError();
      offExit();
      offStarted();
      // Defer `term.dispose()` to the next macrotask so any
      // @xterm/xterm-internal rAFs already queued during mount
      // (Viewport.syncScrollArea / _refresh) run while the
      // renderService is still intact. xterm 5.5.0's Viewport.dispose()
      // only cancels the debounce setTimeout, not the rAF — disposing
      // mid-flight throws "Cannot read properties of undefined
      // (reading 'dimensions')". The event loop fires rAF at frame
      // paint, before the next task, so this setTimeout lets the
      // pending rAF drain first against the live renderService.
      setTimeout(() => term.dispose(), 0);
      termRef.current = null;
      fitRef.current = null;
    };
  }, [onError, onExit, onStarted]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        minHeight: 320,
        background: '#0b0d12',
        padding: 10,
        boxSizing: 'border-box',
      }}
    />
  );
});

export default TerminalPanel;
