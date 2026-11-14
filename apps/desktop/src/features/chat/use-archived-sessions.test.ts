// 用途：use-archived-sessions 密封测试（issue #74）—— fake transport 直驱：三通道载荷精确断言、成功/失败/降级三态、错误面自持（行保留可重试）、留痕条目（经 lib/logger sink 断言 scope=chat）
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { IpcRequest, IpcResult, SessionRow } from "@kanban/ipc-schema";
import type { ChatTransport } from "../../lib/kanban-api";
import { setLogSinkForTest } from "../../lib/logger";
import { useArchivedSessions } from "./use-archived-sessions";

afterEach(() => {
  window.api = undefined;
});

/** 归档行 fixture（archivedAt 必填；其余按需覆盖） */
function archRow(p: { id: string; projectId?: string | null }): SessionRow {
  return {
    id: p.id,
    kind: "structured",
    cli: "codex",
    nativeSessionId: "native-" + p.id,
    projectId: p.projectId ?? null,
    title: "会话 " + p.id,
    cwd: "C:\\repo",
    permMode: "auto",
    status: "idle",
    lastActiveAt: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    archivedAt: "2026-11-11T08:00:00.000Z",
    dirIdentity: "none",
    worktreeName: null,
  };
}

const R1 = archRow({ id: "r1", projectId: "p-1" });
const R2 = archRow({ id: "r2", projectId: null });

/** 留痕断言 sink：收齐 (level,scope,message,ctx) 条目 */
function logSink(): { entries: { level: string; scope: string; message: string; ctx?: unknown }[]; restore: () => void } {
  const entries: { level: string; scope: string; message: string; ctx?: unknown }[] = [];
  const restore = setLogSinkForTest((level, scope, message, ctx) => entries.push({ level, scope, message, ctx }));
  return { entries, restore };
}

/**
 * 可编程 fake transport：按 channel 返回 results 队列.shift()（无队列回退 map 项），记录全部请求；
 * channel 标 `throw` 的直接 reject（模拟桥异常）
 */
function makeTransport(opts: {
  results?: Record<string, unknown[]>;
  throws?: Record<string, number>;
} = {}): { transport: ChatTransport; requests: IpcRequest[] } {
  const requests: IpcRequest[] = [];
  const queues: Record<string, unknown[]> = Object.fromEntries(
    Object.entries(opts.results ?? {}).map(([k, v]) => [k, [...v]]),
  );
  const throws: Record<string, number> = { ...opts.throws };
  const transport: ChatTransport = {
    invoke: async (req) => {
      requests.push(req);
      const channel = req.channel;
      if (throws[channel] && throws[channel] > 0) {
        throws[channel] -= 1;
        throw new Error("桥异常（注入）");
      }
      const q = queues[channel];
      const res = q ? q.shift() : undefined;
      if (res === undefined) return { ok: false, error: { code: "E_INTERNAL", message: `未桩化的通道：${channel}` } };
      return res as IpcResult;
    },
    onEvent: () => () => undefined,
    onTerminalEvent: () => () => undefined,
    onTrackerEvent: () => () => undefined,
  };
  return { transport, requests };
}

describe("useArchivedSessions：拉取（session:archivedList）", () => {
  it("refresh 发出 {channel:'session:archivedList'}；成功装载数据（sessions 缺省为空数组）、清残留错误", async () => {
    const { transport, requests } = makeTransport({
      results: { "session:archivedList": [{ ok: false, error: { code: "E_INTERNAL", message: "读库失败" } }, { ok: true, sessions: [R1, R2] }] },
    });
    const { result } = renderHook(() => useArchivedSessions(transport));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.error?.message).toContain("读库失败"));
    expect(result.current.rows).toBeNull();
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.rows?.map((r) => r.id)).toEqual(["r1", "r2"]));
    expect(result.current.error).toBeNull();
    expect(requests).toEqual([{ channel: "session:archivedList" }, { channel: "session:archivedList" }]);
  });

  it("sessions 载荷缺省 → 空数组（空态由视图渲染）；拉取异常 → IPC 调用异常文案", async () => {
    const { transport } = makeTransport({ results: { "session:archivedList": [{ ok: true }] } });
    const { result } = renderHook(() => useArchivedSessions(transport));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.rows).toEqual([]));
    expect(result.current.error).toBeNull();
  });

  it("拉取异常（reject）→ 统一兜底 code=E_INTERNAL（arch D10 按 code 断言，文案由载体单源保证），rows 不动", async () => {
    const { transport } = makeTransport({ throws: { "session:archivedList": 1 } });
    const { result } = renderHook(() => useArchivedSessions(transport));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.error?.code).toBe("E_INTERNAL"));
    expect(result.current.rows).toBeNull();
  });

  it("transport=null 降级：refresh/unarchive/remove 全 no-op，rows 恒 null 不发任何请求", () => {
    const restored: SessionRow[] = [];
    const { result } = renderHook(() => useArchivedSessions(null, (row) => restored.push(row)));
    act(() => {
      result.current.refresh();
      result.current.unarchive(R1);
      result.current.remove(R1);
    });
    expect(result.current.rows).toBeNull();
    expect(result.current.error).toBeNull();
    expect(restored).toEqual([]);
  });
});

describe("useArchivedSessions：取消归档（session:unarchive）", () => {
  it("成功：载荷仅 channel+sessionId；行移出；onRestored 携带该行（AppShell 接 registerRestored 回默认列表）", async () => {
    const { transport, requests } = makeTransport({
      results: { "session:archivedList": [{ ok: true, sessions: [R1, R2] }], "session:unarchive": [{ ok: true }] },
    });
    const restored: SessionRow[] = [];
    const { result } = renderHook(() => useArchivedSessions(transport, (row) => restored.push(row)));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    act(() => result.current.unarchive(R1));
    await waitFor(() => expect(result.current.rows?.map((r) => r.id)).toEqual(["r2"]));
    expect(requests).toContainEqual({ channel: "session:unarchive", sessionId: "r1" });
    expect(restored.map((r) => r.id)).toEqual(["r1"]);
    expect(result.current.error).toBeNull();
  });

  it("失败（ok:false）：错误文案直达 message、行保留、不回调、留痕 scope=chat", async () => {
    const sink = logSink();
    try {
      const { transport } = makeTransport({
        results: {
          "session:archivedList": [{ ok: true, sessions: [R1, R2] }],
          "session:unarchive": [{ ok: false, error: { code: "E_INTERNAL", message: "当前 CLI 不支持会话收养，无法取消归档：claude" } }],
        },
      });
      const restored: SessionRow[] = [];
      const { result } = renderHook(() => useArchivedSessions(transport, (row) => restored.push(row)));
      act(() => result.current.refresh());
      await waitFor(() => expect(result.current.rows).toHaveLength(2));
      act(() => result.current.unarchive(R1));
      await waitFor(() => expect(result.current.error?.message).toContain("无法取消归档"));
      expect(result.current.rows?.map((r) => r.id)).toEqual(["r1", "r2"]); // 行保留可重试
      expect(restored).toEqual([]);
      expect(sink.entries).toEqual([{ level: "error", scope: "chat", message: "取消归档失败", ctx: { sessionId: "r1" } }]);
    } finally {
      sink.restore();
    }
  });

  it("异常（reject）：统一兜底 code=E_INTERNAL（arch D10 按 code 断言）+ 留痕，行保留", async () => {
    const sink = logSink();
    try {
      const { transport } = makeTransport({
        results: { "session:archivedList": [{ ok: true, sessions: [R1] }] },
        throws: { "session:unarchive": 1 },
      });
      const { result } = renderHook(() => useArchivedSessions(transport));
      act(() => result.current.refresh());
      await waitFor(() => expect(result.current.rows).toHaveLength(1));
      act(() => result.current.unarchive(R1));
      await waitFor(() => expect(result.current.error?.code).toBe("E_INTERNAL"));
      expect(result.current.rows?.map((r) => r.id)).toEqual(["r1"]);
      expect(sink.entries).toEqual([{ level: "error", scope: "chat", message: "取消归档失败", ctx: { sessionId: "r1" } }]);
    } finally {
      sink.restore();
    }
  });
});

describe("useArchivedSessions：删除（session:delete）", () => {
  it("成功：载荷仅 channel+sessionId；行移出；不触发 onRestored", async () => {
    const { transport, requests } = makeTransport({
      results: { "session:archivedList": [{ ok: true, sessions: [R1, R2] }], "session:delete": [{ ok: true }] },
    });
    const restored: SessionRow[] = [];
    const { result } = renderHook(() => useArchivedSessions(transport, (row) => restored.push(row)));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    act(() => result.current.remove(R2));
    await waitFor(() => expect(result.current.rows?.map((r) => r.id)).toEqual(["r1"]));
    expect(requests).toContainEqual({ channel: "session:delete", sessionId: "r2" });
    expect(restored).toEqual([]);
  });

  it("失败（ok:false）：错误文案、行保留、留痕「删除已归档会话失败」", async () => {
    const sink = logSink();
    try {
      const { transport } = makeTransport({
        results: {
          "session:archivedList": [{ ok: true, sessions: [R1] }],
          "session:delete": [{ ok: false, error: { code: "E_INTERNAL", message: "解除看板关联失败：数据库锁定" } }],
        },
      });
      const { result } = renderHook(() => useArchivedSessions(transport));
      act(() => result.current.refresh());
      await waitFor(() => expect(result.current.rows).toHaveLength(1));
      act(() => result.current.remove(R1));
      await waitFor(() => expect(result.current.error?.message).toContain("数据库锁定"));
      expect(result.current.rows?.map((r) => r.id)).toEqual(["r1"]); // 行保留可重试
      expect(sink.entries).toEqual([{ level: "error", scope: "chat", message: "删除已归档会话失败", ctx: { sessionId: "r1" } }]);
    } finally {
      sink.restore();
    }
  });
});
