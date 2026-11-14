// 用途：renderer 键控 IPC 目录缓存泛型深模块（C9）—— 统一模型/命令两目录控制器的同构骨架：
// 键控状态账本 + 在途去重 + 订阅通知 + ready TTL 过期（错误态不占缓存：下次 ensure 重发）；
// 键构造、TTL、状态形状与异常映射均为构造参数，消费方（model-catalog / composer-command-source）收缩为薄实例
/** 目录状态判别底座（缓存据此做命中/在途去重/TTL 判定；具体载荷由实例的状态类型扩展） */
export interface CatalogState {
  status: "idle" | "loading" | "ready" | "error";
}

/** fetch/toError 允许产出的状态子集（ready|error；idle/loading 由缓存自身管理） */
export type CatalogResultState<S extends CatalogState> = Extract<S, { status: "ready" } | { status: "error" }>;

/** 构造参数（每个字段都是一个实例差异点：键、拉取映射、异常兜底、状态单例、TTL、时钟） */
export interface IpcCatalogCacheOptions<K, S extends CatalogState> {
  /** 业务键 → 缓存键串（跨层同构键的消费方复用同一构造，防各层拼串漂移） */
  keyOf(key: K): string;
  /** 拉取并映射为 ready/error 态（IPC 信封解包在实例侧）；桥接异常可 reject，由 toError 兜底 */
  fetch(key: K): Promise<CatalogResultState<S>>;
  /** 桥接异常兜底错误态（transport 不可用等 fetch 契约之外的抛出） */
  toError(err: unknown): CatalogResultState<S>;
  /** 未预取键的 idle 单例（快照稳定性：getState 恒返回同一引用） */
  idle: S;
  /** loading 单例（每次拉取前落账；引用稳定，useSyncExternalStore 快照要求） */
  loading: S;
  /** ready 结果有效期毫秒（Infinity = 进程内不重复拉取；过期或错误后 ensure 重发） */
  ttlMs: number;
  /** 时钟注入（缺省 Date.now；测试手动推进驱动过期） */
  now?: () => number;
}

/**
 * 键控 IPC 目录缓存：states/fetchedAt/inflight/listeners 四账本按缓存键串分键；
 * getState 返回存储的稳定引用（变化前不变），subscribe 按 keyOf 归并后的键隔离通知。
 */
export class IpcCatalogCache<K, S extends CatalogState> {
  private readonly keyOf: (key: K) => string;
  private readonly fetcher: (key: K) => Promise<CatalogResultState<S>>;
  private readonly toError: (err: unknown) => CatalogResultState<S>;
  private readonly idle: S;
  private readonly loading: S;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly states = new Map<string, S>();
  private readonly fetchedAt = new Map<string, number>();
  private readonly inflight = new Set<string>();
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(options: IpcCatalogCacheOptions<K, S>) {
    this.keyOf = options.keyOf;
    this.fetcher = options.fetch;
    this.toError = options.toError;
    this.idle = options.idle;
    this.loading = options.loading;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  /** 当前状态（未预取键返回 idle 单例；返回存储的稳定引用——useSyncExternalStore 快照要求） */
  getState(key: K): S {
    return this.states.get(this.keyOf(key)) ?? this.idle;
  }

  /** 预热/确保：loading（在途去重）或 ready 未过期不再发；idle/过期/error 重发（错误不缓存语义） */
  ensure(key: K): void {
    const k = this.keyOf(key);
    const st = this.states.get(k);
    if (st?.status === "loading" || this.inflight.has(k)) return;
    const at = this.fetchedAt.get(k);
    if (st?.status === "ready" && at !== undefined && this.now() - at < this.ttlMs) return;
    this.setState(k, this.loading);
    this.inflight.add(k);
    this.fetcher(key)
      .then((next) => {
        if (next.status === "ready") this.fetchedAt.set(k, this.now());
        this.setState(k, next);
      })
      .catch((err: unknown) => {
        this.setState(k, this.toError(err));
      })
      .finally(() => {
        this.inflight.delete(k);
      });
  }

  /** 订阅某键状态变化（useSyncExternalStore 数据源；返回注销函数） */
  subscribe(key: K, listener: () => void): () => void {
    const k = this.keyOf(key);
    let set = this.listeners.get(k);
    if (!set) {
      set = new Set();
      this.listeners.set(k, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  private setState(k: string, next: S): void {
    this.states.set(k, next);
    for (const l of this.listeners.get(k) ?? []) l();
  }
}
