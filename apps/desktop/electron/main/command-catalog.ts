// 用途：斜杠命令目录服务（issue #89 / spec #82 E 块）—— composer:listCommands 的 Main 侧短 TTL 缓存层：同 (cli, cwd) 重复调用在 TTL 内不重复扫描；缓存只服务列举，发送/派发判定不依赖（opencode 适配器单点判定、claude/codex 展开各走自己的路径）
import type { CliAdapter } from "@kanban/cli-host";
import { COMMAND_LIST_CACHE_TTL_MS, commandListCacheKey, type CliKind, type CommandEntry } from "@kanban/ipc-schema";

export interface CommandCatalogOptions {
  /** 命令源 adapter（生产 = CliHostClient/AdapterRouter 的 forCli 句柄；测试注入 FakeAdapter） */
  adapter: Pick<CliAdapter, "forCli">;
  /** TTL 毫秒（缺省 COMMAND_LIST_CACHE_TTL_MS 单源；测试注入小值） */
  ttlMs?: number;
  /** 时钟注入（缺省 Date.now；测试手动推进驱动过期） */
  now?: () => number;
}

/** 命令目录缓存：键 (cli, cwd) → 成功结果；失败不落缓存（保持冷，下次调用重读可重试） */
export class CommandCatalog {
  private readonly cache = new Map<string, { at: number; commands: CommandEntry[] }>();
  private readonly adapter: Pick<CliAdapter, "forCli">;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: CommandCatalogOptions) {
    this.adapter = options.adapter;
    this.ttlMs = options.ttlMs ?? COMMAND_LIST_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** 列举某 CLI 在某 cwd 的命令目录：TTL 内命中缓存（返回拷贝防调用方改写），过期/未缓存经 forCli(cli) 句柄拉取（AdapterError 原样上抛由信封透传） */
  async list(cli: CliKind, cwd: string): Promise<CommandEntry[]> {
    const key = commandListCacheKey(cli, cwd);
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.commands.map((c) => ({ ...c }));
    const commands = await this.adapter.forCli(cli).listCommands({ cwd });
    this.cache.set(key, { at: this.now(), commands });
    return commands;
  }
}
