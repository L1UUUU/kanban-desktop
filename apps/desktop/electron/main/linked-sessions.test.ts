// 用途：关联会话查询密封测试 —— tracker 反查按需求过滤 / kind 两态分流 / CLI 口径归一（fake→claude-code、未知回退）/ 会话行缺失跳过
import { describe, expect, it } from "vitest";
import { createLinkedSessionQueries } from "./linked-sessions";
import type { SessionRecord } from "./session-store";

/** 会话行工厂（缺省 = structured + fake CLI） */
function row(over: Partial<SessionRecord> & { id: string }): SessionRecord {
  return {
    kind: "structured",
    cli: "fake",
    nativeSessionId: null,
    projectId: null,
    title: null,
    cwd: "C:\\p",
    permMode: "auto",
    status: "idle",
    lastActiveAt: null,
    archivedAt: null,
    ...over,
  };
}

/** 装配被测件：tracker 映射 + 会话行表（行缺失可表达） */
function makeQueries(entries: Array<[sessionId: string, requirementId: string]>, rows: SessionRecord[]) {
  const table = new Map(rows.map((r) => [r.id, r]));
  return createLinkedSessionQueries({
    tracker: { sessionToReq: new Map(entries) },
    sessions: { get: (id: string) => table.get(id) ?? null },
  });
}

describe("createLinkedSessionQueries", () => {
  it("structured 查询：仅返回该需求关联的 structured 会话，CLI 名归一为 tracker 口径（fake→claude-code / codex→codex）", () => {
    const q = makeQueries(
      [
        ["s-1", "REQ-1"],
        ["s-2", "REQ-2"],
        ["s-3", "REQ-1"],
      ],
      [row({ id: "s-1", cli: "fake" }), row({ id: "s-2", cli: "fake" }), row({ id: "s-3", cli: "codex" })],
    );
    expect(q.listLinkedStructuredSessions("REQ-1")).toEqual([
      { sessionId: "s-1", cli: "claude-code" },
      { sessionId: "s-3", cli: "codex" },
    ]);
    expect(q.listLinkedStructuredSessions("REQ-2")).toEqual([{ sessionId: "s-2", cli: "claude-code" }]);
    expect(q.listLinkedStructuredSessions("REQ-404")).toEqual([]);
  });

  it("pty 查询：仅返回该需求关联的 pty 会话且只携带 sessionId（不带 CLI 名）", () => {
    const q = makeQueries(
      [
        ["t-1", "REQ-1"],
        ["s-1", "REQ-1"],
        ["t-2", "REQ-2"],
      ],
      [row({ id: "t-1", kind: "pty", cli: "pty", permMode: null }), row({ id: "s-1" }), row({ id: "t-2", kind: "pty", cli: "pty", permMode: null })],
    );
    expect(q.listLinkedPtySessions("REQ-1")).toEqual([{ sessionId: "t-1" }]);
    expect(q.listLinkedPtySessions("REQ-2")).toEqual([{ sessionId: "t-2" }]);
  });

  it("kind 分流互斥：structured 查询不见 pty 行、pty 查询不见 structured 行", () => {
    const q = makeQueries([["s-1", "REQ-1"], ["t-1", "REQ-1"]], [row({ id: "s-1" }), row({ id: "t-1", kind: "pty", cli: "pty", permMode: null })]);
    expect(q.listLinkedStructuredSessions("REQ-1").map((s) => s.sessionId)).toEqual(["s-1"]);
    expect(q.listLinkedPtySessions("REQ-1")).toEqual([{ sessionId: "t-1" }]);
  });

  it("会话行缺失（tracker 有关联但 sessions 表无行）：跳过不产出，未知 CLI 名回退 claude-code", () => {
    const q = makeQueries([["s-gone", "REQ-1"], ["s-odd", "REQ-1"]], [row({ id: "s-odd", cli: "mystery-cli" })]);
    expect(q.listLinkedStructuredSessions("REQ-1")).toEqual([{ sessionId: "s-odd", cli: "claude-code" }]);
  });
});
