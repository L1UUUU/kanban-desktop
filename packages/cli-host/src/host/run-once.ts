// 用途：run-once 一次性 CLI 进程执行器（spec #27 C 节 C5 演进，issue #29）—— exe 解析（cli→各 CLI 探测链）、runId 取消注册表与终态归类（completed/failed/timeout/cancelled）；spawn 骨架与 Windows 坑位清单单源在 ../one-shot（arch C3 合并）；子进程为 worker 子进程，自动落入宿主 Windows Job Object（Main 侧 JobGuard，t0-01：宿主强杀则 OS 全灭无孤儿）
import type { LogKind } from "@kanban/ipc-schema";
import { AdapterError } from "../adapter";
import { resolveClaudeExe } from "../claude/exe";
import { resolveCodexExe } from "../codex/exe";
import { resolveOpenCodeExe } from "../opencode/exe";
import { OneShotSpawnError, spawnOneShot, type OneShotHandle } from "../one-shot";

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

/**
 * 一次性执行器：每次 run() 独立 spawn 一个 CLI 进程并等待终态。
 * 不走 Adapter 会话机制（无会话状态、无事件流）；进程级治理复用 worker 宿主既有 Job Object。
 */
export class RunOnceRunner {
  /** 进行中的一次性执行（取消锚点：handle.cancel 置 cancelled 并 kill，由 close 统一收口） */
  private readonly active = new Map<string, OneShotHandle>();
  private readonly exeCache = new Map<string, string>();
  /** #54：诊断上报（2 参 kind 回调；worker 形态经 CliHost 透传到 {log} 消息，缺省丢弃） */
  private readonly log: (kind: LogKind, detail: string) => void;

  constructor(log?: (kind: LogKind, detail: string) => void) {
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
    const { done, handle } = spawnOneShot({
      exe,
      args: input.args,
      cwd: input.cwd,
      stdin: input.stdin,
      timeoutMs: input.timeoutMs ?? DEFAULT_RUN_ONCE_TIMEOUT_MS,
      maxStreamChars: MAX_STREAM_CHARS,
      log: this.log,
      // #54（spec #52 B 节 M8 口径 A）：一次性执行 stderr 留痕——成功/失败都记（warn 级由 Main 映射表判），只带 stderr 与 cli/runId 标识，不带 stdout/stdin 正文（Q8）
      logTag: `run-once[${input.cli}#${input.runId}]`,
    });
    this.active.set(input.runId, handle);
    try {
      const r = await done;
      return {
        status: r.verdict ?? (r.exitCode === 0 ? "completed" : "failed"),
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        durationMs: r.durationMs,
      };
    } catch (e) {
      if (e instanceof OneShotSpawnError) {
        throw new AdapterError("E_INTERNAL", `run-once 进程启动失败（${input.cli}）：${e.message}`);
      }
      throw e;
    } finally {
      this.active.delete(input.runId);
    }
  }

  /** 取消进行中的一次性执行（终结为 cancelled）；不存在/已终结返回 false（幂等 no-op） */
  cancel(runId: string): boolean {
    return this.active.get(runId)?.cancel() ?? false;
  }

  /** 停机处置：终止全部进行中的执行（cancelled 收口）并有限等待终结（worker 正常退出前不留守夜进程） */
  async disposeAll(timeoutMs = 3000): Promise<void> {
    for (const handle of this.active.values()) {
      handle.cancel();
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
