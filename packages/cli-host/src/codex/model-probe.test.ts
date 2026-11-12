// 用途：模型探测回退单测 —— mock client 验证候选链（显式直试探→env 偏好白名单→缓存→rollout→model/list）、显式失败不回退（spec #75 存量 bug 修正）、缓存命中免试探
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultModelResolver, latestRolloutModel, type ProbeClient } from "./model-probe";

/** mock 探测 client：thread/start 记录候选，turn/start 按该候选是否在 okModels 决定 completed/error（异步通知）；calls 记录全部 RPC 方法名 */
function makeMockClient(opts: { okModels: string[]; listModels?: string[] }) {
  const channels = new Map<string, Set<(p: unknown) => void>>();
  const state = { probes: [] as string[], calls: [] as string[] };
  const client: ProbeClient = {
    async request(method: string, params?: unknown) {
      state.calls.push(method);
      if (method === "model/list") {
        return { data: (opts.listModels ?? []).map((id) => ({ id })) };
      }
      if (method === "thread/start") {
        state.probes.push(String((params as { model?: string })?.model));
        return { thread: { id: `th-${state.probes.length}` } };
      }
      if (method === "turn/start") {
        const threadId = `th-${state.probes.length}`;
        const model = state.probes.at(-1) ?? "";
        queueMicrotask(() => {
          const ok = opts.okModels.includes(model);
          fire(ok ? "turn/completed" : "error", ok ? { threadId, turn: { status: "completed" } } : { threadId, willRetry: false });
        });
        return {};
      }
      return {};
    },
    on(method: string, fn: (p: unknown) => void) {
      if (!channels.has(method)) channels.set(method, new Set());
      channels.get(method)!.add(fn);
      return () => {
        channels.get(method)?.delete(fn);
      };
    },
  };
  function fire(method: string, params: unknown): void {
    for (const fn of channels.get(method) ?? []) fn(params);
  }
  return { client, state };
}

describe("latestRolloutModel", () => {
  it("本机 sessions 目录存在/缺失均不抛错", () => {
    const v = latestRolloutModel();
    expect(v === null || typeof v === "string").toBe(true);
  });
});

describe("createDefaultModelResolver 候选链（mock 试探）", () => {
  it("显式模型试探成功 → 直接采用；缓存后免二次试探", async () => {
    const { client, state } = makeMockClient({ okModels: ["m-good"] });
    const resolve = createDefaultModelResolver({ preferredModels: [] });
    expect(await resolve("m-good", client)).toBe("m-good");
    expect(await resolve(undefined, client)).toBe("m-good"); // 内存缓存命中
    expect(state.probes.length).toBe(1); // 仅试探一次
  });

  it("显式模型 400 失败 → 直接抛错含模型名，不回退候选（spec #75 存量 bug 修正：不静默换模型）", async () => {
    const { client, state } = makeMockClient({ okModels: ["m-list-a"], listModels: ["m-list-a"] });
    const resolve = createDefaultModelResolver({ preferredModels: [], rolloutModel: null });
    await expect(resolve("m-broken", client)).rejects.toThrow(/m-broken/);
    expect(state.probes).toEqual(["m-broken"]); // 只试探显式模型，未回退试探 model/list 候选
  });

  it("显式模型不被内存缓存劫持：第一个会话缓存 A 后，第二个会话显式选 B 仍得到 B", async () => {
    const { client, state } = makeMockClient({ okModels: ["m-a", "m-b"], listModels: [] });
    const resolve = createDefaultModelResolver({ preferredModels: [], rolloutModel: null });
    expect(await resolve("m-a", client)).toBe("m-a");
    expect(await resolve("m-b", client)).toBe("m-b"); // 不返回内存缓存 m-a
    expect(state.probes).toEqual(["m-a", "m-b"]); // 显式各试探一次
  });

  it("显式模型不被磁盘缓存劫持：历史缓存 A 不拦截显式 B 的直接试探", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kanban-probe-explicit-"));
    writeFileSync(path.join(dir, "codex-model-probe.json"), JSON.stringify({ model: "m-disk", version: null, probedAt: "2026-01-01T00:00:00.000Z" }), "utf8");
    const { client, state } = makeMockClient({ okModels: ["m-explicit"], listModels: [] });
    const resolve = createDefaultModelResolver({ preferredModels: [], cacheDir: dir, rolloutModel: null });
    expect(await resolve("m-explicit", client)).toBe("m-explicit");
    expect(state.probes).toEqual(["m-explicit"]); // 真试探而非读磁盘缓存
  });

  it("未指定仍走缓存与回退链：磁盘缓存命中免试探；无缓存时按候选链回退", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kanban-probe-unset-"));
    writeFileSync(path.join(dir, "codex-model-probe.json"), JSON.stringify({ model: "m-disk", version: null, probedAt: "2026-01-01T00:00:00.000Z" }), "utf8");
    const cached = makeMockClient({ okModels: [], listModels: [] });
    const resolveCached = createDefaultModelResolver({ preferredModels: [], cacheDir: dir, rolloutModel: null });
    expect(await resolveCached(undefined, cached.client)).toBe("m-disk"); // 磁盘缓存命中
    expect(cached.state.probes).toEqual([]); // 免试探
    const { client, state } = makeMockClient({ okModels: ["m-list-a"], listModels: ["m-list-a"] });
    const resolve = createDefaultModelResolver({ preferredModels: [], rolloutModel: null });
    expect(await resolve(undefined, client)).toBe("m-list-a"); // 回退链兜底
    expect(state.probes).toEqual(["m-list-a"]);
  });

  it("全部候选失败 → 明确中文报错", async () => {
    const { client } = makeMockClient({ okModels: [], listModels: ["m1"] });
    const resolve = createDefaultModelResolver({ preferredModels: [], rolloutModel: null });
    await expect(resolve(undefined, client)).rejects.toThrow(/未探测到可用的 Codex 模型/);
  });
});

describe("createDefaultModelResolver env 偏好白名单（KANBAN_CODEX_MODEL）", () => {
  afterEach(() => {
    delete process.env.KANBAN_CODEX_MODEL;
  });

  it("首选可用即用，且不触碰磁盘缓存/rollout/model-list", async () => {
    const { client, state } = makeMockClient({ okModels: ["gpt-6-luna"], listModels: ["m-list-a"] });
    const resolve = createDefaultModelResolver({ preferredModels: ["gpt-6-luna", "gpt-5.6-luna"], rolloutModel: "m-sol" });
    expect(await resolve(undefined, client)).toBe("gpt-6-luna");
    expect(state.probes).toEqual(["gpt-6-luna"]);
    expect(state.calls).not.toContain("model/list"); // 白名单分支不读 model/list
  });

  it("首选 400 失败 → 按序回退次选", async () => {
    const { client, state } = makeMockClient({ okModels: ["gpt-5.6-luna"], listModels: ["m-list-a"] });
    const resolve = createDefaultModelResolver({ preferredModels: ["gpt-6-luna", "gpt-5.6-luna"], rolloutModel: "m-sol" });
    expect(await resolve(undefined, client)).toBe("gpt-5.6-luna");
    expect(state.probes).toEqual(["gpt-6-luna", "gpt-5.6-luna"]);
  });

  it("偏好优先于磁盘缓存：历史 sol 缓存不劫持白名单", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kanban-probe-env-"));
    writeFileSync(path.join(dir, "codex-model-probe.json"), JSON.stringify({ model: "gpt-5.6-sol", version: null, probedAt: "2026-01-01T00:00:00.000Z" }), "utf8");
    const { client, state } = makeMockClient({ okModels: ["gpt-6-luna"] });
    const resolve = createDefaultModelResolver({ cacheDir: dir, preferredModels: ["gpt-6-luna"], rolloutModel: "m-sol" });
    expect(await resolve(undefined, client)).toBe("gpt-6-luna");
    expect(state.probes).toEqual(["gpt-6-luna"]);
  });

  it("偏好命中不落盘缓存（不设 env 的进程行为不变）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kanban-probe-env-"));
    const { client } = makeMockClient({ okModels: ["gpt-6-luna"] });
    const resolve = createDefaultModelResolver({ cacheDir: dir, preferredModels: ["gpt-6-luna"], rolloutModel: null });
    expect(await resolve(undefined, client)).toBe("gpt-6-luna");
    expect(existsSync(path.join(dir, "codex-model-probe.json"))).toBe(false);
  });

  it("偏好全败 → 报错且不回退 rollout/model-list（成本控制）", async () => {
    const { client, state } = makeMockClient({ okModels: [], listModels: ["m-list-a"] });
    const resolve = createDefaultModelResolver({ preferredModels: ["gpt-6-luna", "gpt-5.6-luna"], rolloutModel: "m-sol" });
    await expect(resolve(undefined, client)).rejects.toThrow(/KANBAN_CODEX_MODEL/);
    expect(state.probes).toEqual(["gpt-6-luna", "gpt-5.6-luna"]);
    expect(state.calls).not.toContain("model/list");
  });

  it("未注入 preferredModels 时读真实 env 变量名", async () => {
    process.env.KANBAN_CODEX_MODEL = "gpt-6-luna,gpt-5.6-luna";
    const { client, state } = makeMockClient({ okModels: ["gpt-5.6-luna"] });
    const resolve = createDefaultModelResolver({ rolloutModel: "m-sol" });
    expect(await resolve(undefined, client)).toBe("gpt-5.6-luna");
    expect(state.probes).toEqual(["gpt-6-luna", "gpt-5.6-luna"]);
  });
});
