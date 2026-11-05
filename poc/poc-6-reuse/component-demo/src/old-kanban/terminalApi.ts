// Mirrors the type shape exposed on `window.terminalApi` by `electron/preload.ts`.
// Kept as a standalone file so the renderer can use it without importing
// the preload module (which would fail outside Electron).

export type StartArgs = {
  cwd?: string;
  cols?: number;
  rows?: number;
};

export type ResizeArgs = {
  cols: number;
  rows: number;
};

export type TerminalStatus = {
  running: boolean;
  cwd: string | null;
  shell: string;
};

export type TerminalApi = {
  start: (args?: StartArgs) => Promise<{ ok: true; cwd: string | null }>;
  write: (data: string) => Promise<{ ok: true }>;
  resize: (args: ResizeArgs) => Promise<{ ok: true }>;
  kill: () => Promise<{ ok: true }>;
  setCwd: (cwd: string) => Promise<{ ok: true; cwd: string | null }>;
  status: () => Promise<TerminalStatus>;
  onData: (handler: (data: string) => void) => () => void;
  onExit: (handler: (info: { exitCode: number; signal?: number }) => void) => () => void;
  onError: (handler: (info: { message: string }) => void) => () => void;
  onStarted: (handler: (info: { shell: string; cwd: string; pid: number }) => void) => () => void;
};

declare global {
  interface Window {
    terminalApi?: TerminalApi;
  }
}

export function getTerminalApi(): TerminalApi {
  if (typeof window === 'undefined' || !window.terminalApi) {
    throw new Error('terminalApi is not available — preload script did not load.');
  }
  return window.terminalApi;
}
