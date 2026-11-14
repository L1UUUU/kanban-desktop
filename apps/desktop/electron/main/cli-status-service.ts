// 用途：cli:status 探测服务（issue #80，spec #75 实现决策 7）—— 真实 CLI（名单/解析链/回切开关名单源 = cli-host CLI_REGISTRY，arch D5）exe 探测聚合与缓存语义（已装结果进程内缓存、未装不缓存——重开菜单即重探，装完无需重启自动恢复）；探测经注入面可测，真实装配 = 注册表解析链（manualOverride 透传 + KANBAN_DISABLE_* 旁路），e2e 装配 = 种子 JSON 每次重读（支持探测翻转）
import { readFileSync } from "node:fs";
import type { CliExeConfig, CliInstalledMap, RealCliKind } from "@kanban/ipc-schema";
import { CLI_REGISTRY, REAL_CLI_KINDS, resolveCliExe } from "@kanban/cli-host";

/** 各真实 CLI 的同步探测（true=已装；真实实现 = 注册表链解析不抛即装，名单随注册表扩展） */
export type CliStatusProbes = Readonly<Record<RealCliKind, () => boolean>>;

/** 每次查询逐 CLI 聚合：已装缓存直接采纳，未缓存项现场探测（探测结果 true 才入缓存） */
export function createCliStatusService(probes: CliStatusProbes): () => Promise<CliInstalledMap> {
  const installed = new Set<RealCliKind>();
  return async () => {
    // 输出名单/初值遍历注册表派生（键序 = 注册表列举序）
    const out = Object.fromEntries(REAL_CLI_KINDS.map((cli) => [cli, false])) as CliInstalledMap;
    for (const cli of REAL_CLI_KINDS) {
      if (installed.has(cli)) {
        out[cli] = true;
        continue;
      }
      if (probes[cli]()) installed.add(cli); // 已装才缓存；未装不缓存（下次查询重探）
      out[cli] = installed.has(cli);
    }
    return out;
  };
}

/** 真实探测装配选项（config cliExe 节整体透传给注册表解析链；新增 CLI 无需改本面） */
export interface RealCliProbesOptions {
  cliExe?: CliExeConfig;
}

/** 解析链注入面（缺省真实注册表链；密封测试注入记录型替身，不触本机 npm/PATH） */
export type ExeResolverSeam = Readonly<Record<RealCliKind, (options: { manualOverride?: string | null }) => string>>;

/** 缺省解析面：逐 CLI 经注册表链解析（自 CLI_REGISTRY 派生，不另抄 cli 名；键完备性由注册表断言钉住） */
function registryChainResolvers(): ExeResolverSeam {
  return Object.fromEntries(
    REAL_CLI_KINDS.map((cli) => [cli, (o: { manualOverride?: string | null }): string => resolveCliExe(cli, o)]),
  ) as ExeResolverSeam;
}

/**
 * 真实探测装配：KANBAN_DISABLE_*=1（开关名单源 = 注册表 disableEnv 元数据，与 worker 侧 desktop-adapters 同一开关语义）时
 * 该 CLI 直接视为可用（会话实际回落 Fake 演示模式，菜单点击有效，不宜灰置）；否则走解析链，ExeNotFoundError=未装，其余异常视为未装并可选上报。
 */
export function createRealCliProbes(
  options: RealCliProbesOptions = {},
  env: NodeJS.ProcessEnv = process.env,
  resolvers: ExeResolverSeam = registryChainResolvers(),
): CliStatusProbes {
  const one = (cli: RealCliKind): boolean => {
    if (env[CLI_REGISTRY[cli].disableEnv] === "1") return true; // Fake 回落：点击有效，保持可选
    try {
      resolvers[cli]({ manualOverride: options.cliExe?.[cli] ?? null });
      return true;
    } catch {
      return false; // 解析链唯一设计出口 ExeNotFoundError=未装；其余异常同样不拦菜单（点击后由创建链报错）
    }
  };
  return Object.fromEntries(REAL_CLI_KINDS.map((cli) => [cli, () => one(cli)])) as CliStatusProbes;
}

/**
 * e2e 种子探测装配（KANBAN_TEST_CLI_STATUS_JSON，参照 KANBAN_TEST_RESIDUE_JSON 思路）：
 * 每次探测重读种子 JSON（布尔对象，键 = 注册表名单，缺键/文件损坏均视为未装），
 * 测试改写文件即完成「探测翻转」；种子存在时完全替代真实探测（与 DISABLE 开关解耦）。
 */
export function createSeededCliProbes(seedPath: string, log?: (message: string) => void): CliStatusProbes {
  const read = (): Record<RealCliKind, boolean> => {
    try {
      const raw = JSON.parse(readFileSync(seedPath, "utf8")) as Record<string, unknown>;
      return Object.fromEntries(REAL_CLI_KINDS.map((cli) => [cli, raw[cli] === true])) as Record<RealCliKind, boolean>;
    } catch (e) {
      log?.(`cli:status 种子文件不可读（${seedPath}）：${e instanceof Error ? e.message : String(e)}`);
      return Object.fromEntries(REAL_CLI_KINDS.map((cli) => [cli, false])) as Record<RealCliKind, boolean>;
    }
  };
  return Object.fromEntries(REAL_CLI_KINDS.map((cli) => [cli, () => read()[cli] === true])) as CliStatusProbes;
}
