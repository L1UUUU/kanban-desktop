// 用途：看板控制器 hook（#18）—— transport → KanbanStore 接线：挂载经 kanban:list 再水化（restore 重放不产生推送，spec #15 C 节）+ onTrackerEvent 实时刷新（补丁成员直接归并、建卡经再水化补全）+ 手动建卡动作
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { RequirementCardRow } from "@kanban/ipc-schema";
import type { ChatTransport } from "../../lib/kanban-api";
import { KanbanStore } from "./kanban-store";

export interface KanbanController {
  requirements: RequirementCardRow[];
  sessionToReq: Record<string, string>;
  activeRequirementId: string | null;
  /** store 版本号 */
  version: number;
  /** store 直面（#19/#20 消费） */
  store: KanbanStore;
  setActive(id: string | null): void;
  /** kanban:list 再水化（启动/建卡补全） */
  refresh(): Promise<void>;
  /** 未开始列「＋」手动建卡（S2-09；缺省标题「待命名需求」，归属当前项目） */
  create(projectId: string, title?: string): Promise<void>;
}

/**
 * 看板控制器 hook。看板状态纯内存（renderer store），持久化权威在 SQLite（spec G 节）；
 * 两视图常驻订阅（chat 视图期间 tracker 变更同样归并，进看板即最新）
 */
export function useKanban(transport: ChatTransport | null): KanbanController {
  // useState 初始化器保证每 hook 实例一个 store（渲染期可安全读取）
  const [store] = useState(() => new KanbanStore());
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const refresh = useCallback(async () => {
    if (!transport) return;
    const res = await transport.invoke({ channel: "kanban:list" });
    if (res.ok && res.requirements) store.hydrate(res.requirements, res.sessionToReq ?? {});
  }, [transport, store]);

  useEffect(() => {
    if (!transport) return;
    void refresh(); // 启动再水化（重启后 tracker 重放不产生推送，看板一致性只靠本调用）
    const off = transport.onTrackerEvent((change) => {
      if (change.type === "requirement_created") {
        // 建卡变更缺 title/projectId：经 kanban:list 再水化补全（本地 IPC 往返，卡片仍实时出现）
        void refresh();
      } else {
        store.applyTrackerChange(change);
      }
    });
    return off;
  }, [transport, store, refresh]);

  const create = useCallback(
    async (projectId: string, title?: string) => {
      if (!transport) return;
      const r = await transport.invoke({ channel: "kanban:create", projectId, ...(title ? { title } : {}) });
      if (!r.ok) console.error("[kanban] 建卡失败", r.error);
    },
    [transport],
  );

  return {
    requirements: snap.requirements,
    sessionToReq: snap.sessionToReq,
    activeRequirementId: snap.activeRequirementId,
    version: snap.version,
    store,
    setActive: store.setActive,
    refresh,
    create,
  };
}
