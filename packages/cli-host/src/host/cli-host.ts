// 用途：CliHost seam（spec C5 冻结：command/subscribe/shutdown，纯 Node 无 Electron 依赖）—— utilityProcess worker 的核心；多 Adapter 经 AdapterRouter 分发
import type { AdapterEvent, ChatEvent } from "@kanban/ipc-schema";
import { AdapterError } from "../adapter";
import { AdapterRouter, type AdapterFactory } from "../router-adapter";

/** 宿主命令（C1 方法面的 wire 形状；错误经 AdapterError 形状回传） */
export type HostCommand =
  | { kind: "createSession"; init: { cwd: string; model?: string; permMode?: string; cli?: string } }
  | { kind: "sendTurn"; sessionId: string; text: string }
  | { kind: "interruptTurn"; sessionId: string }
  | { kind: "resolveApproval"; sessionId: string; requestId: string; decision: string }
  | { kind: "readHistory"; sessionId: string }
  | { kind: "resume"; sessionId: string }
  | { kind: "dispose"; sessionId?: string };

/** 命令结果载荷（createSession 附 sessionId/nativeSessionId；readHistory 附事件数组；其余 void） */
export interface HostCommandResult {
  sessionId?: string;
  nativeSessionId?: string | null;
  events?: ChatEvent[];
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
  private readonly handlers = new Set<(event: AdapterEvent) => void>();
  private shuttingDown = false;

  constructor(factory: AdapterFactory) {
    this.router = new AdapterRouter(factory);
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
      case "resume":
        await this.router.resume(cmd.sessionId);
        return {};
      case "dispose":
        await this.router.dispose(cmd.sessionId ? { sessionId: cmd.sessionId } : undefined);
        return {};
    }
  }

  subscribe(handler: (event: AdapterEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** 有序停机：标记拒绝新命令 → 全量 dispose（各 Adapter 内部受控终止）→ 有限等待 */
  async shutdown(options: ShutdownOptions): Promise<void> {
    this.shuttingDown = true;
    const timeoutMs = options.timeoutMs ?? 3000;
    await Promise.race([
      this.router.dispose(),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
  }
}
