// 用途：残留治理控制器（arch C10 自 index.ts 出舱）—— 三态装配（E2E 种子 → 全 fake 探测面 / 隔离环境无种子 → 探测短路空清单 / 其余 → 真实 detectResidue）+ 每次启动只检测一次的 Promise 缓存（renderer 挂载拉取与 app:event 推送同源）；终止透传 killResidue（fake 形态恒 killed）
import type { ResidueKillResult, ResidueProcess } from "@kanban/ipc-schema";
import { detectResidue, killResidue, type ResidueServiceDeps } from "./residue-service";

/** 控制器输入：三态判定事实（seed / e2eIsolated）+ 真实探测面（生产 = index.ts 装配三 CLI 候选并集 + adapter 活跃集合 + 全量会话） */
export interface ResidueControllerOptions {
  /** E2E 预置检测结果（KANBAN_TEST_RESIDUE_JSON 驱动，参照 memory-seed.ts 预置思路）；非 null 进入 fake 形态：不做真实探测与终止，驱动通知条 Playwright 流程 */
  seed: ResidueProcess[] | null;
  /** 整机 e2e 隔离环境标记（KANBAN_USER_DATA 已设）：无种子时跳过机器级进程枚举恒空清单（防开发机上他人打开的真实 CLI 进程把非密封 banner 带进无关 e2e 断言） */
  e2eIsolated: boolean;
  /** 真实探测面（仅在非种子且非隔离形态被消费） */
  realDeps: ResidueServiceDeps;
}

/** 残留治理控制器：detectOnce 每次启动只检测一次（spec：就绪后一次、不轮询；重复调用返回同一缓存结果）；kill 确认式逐 pid 终止（用户显式触发，无自动清理路径） */
export interface ResidueController {
  detectOnce(): Promise<ResidueProcess[]>;
  kill(pids: number[]): Promise<ResidueKillResult[]>;
}

/** 构造控制器：seed 形态换全 fake deps（killPid 恒 ok——fake pid 不真实存在，统一回报 killed 驱动 UI 流程）；检测 Promise 只发起一次 */
export function createResidueController(opts: ResidueControllerOptions): ResidueController {
  const deps: ResidueServiceDeps = opts.seed
    ? {
        listCandidates: () => ({ codex: [], claude: [], opencode: [] }),
        queryProcesses: () => [],
        listActivePids: async () => [],
        registryPath: opts.realDeps.registryPath,
        listSessions: () => [],
        killPid: () => ({ ok: true }),
      }
    : opts.realDeps;
  let pending: Promise<ResidueProcess[]> | null = null;
  return {
    detectOnce: () =>
      (pending ??= opts.seed ? Promise.resolve(opts.seed) : opts.e2eIsolated ? Promise.resolve([]) : detectResidue(deps)),
    kill: (pids) => killResidue(deps, pids),
  };
}
