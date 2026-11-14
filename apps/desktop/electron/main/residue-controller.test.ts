// 用途：残留治理控制器密封测试 —— 三态装配（E2E 种子 fake / 隔离环境短路空清单 / 真实探测）+ 每启动一次检测缓存 + 终止透传（fake 恒 killed / 真实 killPid 分派）
import { describe, expect, it } from "vitest";
import type { ResidueProcess } from "@kanban/ipc-schema";
import { createResidueController } from "./residue-controller";
import type { CimProcessRecord, CliExeCandidateSets, ResidueServiceDeps } from "./residue-service";

/** 残留行工厂（缺省合法最小形状） */
function proc(over: Partial<ResidueProcess> & { pid: number }): ResidueProcess {
  return { exePath: "C:/cli/cli.exe", startedAt: null, sessionTitle: null, suspectedSessionTitle: null, ...over };
}

/** 计数真实探测面（可选注入固定 CIM 记录与 killPid 行为） */
function makeRealDeps(over: { candidates?: CliExeCandidateSets; processes?: CimProcessRecord[]; killPid?: (pid: number) => { ok: boolean; error?: string } } = {}) {
  const calls = { listCandidates: 0, queryProcesses: 0, listActivePids: 0, killPid: 0 };
  const deps: ResidueServiceDeps = {
    listCandidates: () => {
      calls.listCandidates += 1;
      return over.candidates ?? { codex: [], claude: [], opencode: [] };
    },
    queryProcesses: () => {
      calls.queryProcesses += 1;
      return over.processes ?? [];
    },
    listActivePids: async () => {
      calls.listActivePids += 1;
      return [];
    },
    registryPath: "C:/nonexistent/opencode-servers.json", // 注册表不存在 → readServerRegistry 空清单（不经 registry 分支）
    listSessions: () => [],
    killPid: (pid) => {
      calls.killPid += 1;
      return over.killPid ? over.killPid(pid) : { ok: true };
    },
  };
  return { deps, calls };
}

describe("createResidueController 三态装配", () => {
  it("种子态：detectOnce 返回种子清单（重复调用同源缓存），真实探测面零调用；kill 恒 killed（fake pid 不真实存在）", async () => {
    const seed = [proc({ pid: 101 }), proc({ pid: 102 })];
    const { deps, calls } = makeRealDeps();
    const c = createResidueController({ seed, e2eIsolated: true, realDeps: deps });
    expect(await c.detectOnce()).toBe(seed); // 种子原样（同一数组引用）
    expect(await c.detectOnce()).toBe(seed); // 每启动一次：第二次命中缓存
    expect(calls).toEqual({ listCandidates: 0, queryProcesses: 0, listActivePids: 0, killPid: 0 }); // 真实探测面不被触碰
    expect(await c.kill([101, 999])).toEqual([
      { pid: 101, status: "killed" },
      { pid: 999, status: "killed" },
    ]);
    expect(calls.killPid).toBe(0); // fake killPid 生效（真实 killPid 未被调用）
  });

  it("隔离态（无种子 + e2eIsolated）：detectOnce 恒空清单且不发起任何真实探测；kill 仍走真实 killPid 透传", async () => {
    const { deps, calls } = makeRealDeps();
    const c = createResidueController({ seed: null, e2eIsolated: true, realDeps: deps });
    expect(await c.detectOnce()).toEqual([]);
    expect(await c.detectOnce()).toEqual([]); // 缓存同源（探测计数不增）
    expect(calls.listCandidates).toBe(0);
    expect(calls.queryProcesses).toBe(0);
    expect(calls.listActivePids).toBe(0);
    expect(await c.kill([7])).toEqual([{ pid: 7, status: "killed" }]);
    expect(calls.killPid).toBe(1); // 终止不经 fake（隔离态只短路检测，终止保持真实）
  });

  it("真实态：detectOnce 走 detectResidue（候选并集匹配 → 输出按 pid 升序）；重复调用同一缓存 Promise 不重探", async () => {
    // 候选与记录同 exe（比较键归一后命中 codex 归属）
    const { deps, calls } = makeRealDeps({
      candidates: { codex: ["C:/cli/cli.exe"], claude: [], opencode: [] },
      processes: [
        { pid: 202, exePath: "C:/cli/cli.exe", commandLine: null, startedAt: "2026-01-01T00:00:00.000Z" },
        { pid: 201, exePath: "C:/cli/cli.exe", commandLine: null, startedAt: null },
        { pid: 203, exePath: "C:/other/unrelated.exe", commandLine: null, startedAt: null }, // 候选外：不列残留
      ],
    });
    const c = createResidueController({ seed: null, e2eIsolated: false, realDeps: deps });
    const first = await c.detectOnce();
    expect(first.map((p) => p.pid)).toEqual([201, 202]); // 升序 + 候选外排除
    expect(first[0]).toMatchObject({ exePath: "C:/cli/cli.exe" });
    await c.detectOnce();
    expect(calls.listCandidates).toBe(1); // 第二次命中缓存：真实探测只发生一次
    expect(calls.queryProcesses).toBe(1);
  });

  it("真实态 kill：透传 killResidue 逐 pid killed/failed 独立回报", async () => {
    const { deps } = makeRealDeps({ killPid: (pid) => (pid === 5 ? { ok: true } : { ok: false, error: "拒绝访问" }) });
    const c = createResidueController({ seed: null, e2eIsolated: false, realDeps: deps });
    expect(await c.kill([5, 6])).toEqual([
      { pid: 5, status: "killed" },
      { pid: 6, status: "failed", error: "拒绝访问" },
    ]);
  });
});
