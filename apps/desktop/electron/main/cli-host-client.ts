// 用途：Main 侧 CliHost 托管客户端 —— utilityProcess fork worker（ADR-0001 形态）+ Windows Job Object 绑定（t0-01 验证策略）+ CliAdapter 远程代理（Renderer/路由无感托管形态）+ run-once 一次性执行桥（#29 C5 演进）
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterEvent, ChatEvent, LogKind, TranscriptEvent } from "@kanban/ipc-schema";
import { utilityProcess } from "electron";
import { AdapterError, JOB_GUARD_PS, type AdoptSessionInput, type AdapterCapabilities, type CliAdapter, type CreateSessionInput, type DisposeInput, type ResolveApprovalInput, type RunOnceResult, type SendTurnInput } from "@kanban/cli-host";

export interface CliHostClientOptions {
  /** worker bundle 绝对路径（out/main/cli-host-worker.js） */
  workerPath: string;
  /** 模型探测缓存目录（userData，经 env 传给 worker） */
  dataDir: string;
  /** config cliExe.codex 手动覆盖（经 env 传给 worker） */
  codexExe?: string | null;
  /** config cliExe.claude 手动覆盖（经 env 传给 worker） */
  claudeExe?: string | null;
  /** config cliExe.opencode 手动覆盖（经 env 传给 worker） */
  opencodeExe?: string | null;
  /** 全量 dispose 后等 worker 自行退出的上限 ms（超时 kill 兜底；与退出序列 graceMs 对齐，缺省 3000） */
  fullDisposeWaitMs?: number;
  /** 诊断日志（main 进程内生产者，kind 联合编译期收窄；index.ts 装配传入的 (kind: string) 宽签名天然兼容） */
  log?: (kind: LogKind, detail: string) => void;
  /** worker {log} 消息分派目标（#54 spec #52 B 节）：worker 经 parentPort 上报的 (kind, detail) 2 参回调，Main 装配侧强制 source=worker；入参保持 string——跨进程 wire 输入不可信，级别兜底由 resolveKindLog safeParse 守卫；缺省丢弃（Logger 未就绪不抛错） */
  onWorkerLog?: (kind: string, detail: string) => void;
  /** fork 替身注入（#54 A 类测试 seam）：缺省走真实 utilityProcess.fork（env 传参行为不变）；注入替身时不绑 Job Object（无 OS 进程可绑） */
  fork?: (options: CliHostClientOptions) => UtilityProcessLike;
}

/** utilityProcess 结构面（#54：真实 UtilityProcess 结构兼容；测试注入替身实现同一接口） */
export interface UtilityProcessLike {
  postMessage(message: unknown): boolean | void;
  on(event: "message", listener: (msg: unknown) => void): unknown;
  /** 真实 utilityProcess 只回 code（electron dts）；signal 位供替身/信号终止场景观察 */
  on(event: "exit", listener: (code: number, signal?: string | null) => void): unknown;
  /** 进程 spawn 成功事件（pid 自此保证就绪——Electron 44 fork 返回瞬间 pid 尚未赋值） */
  on(event: "spawn", listener: () => void): unknown;
  kill(): boolean | void;
  readonly pid?: number;
}

/** 缺省 fork：env 传参（worker 侧 createDesktopAdapterFactory 读取）→ 真实 utilityProcess.fork（utilityProcess 须在 app ready 后使用，由装配时机保证） */
function forkUtilityProcess(options: CliHostClientOptions): UtilityProcessLike {
  process.env.KANBAN_DATA_DIR = options.dataDir;
  if (options.codexExe) process.env.KANBAN_CODEX_BIN = options.codexExe;
  if (options.claudeExe) process.env.KANBAN_CLAUDE_BIN = options.claudeExe;
  if (options.opencodeExe) process.env.KANBAN_OPENCODE_BIN = options.opencodeExe;
  return utilityProcess.fork(options.workerPath, [], { serviceName: "cli-host" });
}

/** pending 命令白名单摘要（#54 spec #52 G 节 M5）：只取 kind/sessionId/cli/runId（createSession 的 cli 取自 init.cli）；禁止整包 JSON.stringify（run-once 的 stdin 含 chunk 正文，Q8） */
function summarizeCommand(cmd: Record<string, unknown>): string {
  const parts = [`kind=${String(cmd.kind)}`];
  if (cmd.sessionId !== undefined) parts.push(`sessionId=${String(cmd.sessionId)}`);
  const cli = cmd.cli ?? (cmd.init as { cli?: unknown } | undefined)?.cli;
  if (cli !== undefined) parts.push(`cli=${String(cli)}`);
  if (cmd.runId !== undefined) parts.push(`runId=${String(cmd.runId)}`);
  return parts.join(" ");
}

/**
 * CliHost 的 main 侧代理：CliAdapter 接口经 utilityProcess MessagePort 往返（ADR-0001 实测 p95 亚毫秒）。
 * fork 失败（构建产物缺失等）时抛错由调用方决定回退进程内 AdapterRouter。
 */
export class CliHostClient implements CliAdapter {
  readonly capabilities: AdapterCapabilities = {
    approval: true,
    interrupt: true,
    resume: true,
    readHistory: true,
    skillSignal: false,
  };
  private proc: UtilityProcessLike;
  private nextId = 1;
  private readonly fullDisposeWaitMs: number;
  /** #54（spec #52 F 节 M2）：dispose() 起始置位——此后的 worker 退出（含超时 kill 强杀）均为预期停机，不按崩溃误报 */
  private expectingShutdown = false;
  private readonly pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void; summary: string }>();
  private readonly handlers = new Set<(event: AdapterEvent) => void>();
  private readonly log: (kind: LogKind, detail: string) => void;
  private readonly workerLog: (kind: string, detail: string) => void;

  constructor(options: CliHostClientOptions) {
    this.log = options.log ?? (() => {});
    this.workerLog = options.onWorkerLog ?? (() => {});
    this.fullDisposeWaitMs = options.fullDisposeWaitMs ?? 3000;
    // fork 注入 seam（#54）：缺省 env 传参 + 真实 utilityProcess（与重构前行为一致）
    this.proc = options.fork ? options.fork(options) : forkUtilityProcess(options);
    this.proc.on("message", (msg: unknown) => this.onMessage(msg));
    this.proc.on("exit", (code, signal) => this.onWorkerExit(code, signal));
    // Job Object 只绑真实 utilityProcess（替身无 OS 进程可绑，亦免测试拉起 powershell）
    if (process.platform === "win32" && !options.fork) {
      // Electron 44 实测：fork() 返回瞬间 pid 尚未就绪（异步 spawn），同 tick 读取会把 "-MemberPid undefined"
      // 传给 guard → PS 参数绑定失败 exit 1，Job 布防从未生效（每次启动告警）；等 spawn 事件 pid 必就绪后再拉起
      if (this.proc.pid !== undefined) this.attachJobGuard();
      else this.proc.on("spawn", () => this.attachJobGuard());
    }
  }

  async createSession(init: CreateSessionInput): Promise<{ sessionId: string; nativeSessionId?: string | null }> {
    const r = (await this.command({
      kind: "createSession",
      init: { cwd: init.cwd, model: init.model, permMode: init.permMode, cli: init.cli },
    })) as { sessionId: string; nativeSessionId: string | null };
    return { sessionId: r.sessionId, nativeSessionId: r.nativeSessionId };
  }

  async sendTurn(input: SendTurnInput): Promise<void> {
    await this.command({ kind: "sendTurn", sessionId: input.sessionId, text: input.text });
  }

  async interruptTurn(sessionId: string): Promise<void> {
    await this.command({ kind: "interruptTurn", sessionId });
  }

  async resolveApproval(input: ResolveApprovalInput): Promise<void> {
    await this.command({ kind: "resolveApproval", sessionId: input.sessionId, requestId: input.requestId, decision: input.decision });
  }

  async readHistory(sessionId: string): Promise<ChatEvent[]> {
    const r = (await this.command({ kind: "readHistory", sessionId })) as { events: ChatEvent[] };
    return r.events ?? [];
  }

  async readTranscript(sessionId: string): Promise<TranscriptEvent[]> {
    // #28：双视角历史经 worker 命令往返（Main → cli-host adapter，记忆提取管线的读取入口）
    const r = (await this.command({ kind: "readTranscript", sessionId })) as { transcript: TranscriptEvent[] };
    return r.transcript ?? [];
  }

  /** 上报 worker 管理的全部活跃 CLI 子进程 pid（#44 C5 演进，spec #40 C 节；残留治理 #49 的本应用活跃集合基准） */
  async listChildPids(): Promise<number[]> {
    const r = (await this.command({ kind: "listChildPids" })) as { pids?: number[] };
    return r.pids ?? [];
  }

  async resume(sessionId: string): Promise<void> {
    await this.command({ kind: "resume", sessionId });
  }

  async adoptSession(input: AdoptSessionInput): Promise<void> {
    await this.command({
      kind: "adoptSession",
      sessionId: input.sessionId,
      nativeSessionId: input.nativeSessionId,
      cwd: input.cwd,
      cli: input.cli ?? "fake",
      permMode: input.permMode,
      model: input.model,
    });
  }

  async dispose(input?: DisposeInput): Promise<void> {
    // Session 粒度：走命令往返（worker 内 router.dispose({sessionId})——只终止单会话，进程/其他会话保留，t0-01 T3）
    if (input?.sessionId) {
      await this.command({ kind: "dispose", sessionId: input.sessionId });
      return;
    }
    // 全量有序停机：worker 内 shutdown（停止新命令→dispose 全部 adapter→有限等待）→ 等 worker 实际退出，超时 kill 兜底（Job Object 覆盖强杀场景）
    this.expectingShutdown = true; // #54（spec #52 F 节 M2）：预期停机置位在先——超时后的无条件强杀非零退出不误报
    try {
      this.proc.postMessage({ shutdown: { reason: "dispose" } });
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, this.fullDisposeWaitMs);
        this.proc.on("exit", done);
      });
    } finally {
      this.proc.kill();
    }
  }

  /** 一次性执行（#29 C5 演进，spec #27 C 节）：worker 内 spawn 直连 CLI 进程（自动落入 Job Object；提取引擎的 Claude headless 临时进程载体） */
  async runOnce(input: { runId: string; cli: string; args: string[]; cwd: string; stdin?: string; timeoutMs?: number }): Promise<RunOnceResult> {
    const r = (await this.command({ kind: "run-once", ...input })) as { runOnce: RunOnceResult };
    return r.runOnce;
  }

  /** 取消进行中的一次性执行（终结为 cancelled；未在执行则 no-op） */
  async cancelRunOnce(runId: string): Promise<void> {
    await this.command({ kind: "cancel-run-once", runId });
  }

  subscribe(handler: (event: AdapterEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /* ---------------- 内部 ---------------- */

  private command(cmd: Parameters<typeof Object>[0] extends never ? never : Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // #54：pending 存白名单摘要（全部命令形状经此单入口，提取不丢字段）
      this.pending.set(id, { resolve, reject, summary: summarizeCommand(cmd) });
      this.proc.postMessage({ id, cmd });
    });
  }

  private onMessage(msg: unknown): void {
    const m = msg as { id?: number | string; ok?: boolean; result?: unknown; error?: { code: string; message: string }; event?: AdapterEvent; log?: { kind: string; detail: string } };
    // #54（spec #52 B 节）：{log} 判别须先于事件分支与无 id 分支，否则被静默丢弃；未注入分派目标（Logger 未就绪）即丢弃不抛错
    if (m.log !== undefined) {
      this.workerLog(m.log.kind, m.log.detail);
      return;
    }
    if (m.event !== undefined) {
      for (const h of this.handlers) h(m.event);
      return;
    }
    if (m.id === undefined) return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else {
      // #54（spec #52 G 节）：命令失败记一条带白名单标识的 error（level 由 Main 集中映射表判）
      this.log("command-failed", `CliHost 命令失败（${m.error?.code ?? "E_INTERNAL"}：${m.error?.message ?? "CliHost 命令失败"}）：${p.summary}`);
      p.reject(new AdapterError((m.error?.code as never) ?? "E_INTERNAL", m.error?.message ?? "CliHost 命令失败"));
    }
  }

  /** #54（spec #52 F 节）：worker 退出处置 —— pending 批量 reject 并汇总一条（不刷屏）；仅「非预期停机且退出码非零或由信号终止」记 worker-exit error（level 由 Main 映射表判） */
  private onWorkerExit(code: number, signal?: string | null): void {
    const summaries = [...this.pending.values()].map((p) => p.summary);
    const err = new Error(`CliHost worker 已退出：code=${code}`);
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    const crashed = !this.expectingShutdown && (code !== 0 || (signal != null && signal !== ""));
    if (crashed) {
      const tail = summaries.length > 0 ? `；中止 ${summaries.length} 条进行中命令：${summaries.join("；")}` : "";
      this.log("worker-exit", `CliHost worker 意外退出（code=${code}${signal ? `，signal=${signal}` : ""}）${tail}`);
    } else if (summaries.length > 0) {
      this.log("worker-exit-pending", `CliHost worker 退出，中止 ${summaries.length} 条进行中命令：${summaries.join("；")}`);
    }
  }

  /** Windows Job Object：把 worker pid 绑进 KILL_ON_JOB_CLOSE job，guard 等 main pid 死亡后退出（宿主任何方式死亡→OS 全灭 CLI 子孙进程，无孤儿） */
  private attachJobGuard(): void {
    try {
      const script = path.join(tmpdir(), "kanban-job-guard.ps1");
      // UTF-8 无 BOM 写入（脚本 ASCII-only：PS 5.1 对无 BOM 文件按 ANSI 解析，ASCII 内容两种解析等价）
      writeFileSync(script, `${JOB_GUARD_PS}\n`, "utf8");
      const guard = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          "-MemberPid",
          String(this.proc.pid),
          "-TargetPid",
          String(process.pid),
          "-JobName",
          `kanban-clihost-${process.pid}`,
        ],
        { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
      );
      let stderrTail = "";
      guard.stderr?.on("data", (d: Buffer) => {
        stderrTail = (stderrTail + d.toString("utf8")).slice(-300); // 尾部留档：布防失败时 warn 附 stderr 定位阶段（stdio 全 ignore 曾让 exit 1 无细节可查）
      });
      guard.on("error", (e) => this.log("job-guard", `Job guard 启动失败（降级无 Job，正常退出链路不受影响）：${e.message}`));
      guard.on("exit", (code) => {
        if (code !== 0) {
          const tail = stderrTail.trim().split(/\r?\n/).pop() ?? "";
          this.log("job-guard", `Job guard 退出 code=${code}（0=宿主死亡后正常收尾）${tail ? `：${tail}` : ""}`);
        }
      });
    } catch (e) {
      this.log("job-guard", `Job guard 不可用：${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
