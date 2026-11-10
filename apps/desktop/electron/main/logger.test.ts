// 用途：Logger 深模块密封单测（#53 spec #52 A/D/F/E 节，验收 3/4/5/6 + 崩溃兜底 + kind 映射表）—— fake fs / fake clock / fake console 隔离边界，不碰真实磁盘
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createLogger,
  registerCrashHandlers,
  resolveKindLog,
  type CrashTarget,
  type Logger,
  type LoggerConsole,
  type LoggerFs,
  type LoggingConfig,
} from "./logger";

/** 内存 fake fs：实现 Logger 磰 seam；fail* 开关注入可恢复的磁盘故障 */
class FakeFs implements LoggerFs {
  files = new Map<string, string>();
  dirs = new Set<string>();
  failMkdir = false;
  failAppend = false;
  failRename = false;
  appendCalls = 0;
  mkdirSync(path: string): void {
    if (this.failMkdir) throw new Error("EACCES: permission denied");
    this.dirs.add(path);
  }
  appendFileSync(path: string, data: string): void {
    this.appendCalls++;
    if (this.failAppend) throw new Error("ENOSPC: no space left");
    this.files.set(path, (this.files.get(path) ?? "") + data);
  }
  existsSync(path: string): boolean {
    return this.files.has(path);
  }
  readdirSync(path: string): string[] {
    const names = new Set<string>();
    for (const f of this.files.keys()) if (dirname(f) === path) names.add(basename(f));
    return [...names];
  }
  statSync(path: string): { size: number } {
    return { size: Buffer.byteLength(this.files.get(path) ?? "", "utf8") };
  }
  unlinkSync(path: string): void {
    if (!this.files.delete(path)) throw new Error(`ENOENT: ${path}`);
  }
  renameSync(from: string, to: string): void {
    if (this.failRename) throw new Error("EPERM: rename failed");
    const content = this.files.get(from);
    if (content === undefined) throw new Error(`ENOENT: ${from}`);
    this.files.set(to, content);
    this.files.delete(from);
  }
}

/** 固定本地时间 2026-01-02 03:04:05 的 fake clock（文件名用本地时间，构造与读取同口径故确定） */
function makeClock(): { now: () => Date; set: (d: Date) => void } {
  let at = new Date(2026, 0, 2, 3, 4, 5);
  return { now: () => at, set: (d: Date) => (at = d) };
}

const PID = 4242;
const DIR = join("C:", "userData", "logs");

interface Bench {
  fs: FakeFs;
  con: { log: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  clock: ReturnType<typeof makeClock>;
  logger: Logger;
}

/** 组装被测 Logger：fake fs/console/clock + pid 注入（at 可指定创建时刻） */
function bench(logging?: Partial<LoggingConfig>, at?: Date): Bench {
  const fs = new FakeFs();
  const con = { log: vi.fn<(line: string) => void>(), error: vi.fn<(line: string) => void>() };
  const clock = makeClock();
  if (at) clock.set(at);
  const logger = createLogger({
    dir: DIR,
    logging: { level: "info", maxFileBytes: 5_000_000, retainRuns: 10, maxMessageChars: 2000, ...logging },
    now: clock.now,
    pid: PID,
    fs,
    console: con as unknown as LoggerConsole,
  });
  return { fs, con, clock, logger };
}

/** 读 JSONL 文件为条目数组 */
function readEntries(fs: FakeFs, path: string): Array<Record<string, unknown>> {
  const content = fs.files.get(path) ?? "";
  return content
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const MAIN = join(DIR, `20260102-030405-${PID}.jsonl`);

describe("按启动建文件与首条写入（验收 4）", () => {
  it("文件名 = YYYYMMDD-HHmmss-<pid>.jsonl；条目 JSONL 形状：ts/level/source=main/scope/message；写入走 appendFileSync（无常驻 fd）", () => {
    const { fs, logger } = bench();
    logger.log("warn", "cli-host", "hello");
    expect(fs.files.has(MAIN)).toBe(true);
    const [entry] = readEntries(fs, MAIN);
    expect(entry).toMatchObject({ level: "warn", source: "main", scope: "cli-host", message: "hello" });
    const ts = entry.ts;
    expect(typeof ts === "string" && ts.length > 0).toBe(true);
    expect(fs.appendCalls).toBe(1);
  });

  it("每次启动一份文件：不同时刻（新 Date）创建 → 不同文件名", () => {
    const a = bench();
    a.logger.log("info", "s", "run-a");
    const b = bench(undefined, new Date(2026, 0, 2, 3, 4, 6));
    b.logger.log("info", "s", "run-b");
    expect(a.fs.files.has(MAIN)).toBe(true);
    expect(b.fs.files.has(join(DIR, `20260102-030406-${PID}.jsonl`))).toBe(true);
  });

  it("#55：可选 source 参数写入条目来源（renderer/worker 经 Main 入口强制传入），缺省仍为 main", () => {
    const { fs, logger } = bench();
    logger.log("warn", "chat", "来自 renderer 的条目", { sessionId: "run-1" }, "renderer");
    logger.log("warn", "cli-host", "来自 worker 的条目", undefined, "worker");
    logger.log("warn", "main", "未声明来源的条目");
    const sources = readEntries(fs, MAIN).map((e) => e.source);
    expect(sources).toEqual(["renderer", "worker", "main"]);
  });

  it("currentFilePath 指向主文件（getLogPath/openLogDir 数据源；分片不作为对外路径）", () => {
    const { logger } = bench();
    expect(logger.currentFilePath).toBe(MAIN);
  });
});

describe("级别过滤（验收 5，spec Q4/Q5）", () => {
  it("默认 info：debug 条目文件与控制台均不出现；error/warn/info 出现", () => {
    const { fs, con, logger } = bench();
    logger.log("debug", "s", "dbg");
    logger.log("info", "s", "inf");
    logger.log("warn", "s", "wrn");
    logger.log("error", "s", "err");
    const levels = readEntries(fs, MAIN).map((e) => e.level);
    expect(levels).toEqual(["info", "warn", "error"]);
    expect(con.log).toHaveBeenCalledTimes(1); // info
    expect(con.error).toHaveBeenCalledTimes(2); // warn + error
  });

  it("生效级别 debug：debug 条目落盘 + 控制台可见", () => {
    const { fs, con, logger } = bench({ level: "debug" });
    logger.log("debug", "s", "dbg");
    const [entry] = readEntries(fs, MAIN);
    expect(entry.level).toBe("debug");
    expect(con.log).toHaveBeenCalledTimes(1);
  });

  it("生效级别 error：仅 error 条目通过", () => {
    const { fs, logger } = bench({ level: "error" });
    logger.log("warn", "s", "w");
    logger.log("error", "s", "e");
    const levels = readEntries(fs, MAIN).map((e) => e.level);
    expect(levels).toEqual(["error"]);
  });
});

describe("单条截断（验收 5，spec Q8/US11）", () => {
  it("message 超 maxMessageChars 截断到上限；console 行同步截断", () => {
    const { fs, con, logger } = bench({ maxMessageChars: 10 });
    const long = "0123456789ABCDEF";
    logger.log("info", "s", long);
    const [entry] = readEntries(fs, MAIN);
    expect(entry.message).toBe("0123456789");
    expect(con.log).toHaveBeenCalledWith(expect.stringContaining("0123456789"));
    expect(con.log).not.toHaveBeenCalledWith(expect.stringContaining("ABCDEF"));
  });

  it("截断上限经 start 应用最终配置后生效", () => {
    const { fs, logger } = bench();
    logger.start({ level: "info", maxFileBytes: 5_000_000, retainRuns: 10, maxMessageChars: 4 }, {
      app: "Kanban Desktop", electron: "44.10.2", node: "22.0.0", chrome: "130.0.0",
      platform: "win32", cliExeOverridden: { codex: false, claude: false, opencode: false },
    });
    logger.log("info", "s", "abcdefgh");
    const entries = readEntries(fs, MAIN);
    expect(entries[entries.length - 1].message).toBe("abcd");
  });

  it("ctx 各字符串值同样按 maxMessageChars 截断（单条日志整体按上限截断，#53 AC/US11）；数值/布尔原样", () => {
    const { fs, logger } = bench({ maxMessageChars: 10 });
    logger.log("warn", "cli-host", "m", { detail: "0123456789ABCDEF", attempt: 3, ok: false });
    const [entry] = readEntries(fs, MAIN);
    expect(entry.ctx).toEqual({ detail: "0123456789", attempt: 3, ok: false });
  });
});

describe("控制台纯文本双写（验收 4/spec US17）", () => {
  it("行格式 [ts] [level] (scope) message + ctx JSON 后缀；error/warn → console.error（stderr），info/debug → console.log", () => {
    const { con, logger } = bench({ level: "debug" });
    logger.log("warn", "cli-host", "告警文本", { code: "E_SPAWN_NOT_FOUND" });
    expect(con.error).toHaveBeenCalledTimes(1);
    const line = con.error.mock.calls[0][0];
    expect(line).toMatch(/^\[.*\] \[warn\] \(cli-host\) 告警文本 \{"code":"E_SPAWN_NOT_FOUND"\}$/);
    logger.log("info", "main", "普通");
    expect(con.log).toHaveBeenCalledWith(expect.stringMatching(/^\[.*\] \[info\] \(main\) 普通$/));
  });

  it("ctx 落盘为标量 Record；空 ctx 不落键", () => {
    const { fs, logger } = bench();
    logger.log("error", "s", "m", { sessionId: "s-1", retry: 2, ok: false });
    logger.log("info", "s", "m2", {});
    const entries = readEntries(fs, MAIN);
    expect(entries[0].ctx).toEqual({ sessionId: "s-1", retry: 2, ok: false });
    expect(entries[1].ctx).toBeUndefined();
  });
});

describe("child 派生与启动横幅（验收 4，spec D 节）", () => {
  it("child(scope) 固定 scope 直写", () => {
    const { fs, logger } = bench();
    logger.child("residue").log("error", "检测失败");
    const [entry] = readEntries(fs, MAIN);
    expect(entry).toMatchObject({ level: "error", scope: "residue", message: "检测失败" });
  });

  it("正常路径横幅严格首条：info + 全字段（版本/平台/pid/生效级别/三 CLI exe 覆盖布尔）", () => {
    const { fs, logger } = bench();
    logger.start({ level: "debug", maxFileBytes: 5_000_000, retainRuns: 10, maxMessageChars: 2000 }, {
      app: "Kanban Desktop", electron: "44.10.2", node: "22.1.0", chrome: "130.2.0",
      platform: "win32", cliExeOverridden: { codex: true, claude: false, opencode: false },
    });
    logger.log("info", "s", "横幅之后");
    const entries = readEntries(fs, MAIN);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ level: "info", source: "main", scope: "main", message: "启动横幅" });
    expect(entries[0].ctx).toEqual({
      app: "Kanban Desktop", electron: "44.10.2", node: "22.1.0", chrome: "130.2.0",
      platform: "win32", pid: PID, level: "debug", cliCodex: true, cliClaude: false, cliOpencode: false,
    });
  });

  it("启动早期（start 前）异常条目先落盘，横幅随后（取证路径，spec A 节无就绪前缓冲）", () => {
    const { fs, logger } = bench();
    logger.log("error", "crash", "启动早期失败");
    logger.start({ level: "info", maxFileBytes: 5_000_000, retainRuns: 10, maxMessageChars: 2000 }, {
      app: "a", electron: "e", node: "n", chrome: "c", platform: "p",
      cliExeOverridden: { codex: false, claude: false, opencode: false },
    });
    const entries = readEntries(fs, MAIN);
    expect(entries[0]).toMatchObject({ level: "error", message: "启动早期失败" });
    expect(entries[1].message).toBe("启动横幅");
  });
});

describe("大小切分（验收 6，spec Q6/US23）", () => {
  /** 构造单条约 120 字节的条目 */
  const pad = (n: number): string => `m${n}-`.padEnd(60, "x");

  it("主文件超 maxFileBytes → 续写 .1，再超 → .2；主文件保留早期内容；currentFilePath 不变；无残留分片时轮转不误报写失败", () => {
    const { fs, con, logger } = bench({ maxFileBytes: 300 });
    for (let i = 0; i < 5; i++) logger.log("info", "s", pad(i));
    // 每条约 120B：主文件 3 条后超 300 → 第 4 条起进 .1
    const mainEntries = readEntries(fs, MAIN);
    expect(mainEntries).toHaveLength(3);
    const slice1 = readEntries(fs, `${MAIN}.1`);
    expect(slice1.map((e) => e.message)).toEqual([pad(3), pad(4)]);
    expect(logger.currentFilePath).toBe(MAIN);
    // .1/.2 本不存在（首切）——预期内的 ENOENT 清理不得消耗「只报一次」的失败告警
    expect(con.error).not.toHaveBeenCalled();
  });

  it(".2 满后滚动：丢最旧分片 .1、.2 升 .1、续写新 .2；主→.1→.2 拼接保持到达顺序（丢弃窗口除外）", () => {
    const { fs, logger } = bench({ maxFileBytes: 300 });
    for (let i = 0; i < 9; i++) logger.log("info", "s", pad(i));
    // 主 3 条 + .1 3 条 + .2 3 条后滚动：.1(旧 .2 内容 idx6-8) 保留、新 .2 接 idx9
    logger.log("info", "s", pad(9));
    const mainEntries = readEntries(fs, MAIN);
    const s1 = readEntries(fs, `${MAIN}.1`);
    const s2 = readEntries(fs, `${MAIN}.2`);
    expect(mainEntries.map((e) => e.message)).toEqual([pad(0), pad(1), pad(2)]);
    // 滚动后 .1 = 第二窗口（idx3-5 被丢弃），.2 = 最新窗口
    expect(s1.map((e) => e.message)).toEqual([pad(6), pad(7), pad(8)]);
    expect(s2.map((e) => e.message)).toEqual([pad(9)]);
    // 全量拼接按到达顺序（被滚动丢弃的窗口除外；C 类按 pid 合并分片的口径依据）
    expect([...mainEntries, ...s1, ...s2].map((e) => e.message)).toEqual([
      pad(0), pad(1), pad(2), pad(6), pad(7), pad(8), pad(9),
    ]);
  });
});

describe("保留清理（验收 6，spec Q6/US24）", () => {
  it("超 retainRuns 的旧启动组按组清理（主文件+分片一起）；保留组与当前组不动", () => {
    const fs = new FakeFs();
    const con = { log: vi.fn<(line: string) => void>(), error: vi.fn<(line: string) => void>() };
    // 预置 4 个旧启动组（含分片）+ 1 个无关文件
    for (const g of ["20250101-000000-111", "20250102-000000-222", "20250103-000000-333", "20250104-000000-444"]) {
      fs.files.set(join(DIR, `${g}.jsonl`), "{}\n");
      fs.files.set(join(DIR, `${g}.jsonl.1`), "{}\n");
    }
    fs.files.set(join(DIR, "notes.txt"), "keep me");
    const logger = createLogger({
      dir: DIR,
      logging: { level: "info", maxFileBytes: 5_000_000, retainRuns: 2, maxMessageChars: 2000 },
      now: makeClock().now,
      pid: PID,
      fs,
      console: con as unknown as LoggerConsole,
    });
    logger.log("info", "s", "本次运行");
    // 保留最近 2 组（0103/0104）+ 当前组；0101/0102 主文件+分片整体删除；无关文件不动
    expect(fs.files.has(join(DIR, "20250101-000000-111.jsonl"))).toBe(false);
    expect(fs.files.has(join(DIR, "20250101-000000-111.jsonl.1"))).toBe(false);
    expect(fs.files.has(join(DIR, "20250102-000000-222.jsonl"))).toBe(false);
    expect(fs.files.has(join(DIR, "20250103-000000-333.jsonl"))).toBe(true);
    expect(fs.files.has(join(DIR, "20250104-000000-444.jsonl.1"))).toBe(true);
    expect(fs.files.has(join(DIR, "notes.txt"))).toBe(true);
    expect(fs.files.has(MAIN)).toBe(true);
  });

  it("start 应用最终 retainRuns 后重跑清理（用户调小立即生效）", () => {
    const { fs, logger } = bench({ retainRuns: 10 });
    for (const g of ["20250101-000000-111", "20250102-000000-222", "20250103-000000-333"]) {
      fs.files.set(join(DIR, `${g}.jsonl`), "{}\n");
    }
    expect(fs.files.has(join(DIR, "20250101-000000-111.jsonl"))).toBe(true); // 创建时按默认 10 未清
    logger.start({ level: "info", maxFileBytes: 5_000_000, retainRuns: 2, maxMessageChars: 2000 }, {
      app: "a", electron: "e", node: "n", chrome: "c", platform: "p",
      cliExeOverridden: { codex: false, claude: false, opencode: false },
    });
    expect(fs.files.has(join(DIR, "20250101-000000-111.jsonl"))).toBe(false);
    expect(fs.files.has(join(DIR, "20250102-000000-222.jsonl"))).toBe(true);
  });
});

describe("写失败自保护（验收 6，spec I 节/N6）", () => {
  it("mkdir 抛错：createLogger 不抛、log 不抛、控制台退回可见且只报一次", () => {
    const fs = new FakeFs();
    fs.failMkdir = true;
    const con = { log: vi.fn<(line: string) => void>(), error: vi.fn<(line: string) => void>() };
    let logger: Logger;
    expect(() => {
      logger = createLogger({
        dir: DIR, logging: { level: "info", maxFileBytes: 5_000_000, retainRuns: 10, maxMessageChars: 2000 },
        now: makeClock().now, pid: PID, fs, console: con as unknown as LoggerConsole,
      });
    }).not.toThrow();
    expect(() => logger.log("error", "s", "条目一")).not.toThrow();
    expect(() => logger.log("error", "s", "条目二")).not.toThrow();
    // 条目本身仍控制台可见（error → console.error）+ 失败告警恰好一次（不递归、不刷屏）
    expect(con.error).toHaveBeenCalledTimes(3);
    expect(con.error.mock.calls[0][0]).toContain("日志文件写入失败");
    expect(con.error.mock.calls.filter((c) => c[0].includes("日志文件写入失败"))).toHaveLength(1);
  });

  it("append 抛错：不向调用方抛；恢复后重新落盘（恢复前的条目仅控制台）", () => {
    const { fs, con, logger } = bench();
    logger.log("info", "s", "正常条目");
    fs.failAppend = true;
    expect(() => logger.log("info", "s", "失败条目")).not.toThrow();
    expect(con.error).toHaveBeenCalledTimes(1); // 失败告警一次
    fs.failAppend = false;
    logger.log("info", "s", "恢复条目");
    const messages = readEntries(fs, MAIN).map((e) => e.message);
    expect(messages).toEqual(["正常条目", "恢复条目"]); // 失败条目不落盘（仅控制台），恢复后无空窗
  });

  it("轮转切片不重置报错计数：写失败一次后，轮转 rename 再失败不再新增告警", () => {
    const { fs, con, logger } = bench({ maxFileBytes: 1 });
    logger.log("info", "s", "触发切分"); // 成功写入后立即超限 → 轮转（.1/.2 不存在，ENOENT 静默）
    fs.failAppend = true;
    expect(() => logger.log("info", "s", "写失败")).not.toThrow();
    expect(con.error.mock.calls.filter((c) => c[0].includes("日志文件写入失败"))).toHaveLength(1);
    fs.failAppend = false;
    fs.failRename = true;
    logger.log("info", "s", "再写满一层");
    logger.log("info", "s", "触发滚动 rename 失败");
    expect(con.error.mock.calls.filter((c) => c[0].includes("日志文件写入失败"))).toHaveLength(1); // 仍只一次
  });
});

describe("Main 崩溃兜底（验收 8，spec F 节/Q10）", () => {
  /** 收集监听器的 fake process */
  function fakeTarget(): { handlers: Record<string, (v: unknown) => void>; target: CrashTarget } {
    const handlers: Record<string, (v: unknown) => void> = {};
    const target = {
      on: (event: string, listener: (v: unknown) => void): unknown => {
        handlers[event] = listener;
        return undefined;
      },
    };
    return { handlers, target: target as unknown as CrashTarget };
  }

  it("uncaughtException：记一条 error 后按崩溃语义退出（exit(1)），不二次抛出", () => {
    const { handlers, target } = fakeTarget();
    const logged: Array<{ level: string; scope: string; message: string }> = [];
    const exit = vi.fn<(code: number) => void>();
    registerCrashHandlers(target, { log: (level, scope, message) => logged.push({ level, scope, message }) }, exit);
    expect(() => handlers.uncaughtException(new Error("boom"))).not.toThrow();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: "error", scope: "crash" });
    expect(logged[0].message).toContain("boom");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("unhandledRejection：记一条 error 后退出（对齐 uncaughtException；基线无处理器时 Node≥15/Electron 默认升格为未捕获异常退出），exit(1)、不二次抛出", () => {
    const { handlers, target } = fakeTarget();
    const logged: Array<{ level: string; message: string }> = [];
    const exit = vi.fn<(code: number) => void>();
    registerCrashHandlers(target, { log: (level, _scope, message) => logged.push({ level, message }) }, exit);
    expect(() => handlers.unhandledRejection(new Error("rejected"))).not.toThrow();
    expect(logged).toHaveLength(1);
    expect(logged[0].level).toBe("error");
    expect(logged[0].message).toContain("rejected");
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("kind→level/scope 集中映射表（验收 9，spec E 节）", () => {
  it("spec 点名 kind：stderr→warn、dead/parse-error→error、shutdown/restore→info、job-guard→warn", () => {
    expect(resolveKindLog("stderr")).toEqual({ level: "warn", scope: "cli-host" });
    expect(resolveKindLog("dead")).toEqual({ level: "error", scope: "cli-host" });
    expect(resolveKindLog("parse-error")).toEqual({ level: "error", scope: "cli-host" });
    expect(resolveKindLog("shutdown")).toEqual({ level: "info", scope: "lifecycle" });
    expect(resolveKindLog("restore")).toEqual({ level: "info", scope: "lifecycle" });
    expect(resolveKindLog("job-guard")).toEqual({ level: "warn", scope: "cli-host" });
  });

  it("未命中表的 kind 缺省 debug + cli-host scope（新增 kind 无需改表，消解 hand-synced list）", () => {
    expect(resolveKindLog("brand-new-kind")).toEqual({ level: "debug", scope: "cli-host" });
  });

  it("#54 新增 kind：command-failed/worker-exit→error、worker-exit-pending→warn（scope 归 cli-host）", () => {
    expect(resolveKindLog("command-failed")).toEqual({ level: "error", scope: "cli-host" });
    expect(resolveKindLog("worker-exit")).toEqual({ level: "error", scope: "cli-host" });
    expect(resolveKindLog("worker-exit-pending")).toEqual({ level: "warn", scope: "cli-host" });
  });
});

describe("条目 source 按入口强制（#54 spec #52 C 节）", () => {
  it("log 第 5 参指定 source=worker（worker {log} 分派 / 进程内 CLI stderr 口径）；缺省仍为 main", () => {
    const { fs, logger } = bench();
    logger.log("warn", "cli-host", "来自 worker 的 stderr", undefined, "worker");
    logger.log("info", "main", "来自 Main 的直写");
    const entries = readEntries(fs, MAIN);
    expect(entries[0]).toMatchObject({ source: "worker", message: "来自 worker 的 stderr" });
    expect(entries[1]).toMatchObject({ source: "main", message: "来自 Main 的直写" });
  });
});
