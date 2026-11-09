// 用途：AdapterRouter —— 多 CLI 分发门面：createSession 按 init.cli 分发到对应 Adapter 并登记路由，其余 C1 方法按 sessionId 路由（ipc 单 adapter 注入位不变）
import { randomUUID } from "node:crypto";
import type { AdapterEvent, ChatEvent, TranscriptEvent } from "@kanban/ipc-schema";
import { AdapterError, type AdoptSessionInput, type AdapterCapabilities, type CliAdapter, type CreateSessionInput, type DisposeInput, type ResolveApprovalInput, type SendTurnInput } from "./adapter";

/** Router 构造工厂：cli → adapter（不支持该 CLI 时抛 AdapterError） */
export type AdapterFactory = (cli: string) => CliAdapter;

/** 能力并集（UI 门面视角；单会话能力以各 adapter 为准） */
function mergeCapabilities(adapters: Iterable<CliAdapter>): AdapterCapabilities {
  const all = [...adapters];
  return {
    approval: all.some((a) => a.capabilities.approval),
    interrupt: all.some((a) => a.capabilities.interrupt),
    resume: all.some((a) => a.capabilities.resume),
    readHistory: all.some((a) => a.capabilities.readHistory),
    skillSignal: all.some((a) => a.capabilities.skillSignal),
  };
}

export class AdapterRouter implements CliAdapter {
  private readonly adapters = new Map<string, CliAdapter>();
  /** 应用侧 sessionId → 所属 adapter（createSession 时登记） */
  private readonly routing = new Map<string, CliAdapter>();
  private readonly handlers = new Set<(event: AdapterEvent) => void>();
  private readonly unsubscribes: Array<() => void> = [];
  readonly capabilities: AdapterCapabilities;

  constructor(private readonly factory: AdapterFactory) {
    // 预热常见 CLI 拿能力并集（fake/codex/claude/opencode）
    const probes: CliAdapter[] = [];
    for (const cli of ["fake", "codex", "claude", "opencode"]) {
      try {
        probes.push(factory(cli));
      } catch {
        /* 未支持 CLI 不参与能力并集 */
      }
    }
    this.capabilities = mergeCapabilities(probes);
  }

  async createSession(init: CreateSessionInput): Promise<{ sessionId: string; nativeSessionId?: string | null }> {
    const cli = init.cli ?? "fake";
    const adapter = this.adapterForCli(cli);
    const r = await adapter.createSession(init);
    this.routing.set(r.sessionId, adapter);
    return r;
  }

  /** 会话收养（#13 恢复编排）：按 cli 分发到目标 Adapter 并登记路由（readHistory/resume/interruptTurn 由此可达） */
  async adoptSession(input: AdoptSessionInput): Promise<void> {
    const cli = input.cli ?? "fake";
    const adapter = this.adapterForCli(cli);
    if (!adapter.adoptSession) {
      throw new AdapterError("E_INTERNAL", `该 CLI 不支持会话收养：${cli}`);
    }
    await adapter.adoptSession({ ...input, cli });
    this.routing.set(input.sessionId, adapter);
  }

  async sendTurn(input: SendTurnInput): Promise<void> {
    return this.route(input.sessionId).sendTurn(input);
  }

  async interruptTurn(sessionId: string): Promise<void> {
    return this.route(sessionId).interruptTurn(sessionId);
  }

  async resolveApproval(input: ResolveApprovalInput): Promise<void> {
    return this.route(input.sessionId).resolveApproval(input);
  }

  async readHistory(sessionId: string): Promise<ChatEvent[]> {
    return this.route(sessionId).readHistory(sessionId);
  }

  async readTranscript(sessionId: string): Promise<TranscriptEvent[]> {
    return this.route(sessionId).readTranscript(sessionId);
  }

  async resume(sessionId: string): Promise<void> {
    return this.route(sessionId).resume(sessionId);
  }

  async dispose(input?: DisposeInput): Promise<void> {
    if (input?.sessionId) {
      const adapter = this.routing.get(input.sessionId);
      if (adapter) {
        await adapter.dispose(input);
        this.routing.delete(input.sessionId);
      }
      return;
    }
    for (const adapter of new Set(this.adapters.values())) await adapter.dispose();
    this.routing.clear();
  }

  /** C5 演进（#44）：聚合各 Adapter 活跃子进程 pid（去重升序；未实现可选成员或无进程的 Adapter 贡献空集） */
  async listChildPids(): Promise<number[]> {
    const pids = new Set<number>();
    for (const adapter of this.adapters.values()) {
      for (const pid of (await adapter.listChildPids?.()) ?? []) pids.add(pid);
    }
    return [...pids].sort((a, b) => a - b);
  }

  subscribe(handler: (event: AdapterEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private adapterForCli(cli: string): CliAdapter {
    let adapter = this.adapters.get(cli);
    if (!adapter) {
      try {
        adapter = this.factory(cli);
      } catch (e) {
        // 错误码形状统一（不变量 6）：工厂异常包成 AdapterError
        if (e instanceof AdapterError) throw e;
        throw new AdapterError("E_INTERNAL", e instanceof Error ? e.message : String(e));
      }
      this.adapters.set(cli, adapter);
      // 聚合新 adapter 事件流（一次性订阅，Router 生命周期内保持）
      this.unsubscribes.push(
        adapter.subscribe((event) => {
          for (const h of this.handlers) h(event);
        }),
      );
    }
    return adapter;
  }

  private route(sessionId: string): CliAdapter {
    const adapter = this.routing.get(sessionId);
    if (!adapter) throw new AdapterError("E_SESSION_NOT_FOUND", `会话不存在：${sessionId}`);
    return adapter;
  }
}

/** 应用侧会话 id 生成（Router 层不生成——由各 adapter 返回；此处保留占位给未来 Main 侧生成模式） */
export function newAppSessionId(): string {
  return `s-${randomUUID().slice(0, 8)}`;
}
