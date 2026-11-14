// 用途：一次性子进程执行器（arch C3）—— runTitleOneShot（title-summarize）与 RunOnceRunner.run（host/run-once）共用的 spawn 直连骨架，
// 单源持有 Windows 坑位清单：shell:false + windowsHide + env 全量透传、stdin 注入后 end、超时 kill 记 verdict、close（而非 exit）收口、
// stderr 留痕 slice(0,400)；两消费方差异（超时值、stdin 可选、输出封顶、日志标签、取消注册表）经参数/返回 handle 注入，不塞开关堆
import { spawn, type ChildProcess } from "node:child_process";
import type { LogKind } from "@kanban/ipc-schema";

/** stderr 留痕单 chunk 上限（防单条日志刷屏；两消费方同款口径） */
const STDERR_LOG_SLICE = 400;

export interface OneShotSpawnOptions {
  /** spawn 直连目标（各消费方 exe 解析链产物；真实 exe，不经 shell） */
  exe: string;
  /** 命令行参数（原样传递） */
  args: string[];
  /** 子进程工作目录 */
  cwd: string;
  /** 写入子进程 stdin 后关闭；undefined = 不开 stdin 管道（stdio ignore） */
  stdin?: string;
  /** 超时 ms（到点 kill 并记 verdict="timeout"，由 close 统一收口为 resolve） */
  timeoutMs: number;
  /** 单流输出累计上限（超出截断并标注，防失控输出 OOM）；缺省不封顶 */
  maxStreamChars?: number;
  /** 诊断日志（仅 stderr 留痕；与 logTag 需同时提供才记） */
  log?: (kind: LogKind, detail: string) => void;
  /** stderr 留痕前缀（如 `run-once[claude#r1]`；与 log 需同时提供才记） */
  logTag?: string;
}

/** 一次性执行终态：verdict 记录我方主动终止原因（自然退出为 null），exitCode/stdout/stderr 完整回收 */
export interface OneShotOutcome {
  verdict: "timeout" | "cancelled" | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** 进行中的一次性执行句柄（取消锚点：置 cancelled 并 kill，由 close 统一收口） */
export interface OneShotHandle {
  /** 请求取消（终结后调用返回 false，幂等 no-op）；timeout 之后 cancel 会把 verdict 翻转为 cancelled（后到者定终态归类，与既有 RunOnceRunner.cancel 语义一致） */
  cancel(): boolean;
}

/** spawn 返回值：done 为终态 promise（仅启动失败 reject），handle 供取消 */
export interface OneShotExecution {
  done: Promise<OneShotOutcome>;
  handle: OneShotHandle;
}

/** 启动失败（spawn 同步抛错或异步 error 事件同路；message 已归一为原始错误文本，消费方映射为各自文案的 AdapterError） */
export class OneShotSpawnError extends Error {
  constructor(e: unknown) {
    super(e instanceof Error ? e.message : String(e));
    this.name = "OneShotSpawnError";
  }
}

/** 单流累计器：maxChars 缺省不封顶；封顶时截断并以标注行结尾 */
class StreamCapture {
  private buf = "";
  private truncated = false;

  constructor(private readonly maxChars?: number) {}

  push(chunk: string): void {
    if (this.maxChars === undefined) {
      this.buf += chunk;
      return;
    }
    if (this.buf.length >= this.maxChars) {
      this.truncated = true;
      return;
    }
    this.buf += chunk;
    if (this.buf.length > this.maxChars) {
      this.buf = this.buf.slice(0, this.maxChars);
      this.truncated = true;
    }
  }

  text(): string {
    return this.truncated ? `${this.buf}\n[输出超限截断]` : this.buf;
  }
}

/**
 * 一次性 spawn 执行：spawn 直连真实 exe 并等待终态；超时/取消 kill 后由 close 事件统一收口（resolve 带 verdict），
 * 仅启动失败 reject（OneShotSpawnError）。终态文案与错误映射留在消费方。
 */
export function spawnOneShot(options: OneShotSpawnOptions): OneShotExecution {
  const startedAt = Date.now();
  const stdout = new StreamCapture(options.maxStreamChars);
  const stderr = new StreamCapture(options.maxStreamChars);
  let verdict: "timeout" | "cancelled" | null = null;
  let settled = false;
  let child: ChildProcess | null = null;
  // 终止子进程（尽力；Windows 下为 TerminateProcess；孤儿治理由 worker 宿主 Job Object 兜底）
  const killChild = (): void => {
    if (!child) return;
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
  };
  const handle: OneShotHandle = {
    cancel: (): boolean => {
      if (settled) return false;
      verdict = "cancelled";
      killChild();
      return true;
    },
  };
  const done = new Promise<OneShotOutcome>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const settleResolve = (r: OneShotOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    try {
      child = spawn(options.exe, options.args, {
        cwd: options.cwd,
        stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false, // 直连真实 exe，不经 shell（Windows/MSYS 参数与 env 改写坑）
        env: { ...process.env }, // 认证 env（用户级 settings 注入的网关配置）不切断
      });
    } catch (e) {
      settled = true;
      reject(new OneShotSpawnError(e));
      return;
    }
    if (options.stdin !== undefined && child.stdin) {
      // stdin 注入后关闭；子进程早死时写入失败不影响 close 收口
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin);
    }
    // 超时终止：记 verdict，kill 后由 close 事件统一收口
    timer = setTimeout(() => {
      if (settled) return;
      verdict = "timeout";
      killChild();
    }, options.timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => stdout.push(d));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      stderr.push(d);
      if (options.log && options.logTag) {
        options.log("stderr", `${options.logTag} ${d.trimEnd().slice(0, STDERR_LOG_SLICE)}`);
      }
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new OneShotSpawnError(e));
    });
    // close（而非 exit）：等 stdio 流冲刷完毕，确保输出完整回收
    child.on("close", (code) => {
      settleResolve({
        verdict,
        exitCode: code,
        stdout: stdout.text(),
        stderr: stderr.text(),
        durationMs: Date.now() - startedAt,
      });
    });
  });
  return { done, handle };
}
