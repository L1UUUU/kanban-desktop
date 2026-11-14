// 用途：exe 解析链骨架直测（arch C4）—— 链顺序（manual→env→步序首个命中）、候选并集与 resolve 同链派生、三类步工厂的探测注入与过滤、结果缓存命中/失败可重试、spawn 阶段错误映射单点与注册表一致性；探测全部经注入替换，不触真实子进程
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdapterError, ExeNotFoundError } from "./adapter";
import {
  ExeResolveCache,
  listExeChainCandidates,
  mapSpawnFailure,
  npmGlobalExeStep,
  pathLookupExeStep,
  probeExeStep,
  resolveExeChain,
  type ExeChainSpec,
} from "./exe-chain";
import { EXE_CHAINS } from "./exe-registry";

// 临时目录统一登记清理
const tmpRoots: string[] = [];
afterEach(() => {
  for (const p of tmpRoots.splice(0)) rmSync(p, { recursive: true, force: true });
});

/** 在临时根下创建一个存在的文件并返回其绝对路径 */
function touch(rel: string): string {
  const root = mkdtempSync(join(tmpdir(), "kb-exe-chain-"));
  tmpRoots.push(root);
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "", "utf8");
  return full;
}

/** 测试链 A：npm 全局步 + PATH 兜底步（win32 语义：resolve 与并集都只认 .exe） */
function chainA(): ExeChainSpec {
  return {
    cli: "fake",
    envVar: "KANBAN_FAKE_BIN",
    steps: [
      npmGlobalExeStep({
        layout: (root) => join(root, "fake-pkg", "bin", "fake.exe"),
        miss: (_root, candidate) => `npm 全局 ${candidate} 不存在`,
      }),
      pathLookupExeStep({
        name: "fake",
        adopt: (line) => line.toLowerCase().endsWith(".exe"),
      }),
    ],
  };
}

describe("resolveExeChain（链顺序）", () => {
  it("manual > env > npm 步 > PATH 步，首个存在命中即返回", () => {
    const manual = touch(join("m", "fake.exe"));
    const envExe = touch(join("e", "fake.exe"));
    const npmRoot = mkdtempSync(join(tmpdir(), "kb-exe-chain-npm-"));
    tmpRoots.push(npmRoot);
    const npmExe = join(npmRoot, "fake-pkg", "bin", "fake.exe");
    mkdirSync(join(npmExe, ".."), { recursive: true });
    writeFileSync(npmExe, "", "utf8");
    const pathExe = touch(join("p", "fake.exe"));
    const probes = { npmRoot: () => npmRoot, pathLookup: () => [pathExe] };
    process.env.KANBAN_FAKE_BIN = envExe;
    try {
      expect(resolveExeChain(chainA(), { manualOverride: manual, ...probes })).toBe(manual);
      expect(resolveExeChain(chainA(), { manualOverride: join(npmRoot, "missing.exe"), ...probes })).toBe(envExe);
      delete process.env.KANBAN_FAKE_BIN;
      expect(resolveExeChain(chainA(), probes)).toBe(npmExe);
      // npm 步落空（布局不存在）→ PATH 兜底
      expect(resolveExeChain(chainA(), { npmRoot: () => join(npmRoot, "empty"), pathLookup: () => [pathExe] })).toBe(pathExe);
    } finally {
      delete process.env.KANBAN_FAKE_BIN;
    }
  });

  it("全链落空 → ExeNotFoundError：已尝试逐环记录（manual/env 缺失 + 各步 miss）", () => {
    const missing = join(tmpdir(), "kb-exe-chain-missing.exe");
    process.env.KANBAN_FAKE_BIN = join(tmpdir(), "kb-exe-chain-env-missing.exe");
    try {
      const err = (() => {
        try {
          resolveExeChain(chainA(), { manualOverride: missing, npmRoot: () => "C:\\definitely\\missing" });
        } catch (e) {
          return e as Error;
        }
        throw new Error("应抛 ExeNotFoundError");
      })();
      expect(err).toBeInstanceOf(ExeNotFoundError);
      expect(err.message).toContain(`手动覆盖 ${missing}（不存在）`);
      expect(err.message).toContain("KANBAN_FAKE_BIN=");
      expect(err.message).toContain("（不存在）");
      expect(err.message).toContain(`npm 全局 ${join("C:\\definitely\\missing", "fake-pkg", "bin", "fake.exe")} 不存在`);
      expect(err.message).toContain("where/which 未解析到 fake 可执行文件（.cmd shim 不采用）");
      expect(err.message).toContain("未找到 fake 可执行文件");
      expect(err.message).toContain("请在设置中手动指定 fake.exe 路径或设置 KANBAN_FAKE_BIN。");
    } finally {
      delete process.env.KANBAN_FAKE_BIN;
    }
  });

  it("npm root -g 探测失败 → 记「npm root -g 探测失败」；零步链落空 → 已尝试记「无」", () => {
    const spec: ExeChainSpec = {
      cli: "fake2",
      envVar: "KANBAN_FAKE2_BIN",
      steps: [npmGlobalExeStep({ layout: (root) => join(root, "x.exe"), miss: (_r, c) => `npm 全局 ${c} 不存在` })],
    };
    try {
      resolveExeChain(spec, { npmRoot: () => { throw new Error("boom"); } });
      throw new Error("应抛 ExeNotFoundError");
    } catch (e) {
      expect(e).toBeInstanceOf(ExeNotFoundError);
      expect((e as Error).message).toContain("npm root -g 探测失败：boom");
    }
    const bare: ExeChainSpec = { cli: "bare", envVar: "KANBAN_BARE_BIN", steps: [] };
    try {
      resolveExeChain(bare);
      throw new Error("应抛 ExeNotFoundError");
    } catch (e) {
      expect((e as Error).message).toContain("已尝试：无");
    }
  });
});

describe("listExeChainCandidates（并集与 resolve 同链派生）", () => {
  it("各步存在候选全收（PATH 多行）、链序拼接、去重（win32 大小写/斜杠归一）", () => {
    const manual = touch(join("m", "fake.exe"));
    const npmRoot = mkdtempSync(join(tmpdir(), "kb-exe-chain-npm-"));
    tmpRoots.push(npmRoot);
    const npmExe = join(npmRoot, "fake-pkg", "bin", "fake.exe");
    mkdirSync(join(npmExe, ".."), { recursive: true });
    writeFileSync(npmExe, "", "utf8");
    const where1 = "C:\\tools\\FAKE.EXE";
    const shim = "C:\\shim\\fake.cmd";
    const got = listExeChainCandidates(chainA(), {
      manualOverride: manual,
      npmRoot: () => npmRoot,
      pathLookup: () => [npmExe.replace(/\\/g, "/"), where1, shim],
    });
    const norm = (p: string): string => p.toLowerCase().replace(/\//g, "\\");
    // 斜杠异形 npmExe 去重只留步序首见原形；.cmd shim 不收
    expect(got.map(norm)).toEqual([norm(manual), norm(npmExe), norm(where1)]);
  });

  it("manual/env 路径不存在不入并集（与 resolve 采纳条件一致——同一条链）", () => {
    expect(
      listExeChainCandidates(chainA(), {
        manualOverride: "C:\\no\\such.exe",
        npmRoot: () => "C:\\definitely\\missing",
        pathLookup: () => [],
      }),
    ).toEqual([]);
  });
});

describe("步工厂（探测注入与过滤）", () => {
  it("pathLookupExeStep：resolve 取首个 adopt 行、并集全收 adopt 行（单一谓词，两出口条件一致——arch D4）", () => {
    const step = pathLookupExeStep({
      name: "fake",
      adopt: (line) => !line.toLowerCase().endsWith(".cmd"),
    });
    const lines = ["/bin/fake", "/bin/fake.exe", "/bin/fake.cmd"];
    const inj = { pathLookup: () => lines };
    expect(step.resolveFirst(inj)).toEqual({ hit: "/bin/fake", miss: "where/which 未解析到 fake 可执行文件（.cmd shim 不采用）" });
    expect(step.listAll(inj)).toEqual(["/bin/fake", "/bin/fake.exe"]);
  });

  it("probeExeStep：miss 缺省时未命中静默不记；声明时记入已尝试", () => {
    const silent = probeExeStep({ probe: () => null });
    expect(silent.resolveFirst({})).toEqual({ hit: null, miss: undefined });
    const loud = probeExeStep({ probe: () => null, miss: "特定位 X 不存在" });
    expect(loud.resolveFirst({})).toEqual({ hit: null, miss: "特定位 X 不存在" });
    const hit = probeExeStep({ probe: () => "C:\\x\\fake.exe", miss: "特定位 X 不存在" });
    expect(hit.resolveFirst({})).toEqual({ hit: "C:\\x\\fake.exe" });
    expect(hit.listAll({})).toEqual(["C:\\x\\fake.exe"]);
    expect(silent.listAll({})).toEqual([]);
  });

  it("npmGlobalExeStep：list 模式探测失败静默无候选（miss 仅 resolve 模式记录）", () => {
    const step = npmGlobalExeStep({ layout: (root) => join(root, "x.exe"), miss: (_r, c) => `npm 全局 ${c} 不存在` });
    const inj = { npmRoot: () => { throw new Error("nope"); } };
    expect(step.listAll(inj)).toEqual([]);
  });
});

describe("ExeResolveCache（缓存单源）", () => {
  it("命中不重复探测；失败不缓存可重试", () => {
    let calls = 0;
    // 经 npm 步计数（npmRoot 每次真实调用）
    const counting: ExeChainSpec = {
      cli: "cached",
      envVar: "KANBAN_CACHED_BIN",
      steps: [npmGlobalExeStep({ layout: (root) => join(root, "ok.exe"), miss: (_r, c) => `npm 全局 ${c} 不存在` })],
    };
    const cache = new ExeResolveCache();
    // 第一次：探测失败 → 抛错不缓存
    try {
      cache.resolve(counting, { npmRoot: () => { calls++; throw new Error("boom"); } });
      throw new Error("应抛错");
    } catch (e) {
      expect(e).toBeInstanceOf(ExeNotFoundError);
    }
    // 第二次：换可用注入 → 重试成功（证明失败未缓存）
    const root = mkdtempSync(join(tmpdir(), "kb-exe-chain-cache-"));
    tmpRoots.push(root);
    const exe = join(root, "ok.exe");
    writeFileSync(exe, "", "utf8");
    expect(cache.resolve(counting, { npmRoot: () => { calls++; return root; } })).toBe(exe);
    // 第三次：命中不再探测
    expect(cache.resolve(counting, { npmRoot: () => { calls++; return root; } })).toBe(exe);
    expect(calls).toBe(2);
  });
});

describe("mapSpawnFailure（spawn 阶段错误映射单点）", () => {
  it("ExeNotFoundError → E_SPAWN_NOT_FOUND 原消息；AdapterError 原样透传；其余包装 E_INTERNAL", () => {
    const notFound = new ExeNotFoundError("未找到 fake 可执行文件");
    const mapped = mapSpawnFailure(notFound);
    expect(mapped).toBeInstanceOf(AdapterError);
    expect(mapped.code).toBe("E_SPAWN_NOT_FOUND");
    expect(mapped.message).toBe("未找到 fake 可执行文件");

    const adapterErr = new AdapterError("E_SESSION_NOT_FOUND", "会话不存在");
    expect(mapSpawnFailure(adapterErr)).toBe(adapterErr); // 同一实例透传

    const plain = mapSpawnFailure(new Error("boom"), "创建 Fake 会话失败");
    expect(plain.code).toBe("E_INTERNAL");
    expect(plain.message).toBe("创建 Fake 会话失败：boom");

    const bare = mapSpawnFailure("字符串错误");
    expect(bare.code).toBe("E_INTERNAL");
    expect(bare.message).toBe("字符串错误");
  });
});

describe("EXE_CHAINS（注册表一致性）", () => {
  it("三 CLI 齐备且 spec.cli 与注册键一致（run-once 分发与缓存键的单源前提）", () => {
    expect(Object.keys(EXE_CHAINS)).toEqual(["claude", "codex", "opencode"]);
    for (const [key, spec] of Object.entries(EXE_CHAINS)) {
      expect(spec.cli).toBe(key);
      expect(spec.envVar).toMatch(/^KANBAN_[A-Z]+_BIN$/);
      expect(spec.steps.length).toBeGreaterThan(0);
    }
  });
});
