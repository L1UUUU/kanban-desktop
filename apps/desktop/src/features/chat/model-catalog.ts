// 用途：模型目录小控制器（issue #77 / spec #75）—— 按 cli 缓存一次的 models:list 预取：in-flight 去重（StrictMode 双挂载/草稿与 composer 并发挂载只发一次）、错误不缓存（下次预取重试）；实例由 useChatController 持有（App 生命周期 = 模块级效果），不写会话 store
import type { CliKind, ModelEntry, ModelsRequest, ModelsResult } from "@kanban/ipc-schema";

/** 单个 cli 的目录状态（useSyncExternalStore 快照：状态对象引用在变化前保持稳定） */
export type ModelsState =
  | { status: "idle" } // 未预取
  | { status: "loading" } // 预取进行中
  | { status: "ready"; models: ModelEntry[] }
  | { status: "error"; code: string; message: string };

// idle 常量单例：getState 对未预取 cli 必须返回同一引用（useSyncExternalStore 快照稳定性）
const IDLE: ModelsState = { status: "idle" };

/** 目录条目默认项派生（isDefault 为单一事实源，无独立 defaultModel 字段） */
export function findDefaultModel(models: ModelEntry[]): ModelEntry | undefined {
  return models.find((m) => m.isDefault);
}

/**
 * 模型目录控制器：缓存与订阅按 cli 键控。
 * shortcut: 列表按 cli 缓存一次，忽略 opencode per-project 配置差异（cwd 取首次预取值）；复查：多项目模型配置出现实际分歧。
 */
export class ModelCatalog {
  private readonly fetch: (req: ModelsRequest) => Promise<ModelsResult>;
  private readonly states = new Map<CliKind, ModelsState>();
  private readonly inflight = new Set<CliKind>();
  private readonly listeners = new Map<CliKind, Set<() => void>>();

  constructor(fetch: (req: ModelsRequest) => Promise<ModelsResult>) {
    this.fetch = fetch;
  }

  /** 当前目录状态（未预取返回 idle 单例；引用在下次变化前稳定） */
  getState(cli: CliKind): ModelsState {
    return this.states.get(cli) ?? IDLE;
  }

  /** 预取：就绪（缓存命中）或进行中（in-flight 去重）不再发；错误不缓存，下次调用重试 */
  prefetch(cli: CliKind, cwd: string): void {
    const st = this.states.get(cli);
    if (st?.status === "ready" || st?.status === "loading" || this.inflight.has(cli)) return;
    this.setState(cli, { status: "loading" });
    this.inflight.add(cli);
    this.fetch({ channel: "models:list", cli, cwd })
      .then((r) => {
        this.setState(cli, r.ok ? { status: "ready", models: r.models } : { status: "error", code: r.error.code, message: r.error.message });
      })
      .catch((err: unknown) => {
        // 桥接异常（如 transport 不可用）：进错误态（不缓存，可重试）；手输兜底路径仍可用
        this.setState(cli, { status: "error", code: "E_INTERNAL", message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        this.inflight.delete(cli);
      });
  }

  /** 订阅某 cli 的状态变化（useSyncExternalStore 数据源；返回注销函数） */
  subscribe(cli: CliKind, listener: () => void): () => void {
    let set = this.listeners.get(cli);
    if (!set) {
      set = new Set();
      this.listeners.set(cli, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  private setState(cli: CliKind, next: ModelsState): void {
    this.states.set(cli, next);
    for (const l of this.listeners.get(cli) ?? []) l();
  }
}
