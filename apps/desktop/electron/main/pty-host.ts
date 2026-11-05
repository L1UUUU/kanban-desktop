// 用途：PTY 终端宿主（Electron main 进程内直接使用 node-pty，ADR-0001/utilityProcess 为 cli-host 形态、不适用本通道；t0-03 已实测 main 进程可用）—— 自旧 Kanban terminal-host.ts 演进（PoC 6 实证 0 diff 抽离），改动：单终端闭包 → terminalId Map 多路复用 + command 模式（直接跑 CLI TUI）；平台能力全部注入（mock PTY 单测模式，old-kanban 范式）

// --- 最小 pty 面（node-pty IPty 的结构子集；测试 fake 免依赖即可满足） ----------

export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (info: { exitCode: number; signal?: number }) => void): unknown;
  resize(columns: number, rows: number): void;
  write(data: string): void;
  kill(): void;
}

export interface PtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: { [key: string]: string | undefined };
}

export interface PtyLike {
  spawn(file: string, args: string[] | string, options: PtySpawnOptions): PtyProcess;
}

// --- 事件出口（main.ts 接线 webContents.send("terminal:event")，宿主不引用 Electron API）

export interface TerminalEventSink {
  /** spawn 成功后发一次（在 onData/onExit 接线前） */
  started(terminalId: string, payload: { shell: string; cwd: string; pid: number }): void;
  /** PTY 输出分片 */
  data(terminalId: string, data: string): void;
  /** 底层 PTY 子进程退出 */
  exit(terminalId: string, payload: { exitCode: number; signal?: number }): void;
  /** 宿主侧不可恢复错误（保留旧 Kanban 契约成员；spawn 失败经 spawn 返回值上报） */
  error(terminalId: string, payload: { message: string }): void;
}

// --- 依赖注入 ----------------------------------------------------------------

export interface PtyHostDeps {
  /** node-pty 面（或测试 fake） */
  pty: PtyLike;
  /** shell 探测（`where <exe>`，命中返回/未命中抛错） */
  execFileSync(cmd: string, args: string[], opts: { stdio: "ignore" }): void;
  /** 命令路径探测（`where <exe>` 文本输出，未命中抛错） */
  execFileTextSync(cmd: string, args: string[]): string;
  /** cwd 存在性检查 */
  existsSync(path: string): boolean;
  /** path.resolve：cwd 归一化为绝对路径 */
  resolve(path: string): string;
  /** 临时目录兜底 */
  tmpdir(): string;
  /** env 读取面 */
  env: NodeJS.ProcessEnv;
  /** process.platform */
  platform: NodeJS.Platform;
  /** process.cwd() 访问器 */
  cwd(): string;
  /** 默认 shell 覆盖（config：null=自动探测 pwsh→powershell→cmd） */
  shellOverride(): string | null;
  /** 三 CLI exe 配置覆盖（键命中返回配置路径，spec G：不硬编码） */
  cliExeOverride(name: string): string | null;
  /** 错误日志（缺省 console） */
  log?: { error(...args: unknown[]): void };
}

export interface SpawnRequest {
  cwd: string;
  cols: number;
  rows: number;
  /** 直接执行命令（如 claude TUI，args 容缺省）；缺省=交互 shell */
  command?: { exe: string; args?: string[] };
}

export type SpawnResult = { ok: true; label: string; shell: string; cwd: string } | { ok: false; message: string };

/** ipc.ts 消费的窄面 */
export interface PtyHost {
  /** 为 terminalId 启动 PTY（同 id 已在跑则先停旧的） */
  spawn(terminalId: string, req: SpawnRequest): SpawnResult;
  write(terminalId: string, data: string): { ok: true } | { ok: false; message: string };
  resize(terminalId: string, cols: number, rows: number): void;
  /** 幂等；用户显式停止终端的唯一路径（切页/关标签不触发） */
  kill(terminalId: string): void;
  isRunning(terminalId: string): boolean;
  /** 停全部（应用退出 before-quit） */
  killAll(): void;
}

/** Windows 下需要 cmd 包装的脚本形态（npm .cmd shim 等：CreateProcess 不能直接拉起） */
const SCRIPT_EXT = /\.(cmd|bat)$/i;

/** 判断是否路径形态（含分隔符或盘符前缀），否则按裸名探测 */
function isPathLike(exe: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(exe) || exe.includes("\\") || exe.includes("/");
}

/** 去扩展名 basename：pwsh.exe → pwsh（会话标题 label） */
function labelOf(file: string): string {
  const base = file.replaceAll("\\", "/").split("/").pop() ?? file;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "");
}

/**
 * 多路复用 PTY 宿主：Map<terminalId, PtyProcess>。
 * resolveCwd/defaultShell 自旧 Kanban 逐字保留（仅展开注释）；新增 command 解析与按 id 路由。
 */
export function createPtyHost(deps: PtyHostDeps, sink: TerminalEventSink): PtyHost {
  const { pty, execFileSync, execFileTextSync, existsSync, resolve, tmpdir, env, platform, cwd: cwdFn, log = console } = deps;

  const procs = new Map<string, PtyProcess>();
  // 默认 shell 探测结果缓存（进程生命周期内稳定，省去每次 ~50ms×4 的 where 探测）
  let cachedDefaultShell: string | null = null;

  // cwd 解析（旧 Kanban 原样）：回退链 USERPROFILE → resolve(cwd()) → tmpdir；不存在目录回退
  function resolveCwd(input: string | null | undefined): string {
    const fallback = env.USERPROFILE || resolve(cwdFn()) || tmpdir();
    if (!input || input.trim() === "") return fallback;
    const candidate = resolve(input);
    return existsSync(candidate) ? candidate : fallback;
  }

  // 默认 shell 探测链（旧 Kanban 原样）：pwsh → powershell → cmd；环境 SHELL 在 Windows 不可信
  function defaultShell(): string {
    if (platform === "win32") {
      if (cachedDefaultShell !== null) return cachedDefaultShell;
      for (const c of ["pwsh.exe", "pwsh", "powershell.exe", "cmd.exe"]) {
        try {
          execFileSync("where", [c], { stdio: "ignore" });
          cachedDefaultShell = c;
          return c;
        } catch {
          /* not found, try next */
        }
      }
      cachedDefaultShell = "powershell.exe";
      return cachedDefaultShell;
    }
    return env.SHELL || "/bin/bash";
  }

  // 交互 shell 启动参数：PowerShell 加 -NoLogo（首屏干净）；cmd/其他不加
  function shellArgs(file: string): string[] {
    if (platform !== "win32") return ["-l"];
    return /powershell|pwsh/i.test(file) ? ["-NoLogo"] : [];
  }

  // command 解析：config 覆盖 > 路径形态直用 > where 裸名探测；.cmd/.bat 经 cmd.exe /d /c 包装（args 容缺省：非 IPC 直调场景）
  function resolveCommand(command: { exe: string; args?: string[] }): { file: string; args: string[]; label: string } | { message: string } {
    const label = labelOf(command.exe);
    const commandArgs = command.args ?? [];
    let target: string | null = deps.cliExeOverride(command.exe);
    if (!target && isPathLike(command.exe)) target = command.exe;
    if (!target && platform === "win32") {
      // `where` 多行输出（如 npm 同名 sh 脚本/.cmd/.ps1 三件）：只认可 CreateProcess 直拉或可包装的行
      try {
        const out = execFileTextSync("where", [command.exe]);
        target =
          out
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line.length > 0 && (/\.exe$/i.test(line) || SCRIPT_EXT.test(line))) ?? null;
      } catch {
        target = null;
      }
    }
    if (!target) {
      return { message: `未找到命令：${command.exe}（需在 PATH 中，或在设置中配置 exe 路径）` };
    }
    if (SCRIPT_EXT.test(target)) {
      return { file: "cmd.exe", args: ["/d", "/c", target, ...commandArgs], label };
    }
    return { file: target, args: commandArgs, label };
  }

  function killById(terminalId: string): void {
    const proc = procs.get(terminalId);
    if (!proc) return;
    procs.delete(terminalId);
    try {
      proc.kill();
    } catch (err) {
      log.error("[pty] kill failed", terminalId, err);
    }
  }

  function spawn(terminalId: string, req: SpawnRequest): SpawnResult {
    killById(terminalId); // 同 id 重开先清旧进程
    const cwd = resolveCwd(req.cwd);
    const cols = Math.max(2, Math.floor(req.cols) || 80);
    const rows = Math.max(2, Math.floor(req.rows) || 30);

    let file: string;
    let args: string[];
    let label: string;
    if (req.command) {
      const resolved = resolveCommand(req.command);
      if ("message" in resolved) return { ok: false, message: resolved.message };
      ({ file, args, label } = resolved);
    } else {
      file = deps.shellOverride() || defaultShell();
      args = shellArgs(file);
      label = labelOf(file);
    }

    let proc: PtyProcess;
    try {
      proc = pty.spawn(file, args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: { ...env, TERM: "xterm-256color" } as Record<string, string>,
      });
    } catch (err) {
      return { ok: false, message: `启动失败：${(err as Error).message}` };
    }

    procs.set(terminalId, proc);
    sink.started(terminalId, { shell: file, cwd, pid: proc.pid });
    proc.onData((data) => sink.data(terminalId, data));
    proc.onExit(({ exitCode, signal }) => {
      procs.delete(terminalId);
      sink.exit(terminalId, { exitCode, signal });
    });
    return { ok: true, label, shell: file, cwd };
  }

  return {
    spawn,
    write: (terminalId, data) => {
      const proc = procs.get(terminalId);
      if (!proc) return { ok: false, message: "终端未运行（进程不存在或已退出）" };
      proc.write(data);
      return { ok: true };
    },
    resize: (terminalId, cols, rows) => {
      const proc = procs.get(terminalId);
      if (!proc) return;
      try {
        proc.resize(Math.max(2, Math.floor(cols) || 80), Math.max(2, Math.floor(rows) || 30));
      } catch (err) {
        log.error("[pty] resize failed", terminalId, err);
      }
    },
    kill: killById,
    isRunning: (terminalId) => procs.has(terminalId),
    killAll: () => {
      // 先固化 id 快照：killById 遍历中删除条目（Map 迭代中删安全，但快照意图更明确）
      const ids = [...procs.keys()];
      for (const id of ids) killById(id);
    },
  };
}
