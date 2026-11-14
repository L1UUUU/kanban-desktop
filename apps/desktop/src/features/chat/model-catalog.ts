// 用途：模型目录小控制器（issue #77 / spec #75；C9 收缩为键控 IPC 目录缓存的薄实例）—— models:list 预取：
// in-flight 去重（StrictMode 双挂载/草稿与 composer 并发挂载只发一次）、错误不缓存（下次预取重试）；
// 实例由 useChatController 持有（App 生命周期 = 模块级效果），不写会话 store
import type { CliKind, ModelEntry, ModelsRequest, ModelsResult } from "@kanban/ipc-schema";
import { IpcCatalogCache } from "./ipc-catalog-cache";

/** 单个 (cli, cwd) 键的目录状态（useSyncExternalStore 快照：状态对象引用在变化前保持稳定） */
export type ModelsState =
  | { status: "idle" } // 未预取
  | { status: "loading" } // 预取进行中
  | { status: "ready"; models: ModelEntry[] }
  | { status: "error"; code: string; message: string };

// idle 常量单例：getState 对未预取键必须返回同一引用（useSyncExternalStore 快照稳定性）
export const MODELS_IDLE: ModelsState = { status: "idle" };

/** 目录条目默认项派生（isDefault 为单一事实源，无独立 defaultModel 字段） */
export function findDefaultModel(models: ModelEntry[]): ModelEntry | undefined {
  return models.find((m) => m.isDefault);
}

/** 缓存键 (cli, cwd) 拼串（\n 分隔防跨字段歧义，与 commandListCacheKey 同构） */
function modelListCacheKey(cli: CliKind, cwd: string): string {
  return `${cli}\n${cwd}`;
}

/**
 * 模型目录控制器：缓存与订阅按 (cli, cwd) 键控，ready 不设 TTL（进程内不重复拉取）。
 * 键粒度语义（C9 取证定案，非 shortcut）：opencode 为 server-per-project——cli-host OpenCodeServerHost.acquire
 * 按 cwd 拉起独立 server，listModels 读该 server 的 /config/providers（含项目级配置），必须按 cwd 分键，
 * 否则多项目模型列表会串；claude（adapter 进程级握手缓存）与 codex（忽略 cwd）目录全局一份，按 cwd 分键
 * 退化为多键同值，由后端缓存去重，无重复拉取成本。
 */
export class ModelCatalog {
  private readonly cache: IpcCatalogCache<{ cli: CliKind; cwd: string }, ModelsState>;

  constructor(fetch: (req: ModelsRequest) => Promise<ModelsResult>) {
    this.cache = new IpcCatalogCache({
      keyOf: ({ cli, cwd }) => modelListCacheKey(cli, cwd),
      idle: MODELS_IDLE,
      loading: { status: "loading" },
      ttlMs: Infinity,
      // ok/!ok 信封解包为 ready/error 态；桥接异常（transport 不可用等）reject 交缓存 toError 兜底
      fetch: ({ cli, cwd }) =>
        fetch({ channel: "models:list", cli, cwd }).then((r) =>
          r.ok ? { status: "ready", models: r.models } : { status: "error", code: r.error.code, message: r.error.message },
        ),
      toError: (err) => ({ status: "error", code: "E_INTERNAL", message: err instanceof Error ? err.message : String(err) }),
    });
  }

  /** 当前目录状态（未预取返回 idle 单例；引用在下次变化前稳定） */
  getState(cli: CliKind, cwd: string): ModelsState {
    return this.cache.getState({ cli, cwd });
  }

  /** 预取：就绪（缓存命中）或进行中（in-flight 去重）不再发；错误不缓存，下次调用重试 */
  prefetch(cli: CliKind, cwd: string): void {
    this.cache.ensure({ cli, cwd });
  }

  /** 订阅某键状态变化（useSyncExternalStore 数据源；返回注销函数） */
  subscribe(cli: CliKind, cwd: string, listener: () => void): () => void {
    return this.cache.subscribe({ cli, cwd }, listener);
  }
}
