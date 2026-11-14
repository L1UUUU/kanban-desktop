// 用途：模型目录控制器密封测试（A 类，issue #77 / spec #75；C9 键升级 (cli, cwd)）—— 键控缓存、in-flight 去重
// （StrictMode 双挂载只发一次）、错误不缓存可重试、不同 cwd 各自缓存（opencode server-per-project 行为修复）
import { describe, expect, it } from "vitest";
import type { ModelsRequest, ModelsResult } from "@kanban/ipc-schema";
import { ModelCatalog, findDefaultModel } from "./model-catalog";

/** 可编程 fetcher：记录全部请求；按调用序返回预设应答（缺省成功两条假模型） */
function makeFetcher(replies: Array<ModelsResult> = [{ ok: true, models: TEST_MODELS }]) {
  const calls: ModelsRequest[] = [];
  const fetcher = (req: ModelsRequest): Promise<ModelsResult> => {
    calls.push(req);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    return Promise.resolve(reply);
  };
  return { calls, fetcher };
}

const TEST_MODELS = [
  { id: "gpt-5.6-luna", displayName: "GPT-5.6", description: "", isDefault: true },
  { id: "gpt-6-luna", displayName: "GPT-6", description: "", isDefault: false },
];

/** 冲刷 fetch → then/catch → finally 全部微任务链（宏任务边界后链必已排空，in-flight 已清） */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("ModelCatalog（按 (cli, cwd) 键控缓存 + in-flight 去重 + 错误重试）", () => {
  it("并发预取去重：同键同步多次 prefetch 只发一次请求；就绪后再 prefetch 走缓存不再发", async () => {
    const { calls, fetcher } = makeFetcher();
    const catalog = new ModelCatalog(fetcher);
    const seen: string[] = [];
    catalog.subscribe("fake", "C:\\repo", () => seen.push(catalog.getState("fake", "C:\\repo").status));
    catalog.prefetch("fake", "C:\\repo");
    catalog.prefetch("fake", "C:\\repo"); // StrictMode 双挂载的第二次
    catalog.prefetch("fake", "C:\\repo"); // loading 期间的重复
    expect(catalog.getState("fake", "C:\\repo")).toEqual({ status: "loading" });
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ channel: "models:list", cli: "fake", cwd: "C:\\repo" });
    expect(catalog.getState("fake", "C:\\repo")).toEqual({ status: "ready", models: TEST_MODELS });
    catalog.prefetch("fake", "C:\\repo"); // 就绪后：缓存命中，不再发
    expect(calls).toHaveLength(1);
    expect(seen).toEqual(["loading", "ready"]); // 状态推进各通知一次
  });

  it("键 (cli, cwd) 独立（C9 行为修复：opencode server-per-project，多项目目录不串）：不同 cwd 各自缓存与拉取", async () => {
    const seen: string[] = [];
    const catalog = new ModelCatalog((req) => {
      seen.push(`${req.cli}:${req.cwd}`);
      return Promise.resolve({ ok: true, models: TEST_MODELS } satisfies ModelsResult);
    });
    catalog.prefetch("opencode", "C:/a");
    catalog.prefetch("opencode", "C:/b"); // 同 cli 不同 cwd：独立键，各发一次
    await flush();
    expect(seen).toEqual(["opencode:C:/a", "opencode:C:/b"]);
    expect(catalog.getState("opencode", "C:/a").status).toBe("ready");
    expect(catalog.getState("opencode", "C:/b").status).toBe("ready");
    catalog.prefetch("opencode", "C:/a"); // 各自缓存命中
    catalog.prefetch("opencode", "C:/b");
    expect(seen).toHaveLength(2);
  });

  it("错误不缓存：失败态可重试，重试成功进就绪", async () => {
    const { calls, fetcher } = makeFetcher([
      { ok: false, error: { code: "E_SPAWN_NOT_FOUND", message: "未找到 codex 可执行文件" } },
      { ok: true, models: TEST_MODELS },
    ]);
    const catalog = new ModelCatalog(fetcher);
    catalog.prefetch("codex", "C:\\repo");
    await flush();
    expect(catalog.getState("codex", "C:\\repo")).toEqual({ status: "error", code: "E_SPAWN_NOT_FOUND", message: "未找到 codex 可执行文件" });
    catalog.prefetch("codex", "C:\\repo"); // 错误不缓存：重试重新发
    await flush();
    expect(calls).toHaveLength(2);
    expect(catalog.getState("codex", "C:\\repo")).toEqual({ status: "ready", models: TEST_MODELS });
  });

  it("fetcher 抛异常（桥接不可用等）：进错误态不缓存，可重试", async () => {
    let fail = true;
    const calls: ModelsRequest[] = [];
    const catalog = new ModelCatalog((req) => {
      calls.push(req);
      return fail ? Promise.reject(new Error("transport 不可用")) : Promise.resolve({ ok: true, models: TEST_MODELS } satisfies ModelsResult);
    });
    catalog.prefetch("claude", "C:\\repo");
    await flush();
    expect(catalog.getState("claude", "C:\\repo")).toEqual({ status: "error", code: "E_INTERNAL", message: "transport 不可用" });
    fail = false;
    catalog.prefetch("claude", "C:\\repo");
    await flush();
    expect(calls).toHaveLength(2);
    expect(catalog.getState("claude", "C:\\repo")).toEqual({ status: "ready", models: TEST_MODELS });
  });

  it("未预取的键为 idle；不同 cli 同 cwd 缓存互不影响", async () => {
    const { fetcher } = makeFetcher();
    const catalog = new ModelCatalog(fetcher);
    expect(catalog.getState("fake", "C:\\repo")).toEqual({ status: "idle" });
    catalog.prefetch("fake", "C:\\repo");
    await flush();
    expect(catalog.getState("fake", "C:\\repo").status).toBe("ready");
    expect(catalog.getState("codex", "C:\\repo")).toEqual({ status: "idle" });
  });

  it("订阅按键隔离：其他键的状态变化不打扰", async () => {
    const { fetcher } = makeFetcher();
    const catalog = new ModelCatalog(fetcher);
    const codexSeen: string[] = [];
    catalog.subscribe("codex", "C:\\repo", () => codexSeen.push(catalog.getState("codex", "C:\\repo").status));
    catalog.prefetch("fake", "C:\\repo"); // 只动 fake 键
    await flush();
    expect(codexSeen).toEqual([]);
  });
});

describe("findDefaultModel（默认项派生，单一事实源 isDefault）", () => {
  it("返回 isDefault 项；无默认项返回 undefined", () => {
    expect(findDefaultModel(TEST_MODELS)?.id).toBe("gpt-5.6-luna");
    expect(findDefaultModel([TEST_MODELS[1]])).toBeUndefined();
  });
});
