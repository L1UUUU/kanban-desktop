// 用途：run-once 一次性 CLI 进程执行器（spec #27 C 节 C5 演进，issue #29）—— 在 worker 内 spawn 直连真实 exe（不经 shell，MSYS 规约不破坏）、认证 env 不切断、stdout/stderr/exitCode 回传；子进程为 worker 子进程，自动落入宿主 Windows Job Object（Main 侧 JobGuard，t0-01：宿主强杀则 OS 全灭无孤儿）
import { spawn, type ChildProcess } from "node:child_process";
import { AdapterError } from "../adapter";
import { resolveClaudeExe } from "../claude/exe";
import { resolveCodexExe } from "../codex/exe";
import { resolveOpenCodeExe } from "../opencode/exe";

/** run-once 支持的 CLI（exe 解析复用各 CLI 既有探测链：手动覆盖→env→npm 全局→where/which） */
const RUN_ONCE_CLIS = ["claude", "codex", "opencode"] as const;

/** 单次执行超时缺省（spec F：提取单段默认 300s，超时归批次 failed） */
export const DEFAULT_RUN_ONCE_TIMEOUT_MS = 300_000;

/** 单流输出累计上限（防失控输出 OOM worker；超出截断并标注） */
const MAX_STREAM_CHARS = 1_000_000;

export interface RunOnceInput {
  /** 调用方生成的一次性执行 id（取消锚点；进行中重复拒绝） */
  runId: string;
  /** 目标 CLI（exe 解析与认证 env 复用既有实现） */
  cli: string;
  /** spawn 参数原样传递（真实 exe 直连，不经 shell） */
  args: string[];
  /** 子进程工作目录（提取临时目录等） */
  cwd: string;
  /** 写入子进程 stdin 后关闭（poc-5 提取形态：prompt 经 stdin 传递） */
  stdin?: string;
  /** 单次执行超时 ms（到点终止并归 timeout；缺省 300s） */
  timeoutMs?: number;
}

/** run-once 终态：completed=exit 0；failed=非零退出；timeout=超时被终止；cancelled=被取消/停机终止 */
export interface RunOnceResult {
  status: "completed" | "failed" | "timeout" | "cancelled";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** 单流累计器：封顶截断防失控输出 */
class StreamCapture {
  private buf = "";
  private truncated = false;

  push(chunk: string): void {
    if (this.buf.length >= MAX_STREAM_CHARS) {
      this.truncated = true;
      return;
    }
    this.buf += chunk;
    if (this.buf.length > MAX_STREAM_CHARS) {
      this.buf = this.buf.slice(0, MAX_STREAM_CHARS);
      this.truncated = true;
    }
  }

  text(): string {
    return this.truncated ? `${this.buf}\n[输出超限截断]` : this.buf;
  }
}

/** exe 解析（成功缓存；与 ClaudeAdapter.exeCache 同策略） */
function resolveRunOnceExe(cli: string, cache: Map<string, string>): string {
  const hit = cache.get(cli);
  if (hit) return hit;
  let exe: string;
  if (cli === "claude") exe = resolveClaudeExe();
  else if (cli === "codex") exe = resolveCodexExe();
  else if (cli === "opencode") exe = resolveOpenCodeExe();
  else throw new AdapterError("E_INTERNAL", `run-once 未支持的 CLI：${cli}（支持：${RUN_ONCE_CLIS.join("/")}）`);
  cache.set(cli, exe);
  return exe;
}

/** 终止子进程（尽力；Windows 下为 TerminateProcess；孤儿治理由 Job Object 兜底） */
function killChild(child: ChildProcess): void {
  try {
    child.kill();
  } catch {
    /* 已退出 */
  }
}

/** 进行中的一次性执行（verdict 记录我方主动终止原因，决定终态归类） */
interface ActiveRun {
  child: ChildProcess;
  verdict: "timeout" | "cancelled" | null;
}

/**
 * 一次性执行器：每次 run() 独立 spawn 一个 CLI 进程并等待终态。
 * 不走 Adapter 会话机制（无会话状态、无事件流）；进程级治理复用 worker 宿主既有 Job Object。
 */
export class RunOnceRunner {
  private readonly active = new Map<string, ActiveRun>();
  private readonly exeCache = new Map<string, string>();
  /** #54：诊断上报（2 参 kind 回调；worker 形态经 CliHost 透传到 {log} 消息，缺省丢弃） */
  private readonly log: (kind: string, detail: string) => void;

  constructor(log?: (kind: string, detail: string) => void) {
    this.log = log ?? (() => {});
  }

  async run(input: RunOnceInput): Promise<RunOnceResult> {
    if (this.active.has(input.runId)) {
      throw new AdapterError("E_INTERNAL", `run-once 重复 runId：${input.runId}（已有同名执行进行中）`);
    }
    let exe: string;
    try {
      exe = resolveRunOnceExe(input.cli, this.exeCache);
    } catch (e) {
      if (e instanceof AdapterError) throw e;
      throw new AdapterError("E_INTERNAL", `run-once exe 解析失败（${input.cli}）：${e instanceof Error ? e.message : String(e)}`);
    }
    const startedAt = Date.now();
    const stdout = new StreamCapture();
    const stderr = new StreamCapture();
    return new Promise<RunOnceResult>((resolve, reject) => {
      const child: ChildProcess = spawn(exe, input.args, {
        cwd: input.cwd,
        stdio: [input.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false, // 直连真实 exe，不经 shell（Windows/MSYS 参数与 env 改写坑，PoC 2 发现 #5）
        env: { ...process.env }, // 认证 env（用户级 settings 注入的网关配置）不切断（PoC 7 T6 叠加语义）
      });
      if (input.stdin !== undefined && child.stdin) {
        // prompt 经 stdin 注入后关闭（poc-5 提取形态）；子进程早死时写入失败不影响 close 收口
        child.stdin.on("error", () => {});
        child.stdin.end(input.stdin);
      }
      const entry: ActiveRun = { child, verdict: null };
      this.active.set(input.runId, entry);
      let settled = false;
      const settle = (fn: (v: never) => void, v: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active.delete(input.runId);
        (fn as (x: unknown) => void)(v);
      };
      // 超时终止：verdict=timeout，kill 后由 close 事件统一收口
      const timer = setTimeout(() => {
        entry.verdict = "timeout";
        killChild(child);
      }, input.timeoutMs ?? DEFAULT_RUN_ONCE_TIMEOUT_MS);
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (d: string) => stdout.push(d));
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (d: string) => {
        stderr.push(d);
        // #54（spec #52 B 节 M8 口径 A）：一次性执行 stderr 留痕——成功/失败都记（warn 级由 Main 映射表判），只带 stderr 与 cli/runId 标识，不带 stdout/stdin 正文（Q8）
        this.log("stderr", `run-once[${input.cli}#${input.runId}] ${d.trimEnd().slice(0, 400)}`);
      });
      child.on("error", (e) => {
        settle(reject, new AdapterError("E_INTERNAL", `run-once 进程启动失败（${input.cli}）：${e.message}`));
      });
      // close（而非 exit）：等 stdio 流冲刷完毕，确保输出完整回收
      child.on("close", (code) => {
        settle(resolve, {
          status: entry.verdict ?? (code === 0 ? "completed" : "failed"),
          exitCode: code,
          stdout: stdout.text(),
          stderr: stderr.text(),
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }

  /** 取消进行中的一次性执行（终结为 cancelled）；不存在/已终结返回 false（幂等 no-op） */
  cancel(runId: string): boolean {
    const entry = this.active.get(runId);
    if (!entry) return false;
    entry.verdict = "cancelled";
    killChild(entry.child);
    return true;
  }

  /** 停机处置：终止全部进行中的执行（cancelled 收口）并有限等待终结（worker 正常退出前不留守夜进程） */
  async disposeAll(timeoutMs = 3000): Promise<void> {
    for (const entry of this.active.values()) {
      entry.verdict = "cancelled";
      killChild(entry.child);
    }
    if (this.active.size === 0) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      const poll = (): void => {
        if (this.active.size === 0) done();
        else setTimeout(poll, 50);
      };
      poll();
    });
  }
}
