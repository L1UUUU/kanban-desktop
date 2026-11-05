// 用途：Main 侧 CliHost 托管客户端 —— utilityProcess fork worker（ADR-0001 形态）+ Windows Job Object 绑定（t0-01 验证策略）+ CliAdapter 远程代理（Renderer/路由无感托管形态）
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterEvent, ChatEvent } from "@kanban/ipc-schema";
import { utilityProcess, type UtilityProcess } from "electron";
import { AdapterError, type AdapterCapabilities, type CliAdapter, type CreateSessionInput, type DisposeInput, type ResolveApprovalInput, type SendTurnInput } from "@kanban/cli-host";

/** KILL_ON_JOB_CLOSE Job guard：等宿主(main)死亡后退出 → 句柄关 → OS 终止 job 内全部 CLI 进程（t0-01 T1 实证的 PowerShell 等价实现；ASCII-only 防 PS5.1 ANSI 解析坑） */
const JOB_GUARD_PS = [
  "param(",
  "  [Parameter(Mandatory = $true)][int]$MemberPid,",
  "  [Parameter(Mandatory = $true)][int]$TargetPid,",
  "  [Parameter(Mandatory = $true)][string]$JobName",
  ")",
  "$ErrorActionPreference = 'Stop'",
  "$src = @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class JobGuardNative {",
  "  [DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode, SetLastError = true)]",
  "  public static extern IntPtr CreateJobObject(IntPtr a, string n);",
  "  [DllImport(\"kernel32.dll\", SetLastError = true)]",
  "  public static extern bool SetInformationJobObject(IntPtr h, int c, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION i, int cb);",
  "  [DllImport(\"kernel32.dll\", SetLastError = true)]",
  "  public static extern bool AssignProcessToJobObject(IntPtr h, IntPtr p);",
  "  [DllImport(\"kernel32.dll\", SetLastError = true)]",
  "  public static extern IntPtr OpenProcess(uint a, bool i, int pid);",
  "  [DllImport(\"kernel32.dll\", SetLastError = true)]",
  "  public static extern int WaitForSingleObject(IntPtr h, int ms);",
  "  [StructLayout(LayoutKind.Sequential)]",
  "  public struct IO_COUNTERS { public ulong R, W, O, RT, WT, OT; }",
  "  [StructLayout(LayoutKind.Sequential)]",
  "  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PUT, JUT; public uint LF; public UIntPtr MWS, XWS; public uint APL; public UIntPtr AF; public int PC, SC; }",
  "  [StructLayout(LayoutKind.Sequential)]",
  "  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION B; public IO_COUNTERS IO; public UIntPtr PM, JM, PP, PJ; }",
  "}",
  "'@",
  "Add-Type -TypeDefinition $src",
  "$job = [JobGuardNative]::CreateJobObject([IntPtr]::Zero, $JobName)",
  "if ($job -eq [IntPtr]::Zero) { exit 1 }",
  "$info = New-Object JobGuardNative+JOBOBJECT_EXTENDED_LIMIT_INFORMATION",
  "$info.B.LimitFlags = 0x2000 # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE",
  "$size = [System.Runtime.InteropServices.Marshal]::SizeOf([type][JobGuardNative+JOBOBJECT_EXTENDED_LIMIT_INFORMATION])",
  "if (-not [JobGuardNative]::SetInformationJobObject($job, 9, [ref]$info, $size)) { exit 1 }",
  "$member = [JobGuardNative]::OpenProcess(0x0101, $false, $MemberPid)",
  "if ($member -eq [IntPtr]::Zero) { exit 1 }",
  "if (-not [JobGuardNative]::AssignProcessToJobObject($job, $member)) { exit 1 }",
  "$target = [JobGuardNative]::OpenProcess(0x0010, $false, $TargetPid)", // SYNCHRONIZE
  "if ($target -eq [IntPtr]::Zero) { exit 0 }",
  "[void][JobGuardNative]::WaitForSingleObject($target, -1)",
].join("\n");

export interface CliHostClientOptions {
  /** worker bundle 绝对路径（out/main/cli-host-worker.js） */
  workerPath: string;
  /** 模型探测缓存目录（userData，经 env 传给 worker） */
  dataDir: string;
  /** config cliExe.codex 手动覆盖（经 env 传给 worker） */
  codexExe?: string | null;
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
  private readonly pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly handlers = new Set<(event: AdapterEvent) => void>();
  private readonly log: (kind: string, detail: string) => void;

  constructor(options: CliHostClientOptions) {
    this.log = options.log ?? (() => {});
    // env 传参：worker 侧 createDesktopAdapterFactory 读取（utilityProcess 继承父 env）
    process.env.KANBAN_DATA_DIR = options.dataDir;
    if (options.codexExe) process.env.KANBAN_CODEX_BIN = options.codexExe;
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

  async resume(sessionId: string): Promise<void> {
    await this.command({ kind: "resume", sessionId });
  }

  async dispose(input?: DisposeInput): Promise<void> {
    // 有序停机：worker 内 shutdown（停止新命令→dispose 全部 adapter→有限等待）→ 超时兜底 kill
    try {
      this.proc.postMessage({ shutdown: { reason: input?.sessionId ? `dispose:${input.sessionId}` : "dispose" } });
      if (!input?.sessionId) await new Promise((r) => setTimeout(r, 500));
    } finally {
      if (!input?.sessionId) this.proc.kill();
    }
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

/** 供测试/降级路径写 guard 脚本（显式导出脚本常量以便断言 ASCII-only） */
export { JOB_GUARD_PS as JOB_GUARD_SCRIPT };
void mkdirSync;
