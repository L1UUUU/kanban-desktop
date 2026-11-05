// 用途：PTY 宿主多路复用单测（mock PTY 模式，old-kanban 依赖注入范式）—— data/exit 按 terminalId 路由、write/resize/kill 定向、shell 探测链与覆盖、command 解析（config 覆盖 / where 探测 / .cmd 包装）、cwd 回退、spawn 失败与退出后的状态
import { beforeEach, describe, expect, it } from "vitest";
import { createPtyHost, type PtyHost, type PtyHostDeps, type PtyLike, type PtyProcess } from "./pty-host";

// fake PTY 进程：记录 resize/write/kill，手动 emit data/exit（驱动宿主路由逻辑）
class FakePtyProcess implements PtyProcess {
  readonly pid: number;
  killed = false;
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  private readonly dataListeners: Array<(data: string) => void> = [];
  private readonly exitListeners: Array<(info: { exitCode: number; signal?: number }) => void> = [];

  constructor(pid: number) {
    this.pid = pid;
  }

  onData(listener: (data: string) => void): unknown {
    this.dataListeners.push(listener);
    return listener;
  }

  onExit(listener: (info: { exitCode: number; signal?: number }) => void): unknown {
    this.exitListeners.push(listener);
    return listener;
  }

  resize(columns: number, rows: number): void {
    this.resizes.push({ cols: columns, rows });
  }

  write(data: string): void {
    this.writes.push(data);
  }

  kill(): void {
    this.killed = true;
  }

  emitData(data: string): void {
    for (const l of this.dataListeners) l(data);
  }

  emitExit(info: { exitCode: number; signal?: number }): void {
    for (const l of this.exitListeners) l(info);
  }
}

// fake node-pty：记录 spawn 调用，可注入失败
class FakePty implements PtyLike {
  readonly processes: FakePtyProcess[] = [];
  readonly spawns: Array<{ file: string; args: string[]; options: unknown }> = [];
  failSpawn = false;
  private nextPid = 1000;

  spawn(file: string, args: string[], options: unknown): PtyProcess {
    if (this.failSpawn) throw new Error("spawn boom");
    const proc = new FakePtyProcess(this.nextPid++);
    this.processes.push(proc);
    this.spawns.push({ file, args, options });
    return proc;
  }
}

/** 事件收集 sink（terminalId 为第一参数，断言多路复用路由） */
interface CollectedEvent {
  terminalId: string;
  kind: "started" | "data" | "exit" | "error";
  payload: unknown;
}

function makeSink() {
  const events: CollectedEvent[] = [];
  return {
    events,
    sink: {
      started: (terminalId: string, payload: unknown) => events.push({ terminalId, kind: "started", payload }),
      data: (terminalId: string, data: string) => events.push({ terminalId, kind: "data", payload: data }),
      exit: (terminalId: string, payload: unknown) => events.push({ terminalId, kind: "exit", payload }),
      error: (terminalId: string, payload: unknown) => events.push({ terminalId, kind: "error", payload }),
    },
  };
}

// where 探测结果表：布尔探测（命中表即成功）；文本探测（返回表中完整多行输出）
let whereTable = new Map<string, string>();

/** 重置 where 探测命中表（默认空 = 全部未命中） */
function freshWhere(entries: Record<string, string> = {}): void {
  whereTable = new Map(Object.entries(entries));
}

// 每用例共享的宿主装配上下文（makeHost 重建宿主时刷新）
let ctx: {
  pty: FakePty;
  sink: ReturnType<typeof makeSink>;
  deps: PtyHostDeps;
};

/** 平台能力全注入建宿主：默认 win32、cwd 恒存在、无 shell/CLI 覆盖 */
function makeHost(over: Partial<PtyHostDeps> = {}): PtyHost {
  const pty = new FakePty();
  const sink = makeSink();
  const deps: PtyHostDeps = {
    pty,
    // where 布尔探测：命中表中 exe 返回，否则抛（模拟 ENOENT）
    execFileSync: (_cmd, args) => {
      if (!whereTable.has(args[0] ?? "")) throw new Error("not found");
    },
    // where 文本探测：返回表中完整输出（多行）
    execFileTextSync: (_cmd, args) => whereTable.get(args[0] ?? "") ?? "",
    existsSync: () => true,
    resolve: (p: string) => p,
    tmpdir: () => "C:\\tmp",
    env: { USERPROFILE: "C:\\home\\u" },
    platform: "win32",
    cwd: () => "C:\\cwd",
    shellOverride: () => null,
    cliExeOverride: () => null,
    ...over,
  };
  ctx = { pty, sink, deps };
  return createPtyHost(deps, sink.sink);
}

beforeEach(() => {
  freshWhere();
});

describe("多路复用路由（验收第 1 条核心）", () => {
  it("spawn 两个终端：各自独立进程 + sink.started 携带各自 terminalId 与 pid", () => {
    freshWhere({ "pwsh.exe": "C:\\pwsh.exe" });
    const host = makeHost();

    const r1 = host.spawn("t-1", { cwd: "C:\\a", cols: 80, rows: 30 });
    const r2 = host.spawn("t-2", { cwd: "C:\\b", cols: 100, rows: 40 });

    expect(r1).toMatchObject({ ok: true, label: "pwsh" });
    expect(r2).toMatchObject({ ok: true });
    expect(ctx.pty.processes).toHaveLength(2);
    const started = ctx.sink.events.filter((e) => e.kind === "started");
    expect(started).toHaveLength(2);
    expect(started[0]).toMatchObject({ terminalId: "t-1" });
    expect(started[1]).toMatchObject({ terminalId: "t-2" });
    expect((started[0].payload as { pid: number }).pid).toBe(ctx.pty.processes[0].pid);
    expect((started[1].payload as { pid: number }).pid).toBe(ctx.pty.processes[1].pid);
    expect(host.isRunning("t-1")).toBe(true);
    expect(host.isRunning("t-2")).toBe(true);
  });

  it("data 流按 terminalId 路由：t-1 的输出不串到 t-2", () => {
    const host = makeHost();
    host.spawn("t-1", { cwd: "C:\\a", cols: 80, rows: 30 });
    host.spawn("t-2", { cwd: "C:\\a", cols: 80, rows: 30 });

    ctx.pty.processes[0].emitData("FROM_T1");
    ctx.pty.processes[1].emitData("FROM_T2");

    expect(ctx.sink.events.filter((e) => e.kind === "data")).toEqual([
      { terminalId: "t-1", kind: "data", payload: "FROM_T1" },
      { terminalId: "t-2", kind: "data", payload: "FROM_T2" },
    ]);
  });

  it("write/resize 定向：只命中目标进程，且尺寸钳到 ≥2", () => {
    const host = makeHost();
    host.spawn("t-1", { cwd: "C:\\a", cols: 80, rows: 30 });
    host.spawn("t-2", { cwd: "C:\\a", cols: 80, rows: 30 });

    expect(host.write("t-1", "dir\r")).toEqual({ ok: true });
    host.resize("t-2", 1, 1);

    expect(ctx.pty.processes[0].writes).toEqual(["dir\r"]);
    expect(ctx.pty.processes[1].writes).toEqual([]);
    expect(ctx.pty.processes[1].resizes).toEqual([{ cols: 2, rows: 2 }]);
    expect(ctx.pty.processes[0].resizes).toEqual([]);
  });

  it("kill 定向 + killAll：只杀目标；killAll 全停（应用退出路径）", () => {
    const host = makeHost();
    host.spawn("t-1", { cwd: "C:\\a", cols: 80, rows: 30 });
    host.spawn("t-2", { cwd: "C:\\a", cols: 80, rows: 30 });

    host.kill("t-1");
    expect(ctx.pty.processes[0].killed).toBe(true);
    expect(ctx.pty.processes[1].killed).toBe(false);
    expect(host.isRunning("t-1")).toBe(false);

    host.killAll();
    expect(ctx.pty.processes.every((p) => p.killed)).toBe(true);
  });

  it("进程退出：sink.exit 携带 terminalId，之后 write 失败、重复 kill 幂等", () => {
    const host = makeHost();
    host.spawn("t-1", { cwd: "C:\\a", cols: 80, rows: 30 });

    ctx.pty.processes[0].emitExit({ exitCode: 0 });
    expect(ctx.sink.events.find((e) => e.kind === "exit")).toMatchObject({
      terminalId: "t-1",
      payload: { exitCode: 0 },
    });
    expect(host.isRunning("t-1")).toBe(false);

    expect(host.write("t-1", "x")).toMatchObject({ ok: false });
    expect(host.write("ghost", "x")).toMatchObject({ ok: false });
    expect(() => host.kill("t-1")).not.toThrow();
  });

  it("spawn 失败：返回 ok:false + 可读信息，不产生 started 事件", () => {
    const host = makeHost();
    ctx.pty.failSpawn = true;

    const r = host.spawn("t-1", { cwd: "C:\\a", cols: 80, rows: 30 });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
    expect(ctx.sink.events.filter((e) => e.kind === "started")).toHaveLength(0);
    expect(host.isRunning("t-1")).toBe(false);
  });
});

describe("shell 与 command 解析（默认值不硬编码：config 覆盖 + where 探测）", () => {
  it("默认 shell 探测链：pwsh 未命中 → powershell.exe；-NoLogo 参数", () => {
    freshWhere({ "powershell.exe": "C:\\powershell.exe" });
    const host = makeHost();

    const r = host.spawn("t-1", { cwd: "C:\\a", cols: 80, rows: 30 });
    expect(r).toMatchObject({ ok: true, label: "powershell" });
    expect(ctx.pty.spawns[0].file).toBe("powershell.exe");
    expect(ctx.pty.spawns[0].args).toEqual(["-NoLogo"]);
  });

  it("config shell 覆盖优先于探测链", () => {
    freshWhere({ "pwsh.exe": "C:\\pwsh.exe" });
    const host = makeHost({ shellOverride: () => "C:\\sh\\myshell.exe" });

    host.spawn("t-1", { cwd: "C:\\a", cols: 80, rows: 30 });
    expect(ctx.pty.spawns[0].file).toBe("C:\\sh\\myshell.exe");
  });

  it("探测全部未命中：回退 powershell.exe", () => {
    const host = makeHost();
    const r = host.spawn("t-1", { cwd: "C:\\a", cols: 80, rows: 30 });
    expect(ctx.pty.spawns[0].file).toBe("powershell.exe");
    expect(r).toMatchObject({ ok: true });
  });

  it("command 模式：三 CLI config 覆盖命中 → 直接用配置路径（spec G：直连真实 exe）", () => {
    const host = makeHost({ cliExeOverride: (name) => (name === "claude" ? "C:\\tools\\claude.exe" : null) });

    const r = host.spawn("t-1", { cwd: "C:\\a", cols: 80, rows: 30, command: { exe: "claude", args: ["--model", "x"] } });
    expect(r).toMatchObject({ ok: true, label: "claude" });
    expect(ctx.pty.spawns[0].file).toBe("C:\\tools\\claude.exe");
    expect(ctx.pty.spawns[0].args).toEqual(["--model", "x"]);
  });

  it("command 模式：裸名经 where 探测到 .cmd → cmd.exe /d /c 包装（npm shim 形态，如 claude）", () => {
    freshWhere({ claude: ["C:\\npm\\claude", "C:\\npm\\claude.cmd", "C:\\npm\\claude.ps1"].join("\n") });
    const host = makeHost();

    const r = host.spawn("t-1", { cwd: "C:\\a", cols: 80, rows: 30, command: { exe: "claude", args: [] } });
    expect(r).toMatchObject({ ok: true, label: "claude" });
    expect(ctx.pty.spawns[0].file).toBe("cmd.exe");
    expect(ctx.pty.spawns[0].args).toEqual(["/d", "/c", "C:\\npm\\claude.cmd"]);
  });

  it("command 模式：where 探测到 .exe → 直接 spawn", () => {
    freshWhere({ opencode: "C:\\bin\\opencode.exe" });
    const host = makeHost();

    const r = host.spawn("t-1", { cwd: "C:\\a", cols: 80, rows: 30, command: { exe: "opencode", args: ["serve"] } });
    expect(r).toMatchObject({ ok: true, label: "opencode" });
    expect(ctx.pty.spawns[0].file).toBe("C:\\bin\\opencode.exe");
    expect(ctx.pty.spawns[0].args).toEqual(["serve"]);
  });

  it("command 模式：绝对路径直接用（含 .cmd 包装）；where 未命中 → ok:false", () => {
    const host = makeHost();

    const rAbs = host.spawn("t-1", { cwd: "C:\\a", cols: 80, rows: 30, command: { exe: "C:\\tools\\cli.cmd" } });
    expect(rAbs).toMatchObject({ ok: true });
    expect(ctx.pty.spawns[0].args).toEqual(["/d", "/c", "C:\\tools\\cli.cmd"]);

    const rMiss = host.spawn("t-2", { cwd: "C:\\a", cols: 80, rows: 30, command: { exe: "no-such-cli" } });
    expect(rMiss).toMatchObject({ ok: false });
  });
});

describe("cwd 解析与 spawn 选项", () => {
  it("cwd 不存在回退 USERPROFILE；空 cwd 回退；env 注入 TERM=xterm-256color", () => {
    const host = makeHost({ existsSync: (p) => p !== "C:\\gone" });

    const r1 = host.spawn("t-1", { cwd: "C:\\gone", cols: 80, rows: 30 });
    const r2 = host.spawn("t-2", { cwd: "  ", cols: 80, rows: 30 });

    expect(r1).toMatchObject({ ok: true, cwd: "C:\\home\\u" });
    expect(r2).toMatchObject({ ok: true, cwd: "C:\\home\\u" });
    const options = ctx.pty.spawns[0].options as { env?: Record<string, string>; name?: string; cols?: number; rows?: number };
    expect(options.env?.TERM).toBe("xterm-256color");
    expect(options.name).toBe("xterm-256color");
    expect(options.cols).toBe(80);
    expect(options.rows).toBe(30);
  });

  it("cols/rows 缺省/非法回退 80×30", () => {
    const host = makeHost();
    host.spawn("t-1", { cwd: "C:\\a", cols: 0, rows: NaN });
    const options = ctx.pty.spawns[0].options as { cols?: number; rows?: number };
    expect(options.cols).toBe(80);
    expect(options.rows).toBe(30);
  });
});
