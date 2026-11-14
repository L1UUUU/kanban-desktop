// 用途：renderer 斜杠命令源小控制器（issue #90 / spec #82 E 块；C9 收缩为键控 IPC 目录缓存的薄实例）——
// composer:listCommands 的 renderer 侧 TTL 缓存：挂载/触发预热（首次输入 / 不等冷启动）、在途去重、失败保持冷可重试；
// Main 侧另有 CommandCatalog 短缓存，本层只省 IPC 往返；实例由 useChatController 持有（App 生命周期），不写会话 store
import { COMMAND_LIST_CACHE_TTL_MS, commandListCacheKey, type CliKind, type CommandEntry, type IpcRequest, type IpcResult } from "@kanban/ipc-schema";
import { IpcCatalogCache } from "./ipc-catalog-cache";

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
 * 斜杠命令源：缓存与订阅按 (cli, cwd) 键控（键构造复用 commandListCacheKey 单源，与 Main CommandCatalog 同构键）；
 * ready 结果带时间戳，ensure 时过期才重拉；错误不缓存（下次 ensure 重试）。菜单可见性门控由 use-slash-menu 消费（源未就绪不弹菜单）。
 */
export class ComposerCommandSource {
  private readonly cache: IpcCatalogCache<{ cli: CliKind; cwd: string }, CommandsState>;

  constructor(fetch: (req: ComposerListRequest) => Promise<IpcResult>, options: ComposerCommandSourceOptions = {}) {
    this.cache = new IpcCatalogCache({
      keyOf: ({ cli, cwd }) => commandListCacheKey(cli, cwd),
      idle: COMMANDS_IDLE,
      loading: { status: "loading" },
      ttlMs: options.ttlMs ?? COMMAND_LIST_CACHE_TTL_MS,
      now: options.now,
      // ok/!ok 信封解包为 ready/error 态；ok 但载荷缺 commands 为契约不允许（schema optional 字段防御），按错误处理保持冷；
      // 桥接异常（transport 不可用等）reject 交缓存 toError 兜底
      fetch: ({ cli, cwd }) =>
        fetch({ channel: "composer:listCommands", cli, cwd }).then((r) => {
          if (r.ok && r.commands) return { status: "ready" as const, commands: r.commands };
          if (r.ok) return { status: "error" as const, message: "命令列举载荷缺失 commands 字段" };
          return { status: "error" as const, message: `${r.error.code}: ${r.error.message}` };
        }),
      toError: (err) => ({ status: "error", message: err instanceof Error ? err.message : String(err) }),
    });
  }

  /** 当前状态（未预热键返回 idle 单例；返回存储的稳定引用——useSyncExternalStore 快照要求） */
  getState(cli: CliKind, cwd: string): CommandsState {
    return this.cache.getState({ cli, cwd });
  }

  /** 预热/确保：ready 且未过 TTL 或 loading（在途去重）不再发；其余（idle/过期/error）发 composer:listCommands */
  ensure(cli: CliKind, cwd: string): void {
    this.cache.ensure({ cli, cwd });
  }

  /** 订阅某键状态变化（useSyncExternalStore 数据源；返回注销函数） */
  subscribe(cli: CliKind, cwd: string, listener: () => void): () => void {
    return this.cache.subscribe({ cli, cwd }, listener);
  }
}
