// 用途：Main 侧 CliHost 托管客户端 —— utilityProcess fork worker（ADR-0001 形态）+ Windows Job Object 绑定（t0-01 验证策略）+ CliAdapter 远程代理（Renderer/路由无感托管形态）+ run-once 一次性执行桥（#29 C5 演进）
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterEvent, ChatEvent, TranscriptEvent } from "@kanban/ipc-schema";
import { utilityProcess, type UtilityProcess } from "electron";
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
  /** 诊断日志 */
  log?: (kind: string, detail: string) => void;
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
  private proc: UtilityProcess;
  private nextId = 1;
  private readonly fullDisposeWaitMs: number;
  private readonly pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly handlers = new Set<(event: AdapterEvent) => void>();
  private readonly log: (kind: string, detail: string) => void;

  constructor(options: CliHostClientOptions) {
    this.log = options.log ?? (() => {});
    this.fullDisposeWaitMs = options.fullDisposeWaitMs ?? 3000;
    // env 传参：worker 侧 createDesktopAdapterFactory 读取（utilityProcess 继承父 env）
    process.env.KANBAN_DATA_DIR = options.dataDir;
    if (options.codexExe) process.env.KANBAN_CODEX_BIN = options.codexExe;
    if (options.claudeExe) process.env.KANBAN_CLAUDE_BIN = options.claudeExe;
    if (options.opencodeExe) process.env.KANBAN_OPENCODE_BIN = options.opencodeExe;
    this.proc = utilityProcess.fork(options.workerPath, [], { serviceName: "cli-host" });
    this.proc.on("message", (msg: unknown) => this.onMessage(msg));
    this.proc.on("exit", (code) => {
      const err = new Error(`CliHost worker 已退出：code=${code}`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });
    if (process.platform === "win32") this.attachJobGuard();
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
      this.pending.set(id, { resolve, reject });
      this.proc.postMessage({ id, cmd });
    });
  }

  private onMessage(msg: unknown): void {
    const m = msg as { id?: number | string; ok?: boolean; result?: unknown; error?: { code: string; message: string }; event?: AdapterEvent };
    if (m.event !== undefined) {
      for (const h of this.handlers) h(m.event);
      return;
    }
    if (m.id === undefined) return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new AdapterError((m.error?.code as never) ?? "E_INTERNAL", m.error?.message ?? "CliHost 命令失败"));
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
        { stdio: "ignore", windowsHide: true },
      );
      guard.on("error", (e) => this.log("job-guard", `Job guard 启动失败（降级无 Job，正常退出链路不受影响）：${e.message}`));
      guard.on("exit", (code) => {
        if (code !== 0) this.log("job-guard", `Job guard 退出 code=${code}（0=宿主死亡后正常收尾）`);
      });
    } catch (e) {
      this.log("job-guard", `Job guard 不可用：${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
