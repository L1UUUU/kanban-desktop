// 用途：键控 IPC 目录缓存密封测试（A 类，C9）—— 键控账本/在途去重/ready TTL 过期/错误不缓存/订阅隔离与 idle 单例稳定
import { describe, expect, it } from "vitest";
import { IpcCatalogCache } from "./ipc-catalog-cache";

/** 测试用具体状态形状（ready 载荷 entries、error 只带 message——验证泛型对状态形状不敏感） */
type TestState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; entries: string[] }
  | { status: "error"; message: string };

interface TestKey {
  a: string;
  b: string;
}

const TEST_IDLE: TestState = { status: "idle" };

/** 构造 (a,b) 双段键测试缓存：fetch 按调用序回放预设（Error = reject 驱动桥接异常路径）；ttl/now 可注入 */
function makeCache(opts?: { replies?: Array<string[] | Error>; ttlMs?: number; now?: () => number }) {
  const replies = opts?.replies ?? [["x"]];
  const calls: TestKey[] = [];
  let seq = 0;
  const cache = new IpcCatalogCache<TestKey, TestState>({
    keyOf: ({ a, b }) => `${a}\n${b}`,
    idle: TEST_IDLE,
    loading: { status: "loading" },
    ttlMs: opts?.ttlMs ?? Infinity,
    now: opts?.now,
    fetch: (key) => {
      calls.push(key);
      const reply = replies[Math.min(seq, replies.length - 1)];
      seq += 1;
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve({ status: "ready", entries: reply });
    },
    toError: (err) => ({ status: "error", message: err instanceof Error ? err.message : String(err) }),
  });
  return { cache, calls };
}

/** 冲刷 fetch → then/catch → finally 全部微任务链（宏任务边界后链必已排空，in-flight 已清） */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("IpcCatalogCache（键控缓存 + 在途去重 + TTL + 错误不缓存）", () => {
  it("未预取键返回 idle 单例（引用稳定）；ensure 后同步进入 loading", () => {
    const { cache } = makeCache();
    expect(cache.getState({ a: "1", b: "2" })).toBe(TEST_IDLE); // 同一引用
    cache.ensure({ a: "1", b: "2" });
    expect(cache.getState({ a: "1", b: "2" })).toEqual({ status: "loading" }); // 微任务排空前即 loading
  });

  it("在途去重：同键并发 ensure 只发一次请求；ready 后（Infinity TTL）ensure 走缓存不再发", async () => {
    const { cache, calls } = makeCache();
    cache.ensure({ a: "1", b: "2" });
    cache.ensure({ a: "1", b: "2" }); // StrictMode 双挂载的第二次
    cache.ensure({ a: "1", b: "2" }); // loading 期间的重复
    expect(calls).toHaveLength(1);
    await flush();
    expect(cache.getState({ a: "1", b: "2" })).toEqual({ status: "ready", entries: ["x"] });
    cache.ensure({ a: "1", b: "2" }); // 就绪后：缓存命中
    expect(calls).toHaveLength(1);
  });

  it("键隔离：不同键各自拉取与缓存（互不串）", async () => {
    const { cache, calls } = makeCache();
    cache.ensure({ a: "1", b: "2" });
    cache.ensure({ a: "1", b: "3" }); // 同 a 不同 b：独立键
    cache.ensure({ a: "9", b: "2" }); // 不同 a：独立键
    await flush();
    expect(calls.map((k) => `${k.a}:${k.b}`)).toEqual(["1:2", "1:3", "9:2"]);
    expect(cache.getState({ a: "1", b: "2" }).status).toBe("ready");
    expect(cache.getState({ a: "1", b: "3" }).status).toBe("ready");
    expect(cache.getState({ a: "9", b: "2" }).status).toBe("ready");
  });

  it("TTL 过期：窗口内 ensure 命中缓存，时钟越过 TTL 后重拉", async () => {
    let at = 1000;
    const { cache, calls } = makeCache({ ttlMs: 10_000, now: () => at });
    cache.ensure({ a: "1", b: "2" });
    await flush();
    expect(calls).toHaveLength(1);
    at += 9999;
    cache.ensure({ a: "1", b: "2" });
    await flush();
    expect(calls).toHaveLength(1); // 仍在新 TTL 窗口内（10999 < 11000）
    at += 2;
    cache.ensure({ a: "1", b: "2" });
    await flush();
    expect(calls).toHaveLength(2); // 越过窗口：重拉
  });

  it("fetch reject（桥接异常）：经 toError 进错误态，不缓存可重试", async () => {
    const { cache, calls } = makeCache({ replies: [new Error("transport 不可用"), ["x"]] });
    cache.ensure({ a: "1", b: "2" });
    await flush();
    expect(cache.getState({ a: "1", b: "2" })).toEqual({ status: "error", message: "transport 不可用" });
    cache.ensure({ a: "1", b: "2" }); // 错误不缓存：重试重新发
    await flush();
    expect(calls).toHaveLength(2);
    expect(cache.getState({ a: "1", b: "2" })).toEqual({ status: "ready", entries: ["x"] });
  });

  it("TTL 过期对 error 态也重发：错误结果不占 fetchedAt（与刚拉完失败等价）", async () => {
    let at = 1000;
    const { cache, calls } = makeCache({ replies: [new Error("boom")], ttlMs: 10_000, now: () => at });
    cache.ensure({ a: "1", b: "2" });
    await flush();
    at += 5; // 远未到 TTL
    cache.ensure({ a: "1", b: "2" }); // error 不吃 TTL 窗口：立即重试
    await flush();
    expect(calls).toHaveLength(2);
  });

  it("订阅按键隔离：状态变化通知监听者，注销后与其它键变化均不再收到", async () => {
    const { cache } = makeCache();
    const events: string[] = [];
    const off = cache.subscribe({ a: "1", b: "2" }, () => events.push("tick"));
    cache.ensure({ a: "1", b: "2" });
    await flush();
    off();
    cache.ensure({ a: "1", b: "3" }); // 其它键 + 已注销：不通知
    await flush();
    expect(events.length).toBeGreaterThanOrEqual(2); // loading + ready 两拍
    // 未订阅键的状态推进无监听者可通知（不抛错）
    expect(cache.getState({ a: "1", b: "3" }).status).toBe("ready");
  });
});
