// 用途：exe 解析链骨架单源（arch C4）—— manual 覆盖→env→CLI 特有步序的 resolve 与候选并集从同一条链派生（采纳条件天然一致）；npm 全局 / PATH 兜底 / 单探测三类步工厂；解析结果缓存与 spawn 阶段错误映射（ExeNotFoundError→E_SPAWN_NOT_FOUND）单实现，三 CLI 与三个消费方共用
import { existsSync } from "node:fs";
import { AdapterError, ExeNotFoundError } from "./adapter";
import { dedupePaths, lookupAllPathLines, npmRootGlobal, type ExeCandidateProbes } from "./exe-probes";

/** exe 解析链步（骨架原子）：resolveFirst 探测首个存在候选（miss 为未命中时的已尝试描述，缺省不记入错误消息）；listAll 探测本步全部存在候选（并集按步序拼接） */
export interface ExeChainStep {
  resolveFirst(injection: ExeCandidateProbes): { hit: string | null; miss?: string };
  listAll(injection: ExeCandidateProbes): string[];
}

/** exe 解析链差异声明（arch C4）：各 CLI 只声明 envVar 与 manual/env 之后的候选步序（npm 全局布局 / CLI 特定位 / PATH 兜底等）；manual→env→steps→错误拼装的骨架单源执行 */
export interface ExeChainSpec {
  /** CLI 名（错误消息、缓存键、注册表键） */
  cli: string;
  /** env 覆盖变量名（测试/特殊环境；CliHostClient 经 env 传给 worker） */
  envVar: string;
  /** manual/env 之后的候选步（按解析优先级排序） */
  steps: ExeChainStep[];
}

/** 解析链公共选项：manual 覆盖（config cliExe.*，最高优先）+ 探测注入面（密封测试替换子进程探测） */
export type ExeChainOptions = ExeCandidateProbes & { manualOverride?: string | null };

/**
 * 解析真实 exe：找不到时抛 ExeNotFoundError（含已尝试路径与覆盖方法，失败可定位）。
 * 全部分支都返回「显式绝对路径」（spawn 直连，不经 .cmd shim / PATH 运行时兜底——spec G 通用决策）。
 */
export function resolveExeChain(spec: ExeChainSpec, options: ExeChainOptions = {}): string {
  const tried: string[] = [];
  // 1) config 手动覆盖
  if (options.manualOverride) {
    if (existsSync(options.manualOverride)) return options.manualOverride;
    tried.push(`手动覆盖 ${options.manualOverride}（不存在）`);
  }
  // 2) env 覆盖（测试/特殊环境）
  const envPath = process.env[spec.envVar];
  if (envPath) {
    if (existsSync(envPath)) return envPath;
    tried.push(`${spec.envVar}=${envPath}（不存在）`);
  }
  // 3) CLI 特有步序：首个存在候选即链出口，未命中步按声明记已尝试
  for (const step of spec.steps) {
    const r = step.resolveFirst(options);
    if (r.hit !== null) return r.hit;
    if (r.miss !== undefined) tried.push(r.miss);
  }
  throw new ExeNotFoundError(
    `未找到 ${spec.cli} 可执行文件（已尝试：${tried.join("；") || "无"}）。请在设置中手动指定 ${spec.cli}.exe 路径或设置 ${spec.envVar}。`,
  );
}

/** 解析链全量候选路径并集（#49 残留检测的 exe 匹配粒度）：与 resolveExeChain 自同一条链派生（存在才收），按链序去重 */
export function listExeChainCandidates(spec: ExeChainSpec, options: ExeChainOptions = {}): string[] {
  const paths: string[] = [];
  if (options.manualOverride && existsSync(options.manualOverride)) paths.push(options.manualOverride);
  const envPath = process.env[spec.envVar];
  if (envPath && existsSync(envPath)) paths.push(envPath);
  for (const step of spec.steps) paths.push(...step.listAll(options));
  return dedupePaths(paths);
}

/** npm 全局步工厂（三 CLI 共用形态）：layout 自 npm 全局根计算候选 exe（null=布局落空）；miss 拼未命中描述（npm root -g 自身失败的描述由骨架统一记录） */
export function npmGlobalExeStep(input: {
  layout: (root: string) => string | null;
  miss: (root: string, candidate: string | null) => string;
}): ExeChainStep {
  const probe = (injection: ExeCandidateProbes): { hit: string | null; miss?: string } => {
    try {
      const root = (injection.npmRoot ?? npmRootGlobal)();
      const candidate = input.layout(root);
      if (candidate !== null && existsSync(candidate)) return { hit: candidate };
      return { hit: null, miss: input.miss(root, candidate) };
    } catch (e) {
      return { hit: null, miss: `npm root -g 探测失败：${e instanceof Error ? e.message : String(e)}` };
    }
  };
  return {
    resolveFirst: probe,
    listAll: (injection) => {
      const r = probe(injection);
      return r.hit !== null ? [r.hit] : [];
    },
  };
}

/** PATH 兜底步工厂（where/which 只用于「找到路径」，spawn 仍直连该绝对路径）：resolve 取首个 adoptFirst 行、并集全收 adoptAll 行——两过滤独立声明（claude 在 posix 上 resolve 只认 .exe、并集收非 .cmd 的现行差异保持） */
export function pathLookupExeStep(input: {
  name: string;
  adoptFirst: (line: string) => boolean;
  adoptAll: (line: string) => boolean;
}): ExeChainStep {
  const lines = (injection: ExeCandidateProbes): string[] =>
    (injection.pathLookup ?? ((name: string) => lookupAllPathLines(name)))(input.name);
  return {
    resolveFirst: (injection) => ({
      hit: lines(injection).find(input.adoptFirst) ?? null,
      miss: `where/which 未解析到 ${input.name} 可执行文件（.cmd shim 不采用）`,
    }),
    listAll: (injection) => lines(injection).filter(input.adoptAll),
  };
}

/** 单探测步工厂（CLI 特定位：codex 本地 node_modules vendored / opencode 原生安装目录等）：probe 返回存在的候选或 null；miss 为未命中描述（缺省静默跳过不记已尝试） */
export function probeExeStep(input: { probe: (injection: ExeCandidateProbes) => string | null; miss?: string }): ExeChainStep {
  const run = (injection: ExeCandidateProbes): { hit: string | null; miss?: string } => {
    const hit = input.probe(injection);
    return hit !== null ? { hit } : { hit: null, miss: input.miss };
  };
  return {
    resolveFirst: run,
    listAll: (injection) => {
      const r = run(injection);
      return r.hit !== null ? [r.hit] : [];
    },
  };
}

/** exe 解析结果缓存（成功才记忆、失败不缓存可重试；各消费方持实例、实现单源——arch C4） */
export class ExeResolveCache {
  private readonly byCli = new Map<string, string>();

  /**
   * 按 CLI 解析并缓存（命中直接返回）。
   * shortcut: options（manualOverride 等）在同一实例同一 cli 下须保持不变（与既有三处内联缓存同语义）；运行时热改 cliExe 覆盖路径需新建实例——复查触发条件 = adapter 生命周期改为跟随 config 热更新。
   */
  resolve(spec: ExeChainSpec, options: ExeChainOptions = {}): string {
    const hit = this.byCli.get(spec.cli);
    if (hit !== undefined) return hit;
    const exe = resolveExeChain(spec, options);
    this.byCli.set(spec.cli, exe);
    return exe;
  }
}

/**
 * spawn 阶段失败的协议映射单点（#46，arch C4 收口——原 8 处调用点手抄）：
 * ExeNotFoundError → AdapterError("E_SPAWN_NOT_FOUND")（协议级，renderer classify 归 spawn_not_found 卡）；
 * AdapterError 原样透传；其余包装 E_INTERNAL——context 存在时 `${context}：${msg}`，缺省裸消息。
 */
export function mapSpawnFailure(e: unknown, context?: string): AdapterError {
  if (e instanceof ExeNotFoundError) return new AdapterError("E_SPAWN_NOT_FOUND", e.message);
  if (e instanceof AdapterError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new AdapterError("E_INTERNAL", context ? `${context}：${msg}` : msg);
}
