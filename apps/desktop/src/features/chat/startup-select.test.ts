// 用途：selectStartupSessionId 纯函数的密封测试（issue #86）—— 启动自动选中候选判定规则矩阵，独立字面量断言（非重演实现）
import { describe, expect, it } from "vitest";
import type { SessionRow } from "@kanban/ipc-schema";
import { selectStartupSessionId } from "./startup-select";

/** 构造一行 wire 会话（仅本测试关心的字段可变；其余取合法缺省） */
function row(over: Partial<SessionRow> & { id: string }): SessionRow {
  return {
    kind: "structured",
    cli: "claude",
    nativeSessionId: null,
    projectId: "p-1",
    title: null,
    cwd: "C:\\repo",
    permMode: null,
    status: "disconnected",
    lastActiveAt: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    archivedAt: null,
    dirIdentity: "none",
    worktreeName: null,
    ...over,
  };
}

describe("selectStartupSessionId（issue #86 启动自动选中候选判定）", () => {
  it("取当前项目下活跃基准最大者：lastActiveAt 新者胜（createdAt 更旧不干扰）", () => {
    const rows = [
      row({ id: "s-old", lastActiveAt: "2026-11-10T08:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z" }),
      row({ id: "s-new", lastActiveAt: "2026-11-12T09:30:00.000Z", createdAt: "2026-11-02T00:00:00.000Z" }),
    ];
    expect(selectStartupSessionId(rows, "p-1")).toBe("s-new");
  });

  it("PTY 会话排除：即便更近活跃也不选（只选中不恢复对终端无意义）", () => {
    const rows = [
      row({ id: "s-pty", kind: "pty", cli: "pty", lastActiveAt: "2026-11-12T10:00:00.000Z" }),
      row({ id: "s-structured", lastActiveAt: "2026-11-01T00:00:00.000Z" }),
    ];
    expect(selectStartupSessionId(rows, "p-1")).toBe("s-structured");
  });

  it("多项目过滤：只看当前项目会话，他项目更近活跃者不干扰", () => {
    const rows = [
      row({ id: "s-pA", projectId: "p-A", lastActiveAt: "2026-11-12T10:00:00.000Z" }),
      row({ id: "s-pB", projectId: "p-B", lastActiveAt: "2026-11-01T00:00:00.000Z" }),
    ];
    expect(selectStartupSessionId(rows, "p-B")).toBe("s-pB");
  });

  it("无当前项目时候选=无项目会话（projectId=null）；有项目会话在场不干扰", () => {
    const rows = [
      row({ id: "s-proj", projectId: "p-A", lastActiveAt: "2026-11-12T10:00:00.000Z" }),
      row({ id: "s-noproj", projectId: null, lastActiveAt: "2026-11-01T00:00:00.000Z" }),
    ];
    expect(selectStartupSessionId(rows, null)).toBe("s-noproj");
  });

  it("全部无活跃时间时取最新创建（基准回落 createdAt，与自动归档同口径）", () => {
    const rows = [
      row({ id: "s-created-early", createdAt: "2026-11-01T00:00:00.000Z", lastActiveAt: null }),
      row({ id: "s-created-late", createdAt: "2026-11-05T00:00:00.000Z", lastActiveAt: null }),
    ];
    expect(selectStartupSessionId(rows, "p-1")).toBe("s-created-late");
  });

  it("已归档行排除（wire 默认列表恒未归档，口径与自动归档守恒）", () => {
    const rows = [
      row({ id: "s-archived", lastActiveAt: "2026-11-12T10:00:00.000Z", archivedAt: "2026-11-12T11:00:00.000Z" }),
      row({ id: "s-live", lastActiveAt: "2026-11-01T00:00:00.000Z" }),
    ];
    expect(selectStartupSessionId(rows, "p-1")).toBe("s-live");
  });

  it("基准不可解析保守跳过（脏 lastActiveAt 不回落 createdAt，单源 activityBasisMs 同口径）", () => {
    const rows = [
      row({ id: "s-dirty", lastActiveAt: "not-a-date", createdAt: "2026-11-12T00:00:00.000Z" }),
      row({ id: "s-clean", lastActiveAt: "2026-11-01T00:00:00.000Z" }),
    ];
    expect(selectStartupSessionId(rows, "p-1")).toBe("s-clean");
  });

  it("无候选（当前项目无会话 / 空列表）返回 null：不选中", () => {
    expect(selectStartupSessionId([], "p-1")).toBeNull();
    expect(selectStartupSessionId([row({ id: "s-other", projectId: "p-A" })], "p-B")).toBeNull();
  });
});
