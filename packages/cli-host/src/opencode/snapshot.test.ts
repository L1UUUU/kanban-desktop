// 用途：opencode wire 快照读取器密封直测 —— 两形态解析（{items} 壳 / 裸数组）、空响应兜底、HTTP 失败与传输异常经 result 交付（注入 fake client，不依赖真实 server）
import { describe, expect, it, vi } from "vitest";
import { readCommandSnapshot, readMessageSnapshot } from "./snapshot";
import type { OpenCodeApiResponse } from "./client";

/** 构造只实现 api 的 fake client（读取器依赖面仅此一个方法），应答脚本化并记录调用 */
function fakeClient(respond: (method: string, path: string) => OpenCodeApiResponse) {
  const api = vi.fn(async (method: string, path: string) => respond(method, path));
  return { client: { api }, calls: api.mock.calls as Array<[method: string, path: string]> };
}

const ok = (json: unknown): OpenCodeApiResponse => ({ status: 200, ok: true, json, text: JSON.stringify(json ?? "") });
const fail = (status: number, json: unknown, text: string): OpenCodeApiResponse => ({ status, ok: false, json, text });

describe("readMessageSnapshot：GET /session/{id}/message 双形态解析", () => {
  it("请求路径带 limit=500；{items} 壳形态原样采用", async () => {
    const items = [{ info: { id: "msg_1", role: "assistant" }, parts: [{ type: "text", text: "hi" }] }];
    const { client, calls } = fakeClient(() => ok({ items }));
    const r = await readMessageSnapshot(client, "ses_1");
    expect(r).toEqual({ ok: true, items, error: null });
    expect(calls).toEqual([["GET", "/session/ses_1/message?limit=500"]]);
  });

  it("裸数组形态兜底采用", async () => {
    const items = [{ info: { id: "msg_2" }, parts: [] }];
    const r = await readMessageSnapshot(fakeClient(() => ok(items)).client, "ses_1");
    expect(r.ok).toBe(true);
    expect(r.items).toEqual(items);
  });

  it("空响应兜底 []：json null / 无 items / items null", async () => {
    for (const json of [null, {}, { items: null }] as unknown[]) {
      const r = await readMessageSnapshot(fakeClient(() => ok(json)).client, "ses_1");
      expect(r.ok).toBe(true);
      expect(r.items).toEqual([]);
    }
  });

  it("壳判定是空值链（??）：items 非 null 即采用（非数组也透传，交消费点既有 catch 处置）", async () => {
    const r = await readMessageSnapshot(fakeClient(() => ok({ items: 5 })).client, "ses_1");
    expect(r.ok).toBe(true);
    expect(r.items as unknown).toBe(5);
  });

  it("HTTP 非 2xx：ok=false，error 为 HTTP 状态行（text 截 160），items 空", async () => {
    const r = await readMessageSnapshot(fakeClient(() => fail(500, null, "x".repeat(300))).client, "ses_1");
    expect(r.ok).toBe(false);
    expect(r.error?.message).toBe(`HTTP 500 ${"x".repeat(160)}`);
    expect(r.items).toEqual([]);
  });

  it("传输异常不抛：ok=false，error 透传原始异常", async () => {
    const r = await readMessageSnapshot(
      fakeClient(() => {
        throw new Error("opencode server 请求失败（GET /session/ses_1/message?limit=500）：fetch failed");
      }).client,
      "ses_1",
    );
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("fetch failed");
    expect(r.items).toEqual([]);
  });
});

describe("readCommandSnapshot：GET /command 双形态解析", () => {
  it("{items} 壳形态原样采用（条目可为 null，透传交消费点判空）", async () => {
    const items = [{ name: "share", description: "分享" }, null];
    const r = await readCommandSnapshot(fakeClient(() => ok({ items })).client);
    expect(r).toEqual({ ok: true, items, error: null });
  });

  it("裸数组形态兜底采用；空响应兜底 []", async () => {
    const bare = [{ name: "compact" }];
    expect((await readCommandSnapshot(fakeClient(() => ok(bare)).client)).items).toEqual(bare);
    for (const json of [null, {}] as unknown[]) {
      const r = await readCommandSnapshot(fakeClient(() => ok(json)).client);
      expect(r.items).toEqual([]);
    }
  });

  it("壳判定要求数组（与 message 的空值链不同序）：items 非数组不采用", async () => {
    const r = await readCommandSnapshot(fakeClient(() => ok({ items: 5 })).client);
    expect(r.ok).toBe(true);
    expect(r.items).toEqual([]);
  });

  it("HTTP 非 2xx：ok=false + error 状态行，但 items 仍按 body 解析（knownCommands 失败也消费名单的既有语义）", async () => {
    const r = await readCommandSnapshot(fakeClient(() => fail(500, { items: [{ name: "x" }] }, "boom")).client);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toBe("HTTP 500 boom");
    expect(r.items).toEqual([{ name: "x" }]);
  });

  it("传输异常不抛：ok=false，items 空", async () => {
    const r = await readCommandSnapshot(
      fakeClient(() => {
        throw new Error("opencode server 请求失败（GET /command）：fetch failed");
      }).client,
    );
    expect(r.ok).toBe(false);
    expect(r.items).toEqual([]);
  });
});
