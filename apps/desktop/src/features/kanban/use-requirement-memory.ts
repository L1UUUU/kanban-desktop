// 用途：需求记忆控制器 hook（#33）—— requirementMemory 一次读 + memory:event 事件驱动局部刷新（batch-status 终态→重读、chunk-progress→更新进行中态，不轮询）+ 七通道动作面（extract/cancel/reviewCandidate/resolveSummary/editAccepted），transport 未接 memory 通道时返回 null（面板保持占位）
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MemoryBatchRow,
  MemoryCandidateRow,
  MemoryEventWire,
  MemoryRequest,
  MemoryResult,
  MemorySummaryChoice,
  MemorySummaryRow,
  MemoryReviewAction,
} from "@kanban/ipc-schema";
import type { ChatTransport } from "../../lib/kanban-api";

/** 详情面板一次读载荷（wire memoryOkSchema 投影） */
export interface RequirementMemoryData {
  batches: MemoryBatchRow[];
  candidates: MemoryCandidateRow[];
  summary: MemorySummaryRow | null;
}

/** 提取进行中态（US8 四步：reading → chunking → extracting i/n → merging；step=null 表示已启动待首个进度事件） */
export interface MemoryProgressState {
  batchId: string;
  step: "reading" | "chunking" | "extracting" | "merging" | null;
  chunkIndex: number;
  chunkCount: number;
}

export interface RequirementMemoryController {
  /** 一次读数据（null=未加载/无 transport） */
  data: RequirementMemoryData | null;
  /** 进行中批次进度（null=无进行中批次） */
  progress: MemoryProgressState | null;
  /** 重读 requirementMemory（事件/动作后的局部刷新） */
  refresh(): Promise<void>;
  /** 提取需求经验（US1 手动触发；业务拒绝直达调用方呈现） */
  extract(): Promise<MemoryResult>;
  /** 取消进行中的提取（US9 整批丢弃） */
  cancel(): Promise<MemoryResult>;
  /** 候选审核三动作（US16）；成功后自动 refresh */
  reviewCandidate(candidateId: string, action: MemoryReviewAction, edit?: { claim?: string; scope?: string }): Promise<MemoryResult>;
  /** 总结 proposed 二选一（US14）；成功后自动 refresh */
  resolveSummary(choice: MemorySummaryChoice): Promise<MemoryResult>;
  /** 已接受知识再编辑（US21）；成功后自动 refresh */
  editAccepted(candidateId: string, edit: { claim?: string; scope?: string }): Promise<MemoryResult>;
}

/** 已接 memory 通道的 transport 投影（窄化可选成员，供本 hook 内安全调用） */
interface MemoryChannel {
  invokeMemory(req: MemoryRequest): Promise<MemoryResult>;
  onMemoryEvent(handler: (event: MemoryEventWire) => void): () => void;
}

/** transport 是否具备 memory 通道（preload 桥接必有；旧测试 fake 可缺省降级为 null） */
function memoryTransport(transport: ChatTransport | null): MemoryChannel | null {
  const invoke = transport?.invokeMemory;
  const subscribe = transport?.onMemoryEvent;
  return invoke && subscribe ? { invokeMemory: invoke, onMemoryEvent: subscribe } : null;
}

/**
 * 需求记忆控制器：requirementId 变化（面板开关/切换卡片）时一次读；
 * 订阅 memory:event —— chunk-progress 更新进度态，batch-status（running 建进度锚点 / 终态清进度并重读）。
 */
export function useRequirementMemory(requirementId: string | null, transport: ChatTransport | null): RequirementMemoryController | null {
  // 窄化投影随 transport 稳定（useMemo：避免每次渲染新对象触发订阅 effect 重挂）
  const mt = useMemo(() => memoryTransport(transport), [transport]);
  const [data, setData] = useState<RequirementMemoryData | null>(null);
  const [progress, setProgress] = useState<MemoryProgressState | null>(null);

  // 渲染期对账（调整态模式，同 DetailPanel 标题同步）：需求切换 / 通道退化即清空旧需求数据
  const activeFor = mt != null && requirementId != null ? requirementId : null;
  const [loadedFor, setLoadedFor] = useState<string | null>(activeFor);
  if (loadedFor !== activeFor) {
    setLoadedFor(activeFor);
    setData(null);
    setProgress(null);
  }

  // 当前需求锚（fetch 守卫用；effect 内同步，回调中读取——渲染期不访问）
  const currentIdRef = useRef<string | null>(requirementId);
  useEffect(() => {
    currentIdRef.current = requirementId;
  }, [requirementId]);

  const refresh = useCallback(
    async (id: string | null): Promise<void> => {
      if (!mt || !id) return;
      const r = await mt.invokeMemory({ channel: "memory:requirementMemory", requirementId: id });
      if (currentIdRef.current !== id || !r.ok) return; // 已切换需求/业务拒绝：不落地
      const next: RequirementMemoryData = { batches: r.batches ?? [], candidates: r.candidates ?? [], summary: r.summary ?? null };
      setData(next);
      // 进度对账：库里有 running 批次而无（或不同批次的）事件进度 → 建锚点；无 running → 清进度
      const running = next.batches.find((b) => b.status === "running");
      setProgress((p) =>
        running ? (p && p.batchId === running.id ? p : { batchId: running.id, step: null, chunkIndex: 0, chunkCount: 0 }) : null,
      );
    },
    [mt],
  );

  // 挂载/需求切换：一次读 + 事件订阅（chunk-progress 只更新进度；batch-status running 建锚、终态清进度并重读）
  useEffect(() => {
    if (!mt || !requirementId) return;
    void refresh(requirementId);
    const off = mt.onMemoryEvent((event: MemoryEventWire) => {
      if (event.requirementId !== requirementId) return;
      if (event.type === "chunk-progress") {
        setProgress({ batchId: event.batchId, step: event.step, chunkIndex: event.chunkIndex, chunkCount: event.chunkCount });
      } else if (event.status === "running") {
        setProgress({ batchId: event.batchId, step: null, chunkIndex: 0, chunkCount: 0 });
        void refresh(requirementId);
      } else {
        setProgress(null); // 终态（completed/failed/cancelled）→ 重读批次/候选/总结
        void refresh(requirementId);
      }
    });
    return off;
  }, [mt, requirementId, refresh]);

  /** 通用动作包装：成功（ok:true）后 refresh 当前需求，业务拒绝原样返回由 UI 呈现 */
  const invokeThenRefresh = useCallback(
    async (req: MemoryRequest): Promise<MemoryResult> => {
      if (!mt) return { ok: false, reason: "transport-unavailable", detail: "memory 通道不可用" };
      const r = await mt.invokeMemory(req);
      if (r.ok) await refresh(currentIdRef.current);
      return r;
    },
    [mt, refresh],
  );

  if (!mt) return null;
  return {
    data,
    progress,
    refresh: () => refresh(currentIdRef.current),
    extract: () => invokeThenRefresh({ channel: "memory:extract", requirementId: requirementId ?? "" }),
    cancel: () => invokeThenRefresh({ channel: "memory:cancel", requirementId: requirementId ?? "" }),
    reviewCandidate: (candidateId, action, edit) =>
      invokeThenRefresh(
        edit ? { channel: "memory:reviewCandidate", candidateId, action, edit } : { channel: "memory:reviewCandidate", candidateId, action },
      ),
    resolveSummary: (choice) => invokeThenRefresh({ channel: "memory:resolveSummary", requirementId: requirementId ?? "", choice }),
    editAccepted: (candidateId, edit) => invokeThenRefresh({ channel: "memory:editAccepted", candidateId, ...edit }),
  };
}
