// 用途：cli:status 探测服务密封测试（#80，spec #75 实现决策 7）—— ①缓存语义只经 createCliStatusService 公共面观察：已装结果进程内缓存后不再探测、未装每次重探、探测翻转（模拟装完）后下次查询恢复可选且缓存从此生效；②真实探测装配（解析链注入 + DISABLE 旁路 + manualOverride 透传）；③e2e 种子探测（每次重读，改写文件即翻转）
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExeNotFoundError } from "@kanban/cli-host";
import {
  createCliStatusService,
  createRealCliProbes,
  createSeededCliProbes,
  type CliStatusProbes,
  type ExeResolverSeam,
} from "./cli-status-service";

/** 可翻转计数探测（state 改值即模拟安装/卸载，calls 记录探测次数） */
function makeProbes(initial: { codex: boolean; claude: boolean; opencode: boolean }) {
  const state = { ...initial };
  const calls = { codex: 0, claude: 0, opencode: 0 };
  const probes: CliStatusProbes = {
    codex: () => {
      calls.codex += 1;
      return state.codex;
    },
    claude: () => {
      calls.claude += 1;
      return state.claude;
    },
    opencode: () => {
      calls.opencode += 1;
      return state.opencode;
    },
  };
  return { state, calls, probes };
}

describe("cli:status 探测缓存语义（#80）", () => {
  it("装/未装两态查询：已装项查询一次后不再探测（进程内缓存），未装项每次查询重探", async () => {
    const { calls, probes } = makeProbes({ codex: true, claude: false, opencode: false });
    const status = createCliStatusService(probes);

    const first = await status();
    expect(first).toEqual({ codex: true, claude: false, opencode: false });
    expect(calls).toEqual({ codex: 1, claude: 1, opencode: 1 });

    const second = await status();
    expect(second).toEqual({ codex: true, claude: false, opencode: false });
    expect(calls).toEqual({ codex: 1, claude: 2, opencode: 2 }); // 已装 codex 不再探测，未装两项重探
  });

  it("探测翻转（模拟装完）：未装项下次查询恢复可选并从此缓存——缓存后翻回未装也不影响结果", async () => {
    const { state, calls, probes } = makeProbes({ codex: true, claude: false, opencode: false });
    const status = createCliStatusService(probes);

    expect((await status()).claude).toBe(false);

    state.claude = true; // 模拟装完 CLI（无需重启）
    expect((await status()).claude).toBe(true);
    expect(calls.claude).toBe(2); // 未装不缓存：翻转被下次查询看见

    state.claude = false; // 已装缓存后翻回，不再探测
    expect((await status()).claude).toBe(true);
    expect(calls.claude).toBe(2);
  });
});

describe("真实探测装配 createRealCliProbes（#80：解析链注入可测）", () => {
  /** 记录型解析链替身（per cli 可配抛 ExeNotFoundError 或返回路径；不触本机 npm/PATH） */
  function makeResolvers(
    outcome: { codex: "ok" | "missing"; claude: "ok" | "missing"; opencode: "ok" | "missing" },
  ): { resolvers: ExeResolverSeam; received: Record<string, Array<{ manualOverride?: string | null }>> } {
    const received: Record<string, Array<{ manualOverride?: string | null }>> = { codex: [], claude: [], opencode: [] };
    const resolvers: ExeResolverSeam = {
      codex: (o) => {
        received.codex.push(o);
        if (outcome.codex === "missing") throw new ExeNotFoundError("未找到 codex");
        return "C:\\npm\\codex.exe";
      },
      claude: (o) => {
        received.claude.push(o);
        if (outcome.claude === "missing") throw new ExeNotFoundError("未找到 claude");
        return "C:\\npm\\claude.exe";
      },
      opencode: (o) => {
        received.opencode.push(o);
        if (outcome.opencode === "missing") throw new ExeNotFoundError("未找到 opencode");
        return "C:\\npm\\opencode.exe";
      },
    };
    return { resolvers, received };
  }

  it("装/未装两态：解析链返回路径=已装，抛 ExeNotFoundError=未装；config 手动覆盖逐 cli 透传给解析链", () => {
    const { resolvers, received } = makeResolvers({ codex: "ok", claude: "missing", opencode: "ok" });
    const probes = createRealCliProbes(
      { codexExe: "C:\\cfg\\codex.exe", claudeExe: null, opencodeExe: undefined },
      {},
      resolvers,
    );
    expect(probes.codex()).toBe(true);
    expect(probes.claude()).toBe(false);
    expect(probes.opencode()).toBe(true);
    expect(received.codex).toEqual([{ manualOverride: "C:\\cfg\\codex.exe" }]);
    expect(received.claude).toEqual([{ manualOverride: null }]);
  });

  it("KANBAN_DISABLE_*=1 旁路：该 CLI 直接视为可用（会话实际回落 Fake，菜单点击有效不灰置），且不触解析链", () => {
    const { resolvers, received } = makeResolvers({ codex: "missing", claude: "missing", opencode: "missing" });
    const probes = createRealCliProbes({}, { KANBAN_DISABLE_CODEX: "1" }, resolvers);
    expect(probes.codex()).toBe(true);
    expect(probes.claude()).toBe(false);
    expect(received.codex).toEqual([]);
  });

  it("解析链抛非 ExeNotFoundError 异常同样归为未装（不向上冒泡拦截查询）", () => {
    const resolvers: ExeResolverSeam = {
      codex: () => {
        throw new Error("npm root -g 超时");
      },
      claude: () => "C:\\npm\\claude.exe",
      opencode: () => {
        throw new Error("fs 异常");
      },
    };
    const probes = createRealCliProbes({}, {}, resolvers);
    expect(probes.codex()).toBe(false);
    expect(probes.opencode()).toBe(false);
  });
});

describe("e2e 种子探测 createSeededCliProbes（#80：KANBAN_TEST_CLI_STATUS_JSON）", () => {
  let tmpRoot = "";

  afterEach(() => {
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = "";
    }
  });

  it("按种子文件应答装/未装；每次探测重读文件——改写即翻转（驱动「装完重开菜单恢复」整机用例）", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-cli-status-seed-"));
    const seedPath = join(tmpRoot, "cli-status.json");
    writeFileSync(seedPath, JSON.stringify({ codex: true, claude: false, opencode: true }), "utf8");
    const probes = createSeededCliProbes(seedPath);

    expect(probes.codex()).toBe(true);
    expect(probes.claude()).toBe(false);

    writeFileSync(seedPath, JSON.stringify({ codex: true, claude: true, opencode: true }), "utf8");
    expect(probes.claude()).toBe(true); // 未装结果本就不缓存：重读即恢复
  });

  it("文件缺失/损坏/缺键均视为未装（不抛错），损坏时经 log 上报一次可定位信息", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-cli-status-seed-"));
    const seedPath = join(tmpRoot, "cli-status.json");
    writeFileSync(seedPath, "{oops", "utf8");
    const logs: string[] = [];
    const probes = createSeededCliProbes(seedPath, (m) => logs.push(m));
    expect(probes.codex()).toBe(false);
    expect(probes.claude()).toBe(false);
    expect(probes.opencode()).toBe(false);
    expect(logs.length).toBeGreaterThan(0);

    const missing = createSeededCliProbes(join(tmpRoot, "nope.json"));
    expect(missing.codex()).toBe(false);
  });
});
