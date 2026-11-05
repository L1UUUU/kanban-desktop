// 用途：模型探测回退单测 —— mock client 验证候选链（显式→rollout→model/list）、400 拒绝回退、缓存命中免试探
import { describe, expect, it } from "vitest";
import { createDefaultModelResolver, latestRolloutModel, type ProbeClient } from "./model-probe";

/** mock 探测 client：thread/start 记录候选，turn/start 按该候选是否在 okModels 决定 completed/error（异步通知） */
function makeMockClient(opts: { okModels: string[]; listModels?: string[] }) {
  const channels = new Map<string, Set<(p: unknown) => void>>();
  const state = { probes: [] as string[] };
  const client: ProbeClient = {
    async request(method: string, params?: unknown) {
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
    const resolve = createDefaultModelResolver({});
    expect(await resolve("m-good", client)).toBe("m-good");
    expect(await resolve(undefined, client)).toBe("m-good"); // 内存缓存命中
    expect(state.probes.length).toBe(1); // 仅试探一次
  });

  it("显式模型 400 失败 → 回退到可用候选（不再用失败模型）", async () => {
    const { client, state } = makeMockClient({ okModels: ["m-list-a"], listModels: ["m-list-a"] });
    const resolve = createDefaultModelResolver({ rolloutModel: null });
    const model = await resolve("m-broken", client);
    expect(model).toBe("m-list-a");
    expect(state.probes[0]).toBe("m-broken"); // 首选显式
    expect(state.probes.length).toBe(2);
  });

  it("全部候选失败 → 明确中文报错", async () => {
    const { client } = makeMockClient({ okModels: [], listModels: ["m1"] });
    const resolve = createDefaultModelResolver({ rolloutModel: null });
    await expect(resolve("m-broken", client)).rejects.toThrow(/未探测到可用的 Codex 模型/);
  });
});
