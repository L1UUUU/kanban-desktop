// 用途：cli:status 探测服务（issue #80，spec #75 实现决策 7）—— 三真实 CLI exe 探测聚合与缓存语义（已装结果进程内缓存、未装不缓存——重开菜单即重探，装完无需重启自动恢复）；探测经注入面可测，真实装配 = 各 CLI 现有 resolveXxxExe 解析链（manualOverride 透传 + KANBAN_DISABLE_* 旁路），e2e 装配 = 种子 JSON 每次重读（支持探测翻转）
import { readFileSync } from "node:fs";
import type { CliInstalledMap } from "@kanban/ipc-schema";
import { resolveClaudeExe, resolveCodexExe, resolveOpenCodeExe } from "@kanban/cli-host";

/** 三个 CLI 各自的同步探测（true=已装；真实实现 = resolveXxxExe 不抛即装） */
export interface CliStatusProbes {
  codex(): boolean;
  claude(): boolean;
  opencode(): boolean;
}

/** 每次查询逐 CLI 聚合：已装缓存直接采纳，未缓存项现场探测（探测结果 true 才入缓存） */
export function createCliStatusService(probes: CliStatusProbes): () => Promise<CliInstalledMap> {
  const installed = new Set<keyof CliStatusProbes>();
  return async () => {
    const out: CliInstalledMap = { codex: false, claude: false, opencode: false };
    for (const cli of ["codex", "claude", "opencode"] as const) {
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

/** 真实探测装配选项（config cliExe 手动覆盖透传给各解析链） */
export interface RealCliProbesOptions {
  codexExe?: string | null;
  claudeExe?: string | null;
  opencodeExe?: string | null;
}

/** 解析链注入面（缺省真实 resolveXxxExe；密封测试注入记录型替身，不触本机 npm/PATH） */
export interface ExeResolverSeam {
  codex(options: { manualOverride?: string | null }): string;
  claude(options: { manualOverride?: string | null }): string;
  opencode(options: { manualOverride?: string | null }): string;
}

/**
 * 真实探测装配：KANBAN_DISABLE_*_X=1 时该 CLI 直接视为可用（会话实际回落 Fake 演示模式，菜单点击有效，
 * 不宜灰置——与 worker 侧 desktop-adapters 同一开关语义）；否则走解析链，ExeNotFoundError=未装，其余异常视为未装并可选上报。
 */
export function createRealCliProbes(
  options: RealCliProbesOptions = {},
  env: NodeJS.ProcessEnv = process.env,
  resolvers: ExeResolverSeam = { codex: resolveCodexExe, claude: resolveClaudeExe, opencode: resolveOpenCodeExe },
): CliStatusProbes {
  const one = (cli: keyof ExeResolverSeam, disabled: boolean, manualOverride: string | null | undefined): boolean => {
    if (disabled) return true; // Fake 回落：点击有效，保持可选
    try {
      resolvers[cli]({ manualOverride: manualOverride ?? null });
      return true;
    } catch {
      return false; // 解析链唯一设计出口 ExeNotFoundError=未装；其余异常同样不拦菜单（点击后由创建链报错）
    }
  };
  return {
    codex: () => one("codex", env.KANBAN_DISABLE_CODEX === "1", options.codexExe),
    claude: () => one("claude", env.KANBAN_DISABLE_CLAUDE === "1", options.claudeExe),
    opencode: () => one("opencode", env.KANBAN_DISABLE_OPENCODE === "1", options.opencodeExe),
  };
}

/**
 * e2e 种子探测装配（KANBAN_TEST_CLI_STATUS_JSON，参照 KANBAN_TEST_RESIDUE_JSON 思路）：
 * 每次探测重读种子 JSON（{codex,claude,opencode} 布尔对象，缺键/文件损坏均视为未装），
 * 测试改写文件即完成「探测翻转」；种子存在时完全替代真实探测（与 DISABLE 开关解耦）。
 */
export function createSeededCliProbes(seedPath: string, log?: (message: string) => void): CliStatusProbes {
  const read = (): Partial<Record<keyof CliStatusProbes, boolean>> => {
    try {
      const raw = JSON.parse(readFileSync(seedPath, "utf8")) as Record<string, unknown>;
      return {
        codex: raw.codex === true,
        claude: raw.claude === true,
        opencode: raw.opencode === true,
      };
    } catch (e) {
      log?.(`cli:status 种子文件不可读（${seedPath}）：${e instanceof Error ? e.message : String(e)}`);
      return {};
    }
  };
  return {
    codex: () => read().codex === true,
    claude: () => read().claude === true,
    opencode: () => read().opencode === true,
  };
}
