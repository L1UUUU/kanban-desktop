// 用途：Main 侧唯一日志深模块（spec #52 A 节）—— 级别过滤、单条截断、JSONL 落盘、控制台纯文本双写、按启动建文件、启动横幅、大小切分、保留清理、写失败自保护与崩溃兜底；四来源（Main/worker/Renderer/CLI stderr）诊断事件唯一汇聚点
import { mkdirSync, appendFileSync, existsSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { LOG_LEVELS, type LogCtx, type LogLevel, type LogSource } from "@kanban/ipc-schema";

// 枚举与 ctx 类型单源（main→ipc-schema，方向先例 log-write.ts）：@kanban/ipc-schema 是 wire 契约唯一来源，此处 re-export 维持 main 内既有 import 路径
export { LOG_LEVELS };
export type { LogCtx, LogLevel, LogSource };

/** 级别严重度序（数值越小越严重；条目级别 ≤ 生效级别才记录） */
const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** logging 配置节（config.logging 四项，spec #52 D 节） */
export interface LoggingConfig {
  /** 生效级别（config 值或 KANBAN_LOG_LEVEL env 覆盖后的 effectiveLevel） */
  level: LogLevel;
  /** 单文件字节上限（超出切轮转分片） */
  maxFileBytes: number;
  /** 保留的最近启动组数（主文件+分片一起清理） */
  retainRuns: number;
  /** 单条字符上限（message 与 ctx 各字符串值超出截断，防大段 CLI 输出冲爆文件） */
  maxMessageChars: number;
}

/** 单条日志写入函数形状（Logger.log 的独立引用形态；ipc/adapter-events 等 deps 注入用） */
export type LogFn = (level: LogLevel, scope: string, message: string, ctx?: LogCtx) => void;

/** 固定 scope 的子记录器（child 产物：log 免 scope 直写） */
export interface ScopedLogger {
  log(level: LogLevel, message: string, ctx?: LogCtx): void;
}

/** 日志文件系统操作 seam（A 类测试注入 fake fs；生产为 node:fs） */
export interface LoggerFs {
  mkdirSync(path: string, options: { recursive: true }): void;
  appendFileSync(path: string, data: string): void;
  existsSync(path: string): boolean;
  readdirSync(path: string): string[];
  statSync(path: string): { size: number };
  unlinkSync(path: string): void;
  renameSync(from: string, to: string): void;
}

/** 控制台双写 seam（A 类测试注入 fake console；error/warn 走 stderr 语义的 console.error） */
export interface LoggerConsole {
  log(message: string): void;
  error(message: string): void;
}

/** 启动横幅数据（spec #52 D 节：版本/平台/pid/三 CLI exe 覆盖布尔；生效级别与文件路径由 Logger 自身补齐） */
export interface BannerInfo {
  app: string;
  electron: string;
  node: string;
  chrome: string;
  platform: string;
  /** 三 CLI exe 是否被 config 手动覆盖（不记路径值以外的内容） */
  cliExeOverridden: { codex: boolean; claude: boolean; opencode: boolean };
}

export interface LoggerOptions {
  /** 日志目录（装配层决定 = <userData>/logs；KANBAN_USER_DATA 隔离天然覆盖） */
  dir: string;
  /** 初始 logging 配置（二实例守卫后、config 加载前用默认值创建；config 加载后经 start 应用最终值） */
  logging: LoggingConfig;
  /** 时钟注入（A 类 fake clock；缺省系统时间） */
  now?(): Date;
  /** 进程 pid 注入（缺省 process.pid；文件名与横幅使用） */
  pid?: number;
  /** fs seam（A 类 fake fs；缺省 node:fs） */
  fs?: LoggerFs;
  /** 控制台 seam（A 类 fake console；缺省全局 console） */
  console?: LoggerConsole;
}

export interface Logger {
  /** 写一条日志：级别过滤 → 截断 → JSONL 落盘 + 控制台纯文本双写（source 缺省 main；worker/renderer 条目由对应 Main 装配入口强制传入，不信上游自报） */
  log(level: LogLevel, scope: string, message: string, ctx?: LogCtx, source?: LogSource): void;
  /** 派生固定 scope 的子记录器 */
  child(scope: string): ScopedLogger;
  /** 本次启动主文件绝对路径（含横幅；轮转分片不作为对外路径，M9） */
  readonly currentFilePath: string;
  /** 应用最终 logging 配置并写启动横幅（首条 info）：config 加载、算出生效级别后调用一次；调用前按创建参数工作（早期崩溃取证不缓冲） */
  start(logging: LoggingConfig, banner: BannerInfo): void;
}

/** JSONL 单条落盘形状（ts 由 Main 生成；source 按入口强制写入） */
interface LogEntry {
  ts: string;
  level: LogLevel;
  source: LogSource;
  scope: string;
  message: string;
  ctx?: LogCtx;
}

/** 文件名主体：YYYYMMDD-HHmmss-<pid>（本地时间；同次启动共用，轮转分片挂 .1/.2 后缀） */
function runFileStem(at: Date, pid: number): string {
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return `${at.getFullYear()}${p2(at.getMonth() + 1)}${p2(at.getDate())}-${p2(at.getHours())}${p2(at.getMinutes())}${p2(at.getSeconds())}-${pid}`;
}

const RUN_FILE_RE = /^(\d{8}-\d{6}-\d+)\.jsonl(?:\.\d+)?$/;

/** 创建 Logger：建目录（best-effort）、定启动文件名、按 retainRuns 清理旧启动组；文件写入惰性到首条 log（横幅之前异常条目也直接落盘，无就绪前缓冲） */
export function createLogger(options: LoggerOptions): Logger {
  const fs = options.fs ?? {
    mkdirSync: (p: string, o: { recursive: true }) => mkdirSync(p, o),
    appendFileSync: (p: string, d: string) => appendFileSync(p, d),
    existsSync: (p: string) => existsSync(p),
    readdirSync: (p: string) => readdirSync(p),
    statSync: (p: string) => statSync(p),
    unlinkSync: (p: string) => unlinkSync(p),
    renameSync: (f: string, t: string) => renameSync(f, t),
  };
  const con = options.console ?? { log: (m: string) => console.log(m), error: (m: string) => console.error(m) };
  const now = options.now ?? ((): Date => new Date());
  const pid = options.pid ?? process.pid;

  let logging = options.logging;
  const runId = runFileStem(now(), pid);
  const mainPath = join(options.dir, `${runId}.jsonl`);
  // 轮转状态：0=主文件，1/2=同次运行续写分片（.1/.2）
  let slice = 0;
  let bytes = 0;
  // 写失败自保护：不向调用方抛、不递归；退回 console 只报一次；轮转不重置计数（N6）
  let failureReported = false;

  /** fs 失败统一收口：首个失败向 console 报一次（不经过 Logger 自身 → 无递归） */
  const guardFs = (op: () => void): void => {
    try {
      op();
    } catch (e) {
      if (!failureReported) {
        failureReported = true;
        con.error(`[kanban:log] 日志文件写入失败（后续仅控制台输出，恢复后自动重新落盘）：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  /** 预期内可能不存在的清理/探测（残留分片、保留组文件、分片 stat）：静默吞错，不消耗「只报一次」的失败告警 */
  const swallow = (op: () => void): void => {
    try {
      op();
    } catch {
      // 丢弃
    }
  };

  const slicePath = (idx: number): string => (idx === 0 ? mainPath : `${mainPath}.${idx}`);

  /** 按 retainRuns 清理旧启动组（主文件+全部分片一起删留；当前组恒留） */
  const cleanupRetain = (): void => {
    guardFs(() => {
      const groups = new Map<string, string[]>();
      for (const name of fs.readdirSync(options.dir)) {
        const m = RUN_FILE_RE.exec(name);
        if (!m) continue;
        const list = groups.get(m[1]) ?? [];
        list.push(name);
        groups.set(m[1], list);
      }
      const keep = new Set([...groups.keys()].sort().slice(-logging.retainRuns));
      keep.add(runId); // 当前运行组恒留（防御时钟回拨/并列）
      for (const [groupId, files] of groups) {
        if (keep.has(groupId)) continue;
        for (const f of files) swallow(() => fs.unlinkSync(join(options.dir, f)));
      }
    });
  };

  guardFs(() => fs.mkdirSync(options.dir, { recursive: true }));
  cleanupRetain();

  /** 当前分片超上限后的推进：主→.1（首切，防御清同名残留分片）；.1→.2；.2 满则滚动（丢最旧 .1、.2 升 .1、续写新 .2），恒保 主→.1→.2 到达顺序 */
  const advanceSlice = (): void => {
    if (slice === 0) {
      swallow(() => fs.unlinkSync(slicePath(2)));
      swallow(() => fs.unlinkSync(slicePath(1)));
      slice = 1;
    } else if (slice === 1) {
      slice = 2;
    } else {
      swallow(() => fs.unlinkSync(slicePath(1)));
      guardFs(() => fs.renameSync(slicePath(2), slicePath(1))); // 真实 fs 故障 → 计入只报一次
    }
    let size = 0;
    swallow(() => {
      if (fs.existsSync(slicePath(slice))) size = fs.statSync(slicePath(slice)).size;
    });
    bytes = size;
  };

  const writeEntry = (entry: LogEntry): void => {
    // 控制台纯文本双写：error/warn 走 console.error（stderr，packaged-smoke 断言文本保留），info/debug 走 console.log
    const ctxSuffix = entry.ctx ? ` ${JSON.stringify(entry.ctx)}` : "";
    const line = `[${entry.ts}] [${entry.level}] (${entry.scope}) ${entry.message}${ctxSuffix}`;
    if (entry.level === "error" || entry.level === "warn") con.error(line);
    else con.log(line);
    // JSONL 落盘：每行一条，带换行的 CLI stderr 不打断记录
    const payload = `${JSON.stringify(entry)}\n`;
    const target = slicePath(slice);
    let appended = false;
    guardFs(() => {
      fs.appendFileSync(target, payload);
      appended = true;
    });
    if (appended) {
      bytes += Buffer.byteLength(payload, "utf8");
      if (bytes > logging.maxFileBytes) advanceSlice();
    }
  };

  const logger: Logger = {
    log(level, scope, message, ctx, source) {
      if (LEVEL_ORDER[level] > LEVEL_ORDER[logging.level]) return; // 级别过滤（文件与控制台同口径）
      // 单条截断（US11）：message 与 ctx 各字符串值同口径按 maxMessageChars 截断（数值/布尔原样），防大段输出冲爆文件
      const truncate = (s: string): string => (s.length > logging.maxMessageChars ? s.slice(0, logging.maxMessageChars) : s);
      const entry: LogEntry = { ts: now().toISOString(), level, source: source ?? "main", scope, message: truncate(message) };
      if (ctx && Object.keys(ctx).length > 0) {
        const ctxOut: LogCtx = {};
        for (const [k, v] of Object.entries(ctx)) ctxOut[k] = typeof v === "string" ? truncate(v) : v;
        entry.ctx = ctxOut;
      }
      writeEntry(entry);
    },
    child(scope) {
      return {
        log: (level, message, ctx) => logger.log(level, scope, message, ctx),
      };
    },
    currentFilePath: mainPath,
    start(finalLogging, banner) {
      logging = finalLogging;
      cleanupRetain(); // 用户 retainRuns 生效（创建时按默认值清过一次）
      const ctx: LogCtx = {
        app: banner.app,
        electron: banner.electron,
        node: banner.node,
        chrome: banner.chrome,
        platform: banner.platform,
        pid,
        level: logging.level,
        cliCodex: banner.cliExeOverridden.codex,
        cliClaude: banner.cliExeOverridden.claude,
        cliOpencode: banner.cliExeOverridden.opencode,
      };
      logger.log("info", "main", "启动横幅", ctx);
    },
  };
  return logger;
}

/** 崩溃兜底注册目标（生产传 process；A 类测试注入 fake 收集监听器） */
export interface CrashTarget {
  on(event: "uncaughtException", listener: (error: unknown) => void): unknown;
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
}

/**
 * Main 崩溃兜底（spec #52 F 节）：未捕获异常/未处理 rejection 各记一条 error 后按既有崩溃语义退出（exit 注入，生产传 app.exit）。
 * unhandledRejection 与 uncaughtException 同口径：基线（引入本模块前）无任何 process.on 处理器，Node≥15/Electron 默认将未处理 rejection 升格为未捕获异常致进程退出，兜底只补取证不改变致命性。
 * 仅首实例注册（装配层在二实例守卫 return 之后调用）。
 */
export function registerCrashHandlers(target: CrashTarget, logger: Pick<Logger, "log">, exit: (code: number) => void): void {
  const describe = (v: unknown): string => (v instanceof Error ? `${v.message}\n${v.stack ?? ""}` : String(v));
  target.on("uncaughtException", (error) => {
    logger.log("error", "crash", `未捕获异常：${describe(error)}`);
    exit(1);
  });
  target.on("unhandledRejection", (reason) => {
    logger.log("error", "crash", `未处理 Promise rejection：${describe(reason)}`);
    exit(1);
  });
}

/** kind→level/scope 集中映射表（spec #52 E 节，Main 唯一一份；worker 只上报 raw kind） */
const KIND_LOG_MAP: Record<string, { level: LogLevel; scope: string }> = {
  stderr: { level: "warn", scope: "cli-host" },
  "server-stderr": { level: "warn", scope: "cli-host" },
  dead: { level: "error", scope: "cli-host" },
  "server-dead": { level: "error", scope: "cli-host" },
  "parse-error": { level: "error", scope: "cli-host" },
  "init-error": { level: "error", scope: "cli-host" },
  shutdown: { level: "info", scope: "lifecycle" },
  restore: { level: "info", scope: "lifecycle" },
  "job-guard": { level: "warn", scope: "cli-host" },
  "command-failed": { level: "error", scope: "cli-host" },
  "worker-exit": { level: "error", scope: "cli-host" },
  "worker-exit-pending": { level: "warn", scope: "cli-host" },
};

/** kind 查表（cli-host `log(kind, detail)` 回调 / worker {log} 消息共用）：未命中缺省 debug（新增 kind 无需改表），scope 归 cli-host */
export function resolveKindLog(kind: string): { level: LogLevel; scope: string } {
  return KIND_LOG_MAP[kind] ?? { level: "debug", scope: "cli-host" };
}
