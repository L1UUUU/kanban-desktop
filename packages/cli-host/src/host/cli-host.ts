// 用途：CliHost seam（spec C5 冻结：command/subscribe/shutdown，纯 Node 无 Electron 依赖）—— utilityProcess worker 的核心；多 Adapter 经 AdapterRouter 分发；run-once 一次性执行（#29 C5 演进）
import type { AdapterEvent, ChatEvent, TranscriptEvent } from "@kanban/ipc-schema";
import { AdapterError } from "../adapter";
import { AdapterRouter, type AdapterFactory } from "../router-adapter";
import { RunOnceRunner, type RunOnceResult } from "./run-once";

/** 宿主命令（C1 方法面的 wire 形状；错误经 AdapterError 形状回传） */
export type HostCommand =
  | { kind: "createSession"; init: { cwd: string; model?: string; permMode?: string; cli?: string } }
  | { kind: "sendTurn"; sessionId: string; text: string }
  | { kind: "interruptTurn"; sessionId: string }
  | { kind: "resolveApproval"; sessionId: string; requestId: string; decision: string }
  | { kind: "readHistory"; sessionId: string }
  | { kind: "readTranscript"; sessionId: string }
  | { kind: "resume"; sessionId: string }
  | { kind: "adoptSession"; sessionId: string; nativeSessionId: string; cwd: string; cli: string; permMode?: string; model?: string }
  | { kind: "dispose"; sessionId?: string }
  | { kind: "run-once"; runId: string; cli: string; args: string[]; cwd: string; stdin?: string; timeoutMs?: number }
  | { kind: "cancel-run-once"; runId: string }
  | { kind: "listChildPids" };

/** 命令结果载荷（createSession 附 sessionId/nativeSessionId；readHistory 附事件数组；readTranscript 附双视角剧本；run-once 附执行结果；listChildPids 附 pid 集合；其余 void） */
export interface HostCommandResult {
  sessionId?: string;
  nativeSessionId?: string | null;
  events?: ChatEvent[];
  transcript?: TranscriptEvent[];
  runOnce?: RunOnceResult;
  /** 活跃 CLI 子进程 pid 去重集合（C5 演进 #44；残留治理的本应用活跃集合基准） */
  pids?: number[];
}

/** 有序停机原因（spec H：停止新请求→有序取消→有限等待→受控终止） */
export interface ShutdownOptions {
  reason: string;
  /** 有限等待上限 ms（缺省 3000；超时后由托管方 kill 兜底） */
  timeoutMs?: number;
}

/**
 * CliHost：command/subscribe/shutdown 三方法 seam。
 * 托管形态（utilityProcess/进程内）对调用方透明；Main 经 CliHostClient 或直接持有均可。
 */
export class CliHost {
  private readonly router: AdapterRouter;
  private readonly runOnceRunner: RunOnceRunner;
  private readonly handlers = new Set<(event: AdapterEvent) => void>();
  private shuttingDown = false;

  /** log 可选：worker 形态注入 {log} 上报闭包（#54），进程内/测试缺省丢弃；不影响既有单参构造 */
  constructor(factory: AdapterFactory, log?: (kind: string, detail: string) => void) {
    this.router = new AdapterRouter(factory);
    this.runOnceRunner = new RunOnceRunner(log);
    this.router.subscribe((event) => {
      for (const h of this.handlers) h(event);
    });
  }

  /** 停机中拒绝新命令（spec H：先停止接收新请求） */
  async command(cmd: HostCommand): Promise<HostCommandResult> {
    if (this.shuttingDown) throw new AdapterError("E_INTERNAL", `CliHost 正在停机（${cmd.kind} 被拒绝）`);
    switch (cmd.kind) {
      case "createSession": {
        const r = await this.router.createSession({
          cwd: cmd.init.cwd,
          model: cmd.init.model,
          permMode: cmd.init.permMode as never,
          cli: cmd.init.cli,
        });
        return { sessionId: r.sessionId, nativeSessionId: r.nativeSessionId ?? null };
      }
      case "sendTurn":
        await this.router.sendTurn({ sessionId: cmd.sessionId, text: cmd.text });
        return {};
      case "interruptTurn":
        await this.router.interruptTurn(cmd.sessionId);
        return {};
      case "resolveApproval":
        await this.router.resolveApproval({
          sessionId: cmd.sessionId,
          requestId: cmd.requestId,
          decision: cmd.decision as never,
        });
        return {};
      case "readHistory":
        return { events: await this.router.readHistory(cmd.sessionId) };
      case "readTranscript":
        return { transcript: await this.router.readTranscript(cmd.sessionId) };
      case "resume":
        await this.router.resume(cmd.sessionId);
        return {};
      case "adoptSession":
        await this.router.adoptSession({
          sessionId: cmd.sessionId,
          nativeSessionId: cmd.nativeSessionId,
          cwd: cmd.cwd,
          permMode: cmd.permMode as never,
          model: cmd.model,
          cli: cmd.cli,
        });
        return {};
      case "dispose":
        await this.router.dispose(cmd.sessionId ? { sessionId: cmd.sessionId } : undefined);
        return {};
      case "run-once":
        return { runOnce: await this.runOnceRunner.run(cmd) };
      case "cancel-run-once":
        this.runOnceRunner.cancel(cmd.runId);
        return {};
      case "listChildPids":
        // C5 演进（#44）：worker 内聚合各 Adapter 活跃子进程 pid 上报 Main（不路由会话，host 级查询）
        return { pids: await this.router.listChildPids() };
    }
  }

  subscribe(handler: (event: AdapterEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** 有序停机：标记拒绝新命令 → 终止进行中的一次性执行（cancelled 收口，不留守夜进程）→ 全量 dispose（各 Adapter 内部受控终止）→ 有限等待 */
  async shutdown(options: ShutdownOptions): Promise<void> {
    this.shuttingDown = true;
    const timeoutMs = options.timeoutMs ?? 3000;
    await Promise.race([
      (async () => {
        await this.runOnceRunner.disposeAll(timeoutMs);
        await this.router.dispose();
      })(),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
  }
}
