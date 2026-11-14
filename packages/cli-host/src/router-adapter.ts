// 用途：AdapterRouter —— 多 CLI 分发门面：目录级四命令（createSession/listModels/listCommands/adoptSession）经 forCli(cli) 句柄按 CLI 分发并登记路由，其余 C1 会话级方法按 sessionId 路由（ipc 单 adapter 注入位不变）；「cli 缺省 → fake」兜底单点在此（arch D2）
import { randomUUID } from "node:crypto";
import type { AdapterEvent, ChatEvent, TranscriptEvent } from "@kanban/ipc-schema";
import { AdapterError, type AdoptSessionInput, type AdapterCapabilities, type CliAdapter, type CliDirectory, type DisposeInput, type ResolveApprovalInput, type SendTurnInput, type SetModelInput } from "./adapter";
import { REAL_CLI_KINDS } from "./exe-registry";

/** Router 构造工厂：cli → adapter（不支持该 CLI 时抛 AdapterError） */
export type AdapterFactory = (cli: string) => CliAdapter;

/** 能力并集（UI 门面视角；单会话能力以各 adapter 为准）。arch C13：可选面 adoptSession/runOnce/listChildPids 一并并集——adapter 单元 runOnce 恒 false（托管形态能力），并集结果即「进程内回退无 runOnce」的声明；arch D3：summarizeTitle 同并集（opencode 缺席，单会话跳过见 summarizeTitle 路由） */
function mergeCapabilities(adapters: Iterable<CliAdapter>): AdapterCapabilities {
  const all = [...adapters];
  return {
    approval: all.some((a) => a.capabilities.approval),
    interrupt: all.some((a) => a.capabilities.interrupt),
    resume: all.some((a) => a.capabilities.resume),
    readHistory: all.some((a) => a.capabilities.readHistory),
    skillSignal: all.some((a) => a.capabilities.skillSignal),
    adoptSession: all.some((a) => a.capabilities.adoptSession),
    runOnce: all.some((a) => a.capabilities.runOnce),
    listChildPids: all.some((a) => a.capabilities.listChildPids),
    summarizeTitle: all.some((a) => a.capabilities.summarizeTitle),
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
    // 预热常见 CLI 拿能力并集（fake + 注册表真实 CLI，名单单源 = CLI_REGISTRY，arch D5）
    const probes: CliAdapter[] = [];
    for (const cli of ["fake", ...REAL_CLI_KINDS]) {
      try {
        probes.push(factory(cli));
      } catch {
        /* 未支持 CLI 不参与能力并集 */
      }
    }
    this.capabilities = mergeCapabilities(probes);
  }

  /**
   * 目录级命令分发句柄（arch D2）：「cli 缺省 → fake」兜底单点——Client/调用方经参数透传 cli，缺省归一在此；
   * 句柄内 createSession/adoptSession 登记应用侧 sessionId → adapter 路由（会话级方法由此可达）。
   */
  forCli(cli?: string): CliDirectory {
    const key = cli ?? "fake";
    const adapter = this.adapterForCli(key);
    const dir = adapter.forCli(key);
    return {
      createSession: async (init) => {
        const r = await dir.createSession(init);
        this.routing.set(r.sessionId, adapter);
        return r;
      },
      listModels: (input) => dir.listModels(input),
      listCommands: (input) => dir.listCommands(input),
      adoptSession:
        dir.adoptSession &&
        (async (input: AdoptSessionInput) => {
          // arch C13：缺席判定单源 = 能力面 adoptSession（方法存在性仅作 TS 收窄保险，缺任一即同错误形状拒绝）
          if (!adapter.capabilities.adoptSession || !dir.adoptSession) {
            throw new AdapterError("E_INTERNAL", `该 CLI 不支持会话收养：${key}`);
          }
          await dir.adoptSession(input);
          this.routing.set(input.sessionId, adapter);
        }),
    };
  }

  async sendTurn(input: SendTurnInput): Promise<void> {
    return this.route(input.sessionId).sendTurn(input);
  }

  async interruptTurn(sessionId: string): Promise<void> {
    return this.route(sessionId).interruptTurn(sessionId);
  }

  /** 会话中途切换模型（issue #79）：按 sessionId 路由到所属 Adapter（三 CLI 统一 idle 可切、下一轮生效语义在各实现内） */
  async setModel(input: SetModelInput): Promise<{ model: string }> {
    return this.route(input.sessionId).setModel(input);
  }

  /** 一次性标题摘要（#95 / ADR 0003）：按 sessionId 路由到所属 Adapter；arch D3 能力位先行——所属 CLI 无摘要能力（opencode）直接返回 null，不白付 adapter 调用（null 语义不变） */
  async summarizeTitle(sessionId: string): Promise<string | null> {
    const adapter = this.route(sessionId);
    if (!adapter.capabilities.summarizeTitle) return null;
    return adapter.summarizeTitle(sessionId);
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

  /** C5 演进（#44）：聚合各 Adapter 活跃子进程 pid（去重升序；缺席判定单源 = 能力面 listChildPids（arch C13），无能力/无进程的 Adapter 贡献空集） */
  async listChildPids(): Promise<number[]> {
    const pids = new Set<number>();
    for (const adapter of this.adapters.values()) {
      // arch C13：能力面先行，方法存在性仅作 TS 收窄保险
      if (!adapter.capabilities.listChildPids || !adapter.listChildPids) continue;
      for (const pid of await adapter.listChildPids()) pids.add(pid);
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
