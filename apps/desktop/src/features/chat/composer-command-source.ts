// 用途：renderer 斜杠命令源小控制器（issue #90 / spec #82 E 块）—— composer:listCommands 的 renderer 侧 TTL 缓存：挂载/触发预热（首次输入 / 不等冷启动）、在途去重、失败保持冷可重试；Main 侧另有 CommandCatalog 短缓存，本层只省 IPC 往返；实例由 useChatController 持有（App 生命周期），不写会话 store
import { COMMAND_LIST_CACHE_TTL_MS, commandListCacheKey, type CliKind, type CommandEntry, type IpcRequest, type IpcResult } from "@kanban/ipc-schema";

/** 单键 (cli, cwd) 的命令源状态（useSyncExternalStore 快照：引用在变化前保持稳定） */
export type CommandsState =
  | { status: "idle" } // 未预热
  | { status: "loading" } // 拉取进行中（菜单等就绪，不闪空表）
  | { status: "ready"; commands: CommandEntry[] }
  | { status: "error"; message: string };

// idle 常量单例：getState 对未预取键必须返回同一引用（useSyncExternalStore 快照稳定性）
export const COMMANDS_IDLE: CommandsState = { status: "idle" };

export interface ComposerCommandSourceOptions {
  /** 缓存 TTL 毫秒（缺省 COMMAND_LIST_CACHE_TTL_MS 单源，与 Main CommandCatalog 同值；测试注入小值） */
  ttlMs?: number;
  /** 时钟注入（缺省 Date.now；测试手动推进驱动过期） */
  now?: () => number;
}

/** composer:listCommands 请求（fetch 面恒为该子通道请求） */
export type ComposerListRequest = Extract<IpcRequest, { channel: "composer:listCommands" }>;

/**
 * 斜杠命令源：缓存与订阅按 (cli, cwd) 键控；ready 结果带时间戳，ensure 时过期才重拉；
 * 错误不缓存（下次 ensure 重试）。菜单可见性门控由 use-slash-menu 消费（源未就绪不弹菜单）。
 */
export class ComposerCommandSource {
  private readonly fetch: (req: ComposerListRequest) => Promise<IpcResult>;
  private readonly states = new Map<string, CommandsState>();
  private readonly fetchedAt = new Map<string, number>();
  private readonly inflight = new Set<string>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(fetch: (req: ComposerListRequest) => Promise<IpcResult>, options: ComposerCommandSourceOptions = {}) {
    this.fetch = fetch;
    this.ttlMs = options.ttlMs ?? COMMAND_LIST_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  private key(cli: CliKind, cwd: string): string {
    return commandListCacheKey(cli, cwd);
  }

  /** 当前状态（未预热键返回 idle 单例；返回存储的稳定引用——useSyncExternalStore 快照要求） */
  getState(cli: CliKind, cwd: string): CommandsState {
    return this.states.get(this.key(cli, cwd)) ?? COMMANDS_IDLE;
  }

  /** 预热/确保：ready 且未过 TTL 或 loading（在途去重）不再发；其余（idle/过期/error）发 composer:listCommands */
  ensure(cli: CliKind, cwd: string): void {
    const key = this.key(cli, cwd);
    const st = this.states.get(key);
    if (st?.status === "loading" || this.inflight.has(key)) return;
    const at = this.fetchedAt.get(key);
    if (st?.status === "ready" && at !== undefined && this.now() - at < this.ttlMs) return;
    this.setState(key, { status: "loading" });
    this.inflight.add(key);
    this.fetch({ channel: "composer:listCommands", cli, cwd })
      .then((r) => {
        if (r.ok && r.commands) {
          this.fetchedAt.set(key, this.now());
          this.setState(key, { status: "ready", commands: r.commands });
        } else if (r.ok) {
          // ok 但载荷缺 commands：契约不允许（schema optional 字段防御），按错误处理保持冷
          this.setState(key, { status: "error", message: "命令列举载荷缺失 commands 字段" });
        } else {
          this.setState(key, { status: "error", message: `${r.error.code}: ${r.error.message}` });
        }
      })
      .catch((err: unknown) => {
        // 桥接异常（transport 不可用等）：错误态不缓存，下次 ensure 重试
        this.setState(key, { status: "error", message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        this.inflight.delete(key);
      });
  }

  /** 订阅某键状态变化（useSyncExternalStore 数据源；返回注销函数） */
  subscribe(cli: CliKind, cwd: string, listener: () => void): () => void {
    const key = this.key(cli, cwd);
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  private setState(key: string, next: CommandsState): void {
    this.states.set(key, next);
    for (const l of this.listeners.get(key) ?? []) l();
  }
}
