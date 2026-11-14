// 用途：CliHost seam（spec C5 冻结：command/subscribe/shutdown，纯 Node 无 Electron 依赖）—— utilityProcess worker 的核心；多 Adapter 经 AdapterRouter 分发（arch D2 起目录级四命令经 router.forCli(cli) 句柄）；run-once 一次性执行（#29 C5 演进）；消息面 HostCommand/返回值类型由 wire.ts 从 CliAdapter/CliDirectory 派生（issue #73：缺 case 编译红、payload 逐 case 精确窄化、返回值直传）
import type { LogKind, AdapterEvent } from "@kanban/ipc-schema";
import { AdapterError } from "../adapter";
import { AdapterRouter, type AdapterFactory } from "../router-adapter";
import { RunOnceRunner } from "./run-once";
import type { HostCommand, ReturnOf } from "./wire";

/** 命令返回值并集（单 kind 精确类型见 wire.ReturnOf；worker 协议按此直传方法返回值，无结果包袱对象） */
export type HostCommandReturn = { [K in HostCommand["kind"]]: ReturnOf<K> }[HostCommand["kind"]];

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
  constructor(factory: AdapterFactory, log?: (kind: LogKind, detail: string) => void) {
    this.router = new AdapterRouter(factory);
    this.runOnceRunner = new RunOnceRunner(log);
    this.router.subscribe((event) => {
      for (const h of this.handlers) h(event);
    });
  }

  /**
   * 命令入口（spec H：停机中拒绝新请求）；wire 报文 {kind,payload}，返回值 = 方法返回值本身（issue #73），
   * 按 kind 关联返回值类型 ReturnOf<K>（分发实现见 commandDispatch）。
   */
  async command<K extends HostCommand["kind"]>(cmd: HostCommand & { kind: K }): Promise<ReturnOf<K>> {
    return (await this.commandDispatch(cmd)) as ReturnOf<K>;
  }

  private async commandDispatch(cmd: HostCommand): Promise<HostCommandReturn> {
    if (this.shuttingDown) throw new AdapterError("E_INTERNAL", `CliHost 正在停机（${cmd.kind} 被拒绝）`);
    switch (cmd.kind) {
      case "createSession": {
        // 目录级命令（arch D2）：cli 顶层参数经 Router.forCli 分发（缺省 fake 兜底单点在 Router）
        const r = await this.router.forCli(cmd.cli).createSession(cmd.payload);
        return { sessionId: r.sessionId, nativeSessionId: r.nativeSessionId ?? null, model: r.model };
      }
      case "sendTurn":
        await this.router.sendTurn(cmd.payload);
        return;
      case "interruptTurn":
        await this.router.interruptTurn(cmd.payload);
        return;
      case "setModel":
        // issue #79：会话中途切换模型（按 sessionId 路由；忙态/断开由 main 侧校验）
        return this.router.setModel(cmd.payload);
      case "summarizeTitle":
        // #95 / ADR 0003：一次性标题摘要（按 sessionId 路由；结果为命令返回值，不入 ChatEvent 事件流）
        return this.router.summarizeTitle(cmd.payload);
      case "resolveApproval":
        await this.router.resolveApproval(cmd.payload);
        return;
      case "readHistory":
        return this.router.readHistory(cmd.payload);
      case "readTranscript":
        return this.router.readTranscript(cmd.payload);
      case "resume":
        await this.router.resume(cmd.payload);
        return;
      case "adoptSession":
        await this.router.forCli(cmd.cli).adoptSession?.(cmd.payload);
        return;
      case "dispose":
        await this.router.dispose(cmd.payload);
        return;
      case "listChildPids":
        // C5 演进（#44）：聚合各 Adapter 活跃子进程 pid 上报 Main（不路由会话，host 级查询）
        return this.router.listChildPids();
      case "listModels":
        // issue #76：模型目录查询（目录级命令，按 cli 分发不路由会话）
        return this.router.forCli(cmd.cli).listModels(cmd.payload);
      case "listCommands":
        // issue #89：斜杠命令列举（目录级命令，按 cli 分发不路由会话）
        return this.router.forCli(cmd.cli).listCommands(cmd.payload);
      case "runOnce":
        return this.runOnceRunner.run(cmd.payload);
      case "cancelRunOnce":
        this.runOnceRunner.cancel(cmd.payload);
        return;
      default: {
        // 穷尽检查（issue #73）：CliAdapter 新增命令方法后 HostCommand 自动扩员，漏 case 时 cmd 不收敛为 never → 编译红
        const exhaustive: never = cmd;
        return exhaustive;
      }
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
