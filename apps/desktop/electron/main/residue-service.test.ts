// 用途：残留进程治理密封测试（#49 spec #40 F 节）—— detectResidue 判定（匹配为解析链候选并集 / 活跃集合排除 / 可接管 OpenCode server 排除 / 关联会话记录归属）与 killResidue 逐 pid killed/failed 回报（全程确认式，无自动清理路径）；进程枚举/活跃集合/注册表核对/终止全部注入 fake
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RegistryEntry } from "@kanban/cli-host";
import type { ResidueKillResult, ResidueProcess } from "@kanban/ipc-schema";
import { handleResidueIpc, type ResidueIpcDeps } from "./ipc";
import type { SessionRecord } from "./session-store";
import { detectResidue, killResidue, type CimProcessRecord, type ResidueServiceDeps } from "./residue-service";

const tmpFiles: string[] = [];
afterEach(() => {
  for (const p of tmpFiles.splice(0)) rmSync(p, { force: true });
});

/** fake 进程清单条目（CIM 记录形状） */
function proc(pid: number, exePath: string, extra: Partial<CimProcessRecord> = {}): CimProcessRecord {
  return { pid, exePath, commandLine: null, startedAt: "2026-11-09T01:12:00.000Z", ...extra };
}

/** fake 会话记录 */
function session(partial: Partial<SessionRecord>): SessionRecord {
  return {
    id: "s1",
    kind: "structured",
    cli: "codex",
    nativeSessionId: null,
    projectId: null,
    title: null,
    cwd: null,
    permMode: "auto",
    status: "disconnected",
    lastActiveAt: null,
    ...partial,
  };
}

/** 组装 deps（全部注入 fake：候选集 / 进程清单 / 活跃集合 / 注册表 / 会话 / 终止） */
function makeDeps(over: Partial<ResidueServiceDeps> = {}): ResidueServiceDeps {
  return {
    listCandidates: () => ({ codex: ["C:\\npm\\codex\\codex.exe"], claude: ["C:\\npm\\claude\\claude.exe"], opencode: ["C:\\npm\\opencode\\opencode.exe"] }),
    queryProcesses: () => [],
    listActivePids: async () => [],
    registryPath: join(tmpdir(), "kb-residue-missing-registry.json"),
    listSessions: () => [],
    ...over,
  };
}

describe("detectResidue 判定（fake 进程清单）", () => {
  it("匹配为解析链候选并集：非当前解析单一路径的候选位进程也列入；候选外 exe 不列入", async () => {
    const deps = makeDeps({
      // 并集含两处 codex 候选（本次解析命中的 npm 路径 + where 多结果的另一路径）
      listCandidates: () => ({ codex: ["C:\\npm\\codex\\codex.exe", "C:\\tools\\codex.exe"], claude: [], opencode: [] }),
      queryProcesses: () => [
        proc(111, "C:\\tools\\codex.exe"),
        proc(222, "C:\\unrelated\\some.exe"), // 候选外：不列入
      ],
    });
    const got = await detectResidue(deps);
    expect(got.map((r) => r.pid)).toEqual([111]);
    expect(got[0]).toMatchObject({ pid: 111, exePath: "C:\\tools\\codex.exe", sessionTitle: null });
  });

  it("本应用活跃集合排除：listChildPids 上报的 pid 不列入（win32 大小写/斜杠差异仍匹配候选）", async () => {
    const deps = makeDeps({
      listActivePids: async () => [111],
      queryProcesses: () => [
        proc(111, "c:/npm/codex/codex.exe"), // 活跃：排除
        proc(222, "C:\\npm\\codex\\codex.exe"), // 非活跃：列入
      ],
    });
    const got = await detectResidue(deps);
    expect(got.map((r) => r.pid)).toEqual([222]);
  });

  it("注册表核对通过、可接管的 OpenCode 孤儿 server 排除；核对不通过的列入", async () => {
    const regPath = join(tmpdir(), `kb-residue-reg-${Date.now()}.json`);
    tmpFiles.push(regPath);
    const entry: RegistryEntry = { cwd: "C:\\repo", exe: "C:\\npm\\opencode\\opencode.exe", pid: 333, port: 4096, spawnAt: "2026-11-09T01:00:00.000Z", cmdSignature: ["serve"] };
    writeFileSync(regPath, JSON.stringify({ entries: [entry] }), "utf8");
    const deps = makeDeps({
      registryPath: regPath,
      verifyRegistry: (e) => e.pid === 333, // 333 核对通过（可接管）；其余不通过
      queryProcesses: () => [
        proc(333, "C:\\npm\\opencode\\opencode.exe", { commandLine: '"C:\\npm\\opencode\\opencode.exe" serve --port 4096' }),
        proc(444, "C:\\npm\\opencode\\opencode.exe", { commandLine: '"C:\\npm\\opencode\\opencode.exe" serve --port 4097' }),
      ],
    });
    const got = await detectResidue(deps);
    expect(got.map((r) => r.pid)).toEqual([444]);
  });

  it("默认核对分支（不注入 verifyRegistry）：核对不通过（match:false）的孤儿 server 不被排除，仍列残留（P1 回归：默认适配须取 verifyRegistryEntry().match，返回对象恒 truthy）", async () => {
    const regPath = join(tmpdir(), `kb-residue-reg-default-${Date.now()}.json`);
    tmpFiles.push(regPath);
    // pid 0 → 真实 verifyRegistryEntry 的 pidAlive 恒 false（确定性构造 match:false，不依赖真实进程状态、无 CIM 查询副作用）
    const entry: RegistryEntry = { cwd: "C:\\repo", exe: "C:\\npm\\opencode\\opencode.exe", pid: 0, port: 4111, spawnAt: "2026-11-09T01:00:00.000Z", cmdSignature: ["serve"] };
    writeFileSync(regPath, JSON.stringify({ entries: [entry] }), "utf8");
    const deps = makeDeps({
      registryPath: regPath,
      // 关键：不注入 verifyRegistry，走生产默认适配
      queryProcesses: () => [proc(0, "C:\\npm\\opencode\\opencode.exe", { commandLine: '"C:\\npm\\opencode\\opencode.exe" serve --port 4111' })],
    });
    const got = await detectResidue(deps);
    expect(got.map((r) => r.pid)).toEqual([0]); // 核对不通过 → 不进 verifiedPids → 列残留
  });

  it("注册表文件缺失或损坏按空表处理（不抛错）", async () => {
    const badPath = join(tmpdir(), `kb-residue-bad-${Date.now()}.json`);
    tmpFiles.push(badPath);
    writeFileSync(badPath, "{not-json", "utf8");
    const deps = makeDeps({ registryPath: badPath, queryProcesses: () => [proc(555, "C:\\npm\\codex\\codex.exe")] });
    const got = await detectResidue(deps);
    expect(got.map((r) => r.pid)).toEqual([555]);
  });

  it("关联会话记录：仅精确匹配（claude 命令行 / opencode 注册表）进 sessionTitle；codex 回落同 CLI 最近会话只作 suspectedSessionTitle 疑似提示（P2：不得进 sessionTitle 触发默认勾选）；均无 → 双 null", async () => {
    const sessions: SessionRecord[] = [
      session({ id: "s-claude", cli: "claude", nativeSessionId: "native-abc", title: "实现 Diff 解析" }),
      session({ id: "s-codex", cli: "codex", title: "修复启动崩溃" }),
    ];
    const deps = makeDeps({
      listSessions: () => sessions,
      queryProcesses: () => [
        proc(666, "C:\\npm\\claude\\claude.exe", { commandLine: 'claude.exe --print --session-id native-abc' }),
        proc(777, "C:\\npm\\codex\\codex.exe", { commandLine: "codex.exe app-server" }),
        proc(888, "C:\\npm\\opencode\\opencode.exe", { commandLine: "opencode.exe serve --port 4098" }),
      ],
    });
    const got = await detectResidue(deps);
    expect(got.find((r) => r.pid === 666)).toMatchObject({ sessionTitle: "实现 Diff 解析" }); // 精确匹配：进 sessionTitle（默认勾选依据）
    expect(got.find((r) => r.pid === 777)).toMatchObject({ sessionTitle: null, suspectedSessionTitle: "修复启动崩溃" }); // 回落仅疑似提示：不进 sessionTitle
    expect(got.find((r) => r.pid === 888)).toMatchObject({ sessionTitle: null, suspectedSessionTitle: null }); // 无会话记录
  });

  it("opencode 按注册表 pid→cwd 归属会话（核对不通过仍可关联）", async () => {
    const regPath = join(tmpdir(), `kb-residue-reg2-${Date.now()}.json`);
    tmpFiles.push(regPath);
    writeFileSync(regPath, JSON.stringify({ entries: [{ cwd: "C:\\repo", exe: "C:\\npm\\opencode\\opencode.exe", pid: 999, port: 4100, spawnAt: "2026-11-09T01:00:00.000Z", cmdSignature: ["serve"] }] }), "utf8");
    const deps = makeDeps({
      registryPath: regPath,
      verifyRegistry: () => false,
      listSessions: () => [session({ id: "s-op", cli: "opencode", cwd: "C:\\repo", title: "OpenCode 会话" })],
      queryProcesses: () => [proc(999, "C:\\npm\\opencode\\opencode.exe")],
    });
    const got = await detectResidue(deps);
    expect(got.find((r) => r.pid === 999)?.sessionTitle).toBe("OpenCode 会话");
  });

  it("检测过程不调用终止（确认式：无任何自动清理路径）", async () => {
    let killed = 0;
    const deps = makeDeps({ queryProcesses: () => [proc(123, "C:\\npm\\codex\\codex.exe")], killPid: () => { killed += 1; return { ok: true }; } });
    await detectResidue(deps);
    expect(killed).toBe(0);
  });
});

describe("killResidue 逐 pid 终止", () => {
  it("逐 pid 回报 killed/failed（含失败原因），顺序与请求一致", async () => {
    const deps = makeDeps({
      killPid: (pid) => (pid === 111 ? { ok: true } : { ok: false, error: "taskkill 退出码 5：拒绝访问" }),
    });
    const got: ResidueKillResult[] = await killResidue(deps, [111, 222]);
    expect(got).toEqual([
      { pid: 111, status: "killed" },
      { pid: 222, status: "failed", error: "taskkill 退出码 5：拒绝访问" },
    ]);
  });

  it("单 pid 失败不影响其余 pid 继续（逐个独立）", async () => {
    const seen: number[] = [];
    const deps = makeDeps({ killPid: (pid) => { seen.push(pid); return pid === 1 ? { ok: false, error: "x" } : { ok: true }; } });
    const got = await killResidue(deps, [1, 2, 3]);
    expect(seen).toEqual([1, 2, 3]);
    expect(got.filter((r) => r.status === "killed").map((r) => r.pid)).toEqual([2, 3]);
  });
});

describe("handleResidueIpc（residue:ipc 通道路由）", () => {
  const base: ResidueIpcDeps = {
    detect: async (): Promise<ResidueProcess[]> => [{ pid: 111, exePath: "C:\\npm\\codex\\codex.exe", startedAt: null, sessionTitle: null }],
    kill: async (pids) => pids.map((pid) => ({ pid, status: "killed" as const })),
  };

  it("非法请求 → 业务拒绝 invalid-request；退出中 → shutting-down", async () => {
    const bad = await handleResidueIpc(base, { channel: "residue:purge" });
    expect(bad).toMatchObject({ ok: false, reason: "invalid-request" });
    const gated = await handleResidueIpc({ ...base, isShuttingDown: () => true }, { channel: "residue:detect" });
    expect(gated).toMatchObject({ ok: false, reason: "shutting-down" });
  });

  it("residue:detect 返回检测清单；residue:kill 返回逐 pid 结果", async () => {
    const detect = await handleResidueIpc(base, { channel: "residue:detect" });
    expect(detect).toMatchObject({ ok: true, processes: [{ pid: 111 }] });
    const kill = await handleResidueIpc(base, { channel: "residue:kill", pids: [111] });
    expect(kill).toMatchObject({ ok: true, results: [{ pid: 111, status: "killed" }] });
  });

  it("#53 诊断日志：safeParse 失败记一条 error（invalid-request 原样）；deps 抛错记一条后原样 rethrow（不改既有传播行为）", async () => {
    const entries: Array<{ level: string; scope: string; message: string }> = [];
    const log = (level: string, scope: string, message: string): void => { entries.push({ level, scope, message }); };
    const bad = await handleResidueIpc({ ...base, log }, { channel: "residue:purge" });
    expect(bad).toMatchObject({ ok: false, reason: "invalid-request" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: "error", scope: "residue:ipc" });
    expect(entries[0].message).toContain("invalid-request");
    await expect(
      handleResidueIpc({ ...base, detect: async (): Promise<ResidueProcess[]> => { throw new Error("探测爆炸"); }, log }, { channel: "residue:detect" }),
    ).rejects.toThrow("探测爆炸");
    expect(entries).toHaveLength(2);
    expect(entries[1].level).toBe("error");
    expect(entries[1].message).toContain("探测爆炸");
  });
});
