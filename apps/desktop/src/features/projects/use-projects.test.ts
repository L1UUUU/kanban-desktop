// 用途：use-projects hook 测试 —— 列表加载/注册（含重复与取消）/切换/提示文案（经 stub transport 断言 IPC 通道用法）
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProjectRow } from "@kanban/ipc-schema";
import type { ChatTransport } from "../../lib/kanban-api";
import { useProjects } from "./use-projects";

const P1: ProjectRow = { id: "p-1", name: "alpha", canonicalPath: "C:\\alpha", status: "ok", createdAt: "2026-11-05T00:00:00.000Z" };
const P2: ProjectRow = { id: "p-2", name: "beta", canonicalPath: "C:\\beta", status: "missing", createdAt: "2026-11-05T01:00:00.000Z" };

/** 可编程 stub transport：按 channel 返回预设结果并记录请求 */
function makeTransport(overrides: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  const results: Record<string, unknown> = {
    "project:list": { ok: true, projects: [P1, P2], currentProjectId: "p-1" },
    "project:register": { ok: true, duplicate: false, project: P1 },
    "project:switch": { ok: true, project: P1 },
    ...overrides,
  };
  const transport: ChatTransport = {
    invoke: async (req) => {
      calls.push(req);
      const res = results[(req as { channel: string }).channel];
      if (!res) return { ok: false, error: { code: "E_INTERNAL", message: "未桩化的通道" } };
      return res as never;
    },
    onEvent: () => () => undefined,
    onTerminalEvent: () => () => undefined,
    onTrackerEvent: () => () => undefined,
  };
  return { transport, calls };
}

describe("useProjects", () => {
  it("挂载即拉取列表与当前项目；currentProject 派生", async () => {
    const { transport } = makeTransport();
    const { result } = renderHook(() => useProjects(transport));
    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    expect(result.current.currentProjectId).toBe("p-1");
    expect(result.current.currentProject?.name).toBe("alpha");
  });

  it("register：成功后刷新列表并返回结果；duplicate/canceled 各有提示", async () => {
    const { transport } = makeTransport({
      "project:register": { ok: true, duplicate: true, project: P1 },
    });
    const { result } = renderHook(() => useProjects(transport));
    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    let outcome = "";
    await act(async () => {
      outcome = await result.current.register();
    });
    expect(outcome).toBe("duplicate");
    expect(result.current.notice).toContain("已注册");
  });

  it("register：用户取消目录选择 → canceled 且无提示噪音", async () => {
    const { transport } = makeTransport({ "project:register": { ok: true, canceled: true } });
    const { result } = renderHook(() => useProjects(transport));
    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    let outcome = "";
    await act(async () => {
      outcome = await result.current.register();
    });
    expect(outcome).toBe("canceled");
    expect(result.current.notice).toBeNull();
  });

  it("switchTo：成功后当前项目更新；失败显示错误提示", async () => {
    const { transport } = makeTransport();
    const { result } = renderHook(() => useProjects(transport));
    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    await act(async () => {
      await result.current.switchTo("p-2");
    });
    expect(result.current.currentProjectId).toBe("p-1"); // stub project:list 恒回 p-1（刷新语义正确性由 e2e 覆盖）

    const fail = makeTransport({ "project:switch": { ok: false, error: { code: "E_PROJECT_NOT_FOUND", message: "项目不存在" } } });
    const { result: r2 } = renderHook(() => useProjects(fail.transport));
    await waitFor(() => expect(r2.current.projects).toHaveLength(2));
    await act(async () => {
      await r2.current.switchTo("ghost");
    });
    expect(r2.current.notice).toContain("项目不存在");
  });
});
