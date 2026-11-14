// 用途：记忆视图控制器 hook（#34，US19–21；#38 补总结）—— memory 通道随 ChatTransport 一体（arch D8 双轨合一）→ memory:projectMemory 一次读（知识+总结，服务端口径：query 大小写不敏感子串匹配标题+正文、pending/ignored 不进）+ 知识再编辑动作（memory:editAccepted）+ 总结正文编辑（memory:editSummary）；挂载/切项目/搜索词变化即再拉取（进视图即最新）
import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryCandidateRow, MemorySummaryRow } from "@kanban/ipc-schema";
import type { ChatTransport } from "../../lib/kanban-api";
import { createScopedLogger } from "../../lib/logger";
import { transportUnavailableError } from "../../lib/transport-error";

// 本文件日志出口（scope 固定 memory，经 lib/logger 唯一出口发出）
const log = createScopedLogger("memory");

/** 一次拉取快照（projectMemory 成功载荷） */
interface MemorySnapshot {
  knowledge: MemoryCandidateRow[];
  summaries: MemorySummaryRow[];
}

export interface MemoryController {
  /** 当前项目已接受知识（accepted/edited，服务端已按 query 过滤） */
  knowledge: MemoryCandidateRow[];
  /** 当前项目需求总结（更新时间序，服务端已按 query 过滤，含正文） */
  summaries: MemorySummaryRow[];
  /** 搜索框当前值（受控） */
  query: string;
  setQuery(q: string): void;
  /** 重新拉取当前项目记忆（编辑保存后刷新用） */
  refresh(): Promise<void>;
  /** 知识再编辑（memory:editAccepted；仅 claim/适用范围）——返回拒绝文案（null=成功），UI 直达呈现 */
  editAccepted(candidateId: string, edit: { claim?: string; scope?: string }): Promise<string | null>;
  /** 总结正文编辑（memory:editSummary，#38；完整正文写回并纳入防覆盖基准）——返回拒绝文案（null=成功），UI 直达呈现 */
  editSummary(requirementId: string, content: string): Promise<string | null>;
}

/** 记忆控制器 hook：transport 未接 memory 通道（旧 fake）或无项目时保持空态（App 层据此降级/空态引导） */
export function useMemory(transport: ChatTransport | null, projectId: string | null): MemoryController {
  const [knowledge, setKnowledge] = useState<MemoryCandidateRow[]>([]);
  const [summaries, setSummaries] = useState<MemorySummaryRow[]>([]);
  const [query, setQuery] = useState("");
  // 请求序号：query 连续变化时丢弃过期响应（本地 IPC 快，仅防乱序覆盖）
  const seqRef = useRef(0);
  // memory 通道窄化（与 use-requirement-memory 同口径）：未接 invokeMemory 时等同不可用
  const invokeMemory = transport?.invokeMemory;

  /** 取数（纯 IPC 调用 + 过期丢弃，不含 setState；供 effect 拉取与编辑后刷新共用） */
  const fetchMemory = useCallback(
    async (q: string): Promise<MemorySnapshot | null> => {
      if (!invokeMemory || projectId == null) return null;
      const seq = ++seqRef.current;
      const res = await invokeMemory({
        channel: "memory:projectMemory",
        projectId,
        ...(q.trim() ? { query: q.trim() } : {}),
      });
      if (seq !== seqRef.current) return null; // 过期响应丢弃
      if (!res.ok) {
        log.error("拉取项目记忆失败", { projectId, reason: res.reason, ...(res.detail ? { detail: res.detail } : {}) });
        return null;
      }
      return { knowledge: res.knowledge ?? [], summaries: res.summaries ?? [] };
    },
    [invokeMemory, projectId],
  );

  /** 快照落态 */
  const apply = useCallback((data: MemorySnapshot): void => {
    setKnowledge(data.knowledge);
    setSummaries(data.summaries);
  }, []);

  // 挂载 / 切项目 / 搜索词变化即拉取（外部系统=IPC 桥；setState 在异步回调，use-projects 同款形态）
  useEffect(() => {
    void fetchMemory(query).then((data) => {
      if (data) apply(data);
    });
  }, [fetchMemory, query, apply]);

  const refresh = useCallback(async () => {
    const data = await fetchMemory(query);
    if (data) apply(data);
  }, [fetchMemory, query, apply]);

  const editAccepted = useCallback(
    async (candidateId: string, edit: { claim?: string; scope?: string }): Promise<string | null> => {
      // memory 通道未接兜底：载体经 lib/transport-error 单源（arch D10），文案直达 UI 行内提示
      if (!invokeMemory) return transportUnavailableError("记忆服务不可用").message;
      const res = await invokeMemory({
        channel: "memory:editAccepted",
        candidateId,
        ...(edit.claim != null ? { claim: edit.claim } : {}),
        ...(edit.scope != null ? { scope: edit.scope } : {}),
      });
      if (!res.ok) return res.detail ? `${res.reason}：${res.detail}` : res.reason;
      await refresh(); // 保存后刷新（有效值即时更新）
      return null;
    },
    [invokeMemory, refresh],
  );

  const editSummary = useCallback(
    async (requirementId: string, content: string): Promise<string | null> => {
      // memory 通道未接兜底：同 editAccepted（arch D10 单源载体）
      if (!invokeMemory) return transportUnavailableError("记忆服务不可用").message;
      const res = await invokeMemory({ channel: "memory:editSummary", requirementId, content });
      if (!res.ok) return res.detail ? `${res.reason}：${res.detail}` : res.reason;
      await refresh(); // 保存后刷新（总结正文即时更新）
      return null;
    },
    [invokeMemory, refresh],
  );

  return { knowledge, summaries, query, setQuery, refresh, editAccepted, editSummary };
}
