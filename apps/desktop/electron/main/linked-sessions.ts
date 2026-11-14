// 用途：需求当前关联会话查询（memory 装配注入面，arch C10 自 index.ts 出舱）—— 遍历 tracker sessionToReq 反查关联 + sessions 行 kind 过滤 + 应用侧 CLI 名归一为 tracker 口径；依赖注入可密封测试（原 index.ts / tests/memory-fixture.ts 两份同形闭包合并单源）
import type { RequirementTracker } from "@kanban/tracker";
import { TRACKER_CLI_BY_APP } from "./ipc/helpers";
import type { SessionStore } from "./session-store";

/** 关联会话查询（openMemoryService 的注入面形状）：structured 带 CLI 名（tracker 口径）、pty 仅 sessionId */
export interface LinkedSessionQueries {
  listLinkedStructuredSessions(requirementId: string): Array<{ sessionId: string; cli: string }>;
  listLinkedPtySessions(requirementId: string): Array<{ sessionId: string }>;
}

/** 构造查询器：按需求反查关联会话（tracker map 读取与 kind 分流收在模块内，装配根不再触碰 tracker 内部结构） */
export function createLinkedSessionQueries(deps: {
  /** tracker 关联映射（sessionToReq 反查） */
  tracker: Pick<RequirementTracker, "sessionToReq">;
  /** 会话行查询（kind 过滤与 CLI 名读取） */
  sessions: Pick<SessionStore, "get">;
}): LinkedSessionQueries {
  const listLinkedSessions = (
    requirementId: string,
    kind: "structured" | "pty",
  ): Array<{ sessionId: string; cli: string }> => {
    const out: Array<{ sessionId: string; cli: string }> = [];
    for (const [sessionId, reqId] of deps.tracker.sessionToReq) {
      if (reqId !== requirementId) continue;
      const s = deps.sessions.get(sessionId);
      if (s && s.kind === kind) out.push({ sessionId, cli: TRACKER_CLI_BY_APP[s.cli] ?? "claude-code" });
    }
    return out;
  };
  return {
    listLinkedStructuredSessions: (requirementId) => listLinkedSessions(requirementId, "structured"),
    listLinkedPtySessions: (requirementId) => listLinkedSessions(requirementId, "pty").map(({ sessionId }) => ({ sessionId })),
  };
}
