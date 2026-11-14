// 用途：看板控制器 hook（#18）—— transport → KanbanStore 接线：挂载经 kanban:list 再水化（restore 重放不产生推送，spec #15 C 节）+ onTrackerEvent 实时刷新（补丁成员直接归并、建卡经再水化补全）+ 手动建卡动作；#33 起组合 useRequirementMemory（详情面板需求经验区数据源，transport 未接 memory 通道时为 null）
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { KanbanStageInput, RequirementCardRow } from "@kanban/ipc-schema";
import type { ChatTransport } from "../../lib/kanban-api";
import { createScopedLogger } from "../../lib/logger";
import { transportUnavailableError } from "../../lib/transport-error";
import { KanbanStore } from "./kanban-store";
import { useRequirementMemory, type RequirementMemoryController } from "./use-requirement-memory";

// 本文件日志出口（scope 固定 kanban，经 lib/logger 唯一出口发出）
const log = createScopedLogger("kanban");

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
  /** 未开始列「＋」手动建卡（S2-09；缺省标题「待命名需求」，归属当前项目）；#84 起成功返回新需求 id（调用方据此立即进入命名态），失败返回 null */
  create(projectId: string, title?: string): Promise<string | null>;
  /** 标题行内编辑（#19：kanban:rename 落事件流，重启不被「待命名需求」回退）；#84 起返回 null=成功、错误文案=失败（卡片/详情面板行内提示，link 同模式） */
  rename(requirementId: string, title: string): Promise<string | null>;
  /** 阶段修正 / uncertain 确认共用（#19：kanban:setStage；"none" = 未开始） */
  setStage(requirementId: string, stage: KanbanStageInput): Promise<void>;
  /** 删除需求（#19：kanban:delete 墓碑；卡片经 requirement_deleted 推送实时消失） */
  removeRequirement(requirementId: string): Promise<void>;
  /** 关联已有会话（#20：kanban:link；业务拒绝是合法结果）——返回拒绝原因（null=成功/幂等已关联），UI 直达呈现 */
  link(sessionId: string, requirementId: string): Promise<string | null>;
  /** 解除关联（#20：kanban:unlink；不删历史、不回退阶段，卡片会话数经 session_unlinked 推送即时更新） */
  unlink(sessionId: string): Promise<void>;
  /** #33：需求记忆控制器（详情面板需求经验区；transport 未接 memory 通道时为 null → 占位形态） */
  memory: RequirementMemoryController | null;
}

/**
 * 看板控制器 hook。看板状态纯内存（renderer store），持久化权威在 SQLite（spec G 节）；
 * 两视图常驻订阅（chat 视图期间 tracker 变更同样归并，进看板即最新）
 */
export function useKanban(transport: ChatTransport | null): KanbanController {
  // useState 初始化器保证每 hook 实例一个 store（渲染期可安全读取）
  const [store] = useState(() => new KanbanStore());
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // #33：需求记忆控制器（跟随 activeRequirementId 一次读 + memory:event 局部刷新）
  const memory = useRequirementMemory(snap.activeRequirementId, transport);

  const refresh = useCallback(async () => {
    if (!transport) return;
    const res = await transport.invoke({ channel: "kanban:list" });
    // 已知竞态窗口（接受不改行为）：await 在途时到达的补丁事件会被本次 hydrate 整表替换吞掉（list 快照早于该事件落库时）；
    // 本地 IPC 下窗口极小，自愈 = 后续任意 kanban:list 再水化（requirement_created 变更或重挂载触发）
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
    async (projectId: string, title?: string): Promise<string | null> => {
      if (!transport) return null;
      const r = await transport.invoke({ channel: "kanban:create", projectId, ...(title ? { title } : {}) });
      if (!r.ok) {
        log.error("建卡失败", { code: r.error.code, message: r.error.message, projectId });
        return null;
      }
      return r.requirementId ?? null;
    },
    [transport],
  );

  const rename = useCallback(
    async (requirementId: string, title: string): Promise<string | null> => {
      // transport 缺席兜底：载体经 lib/transport-error 单源（arch D10），文案直达 UI 行内提示
      if (!transport) return transportUnavailableError("transport 不可用").message;
      const r = await transport.invoke({ channel: "kanban:rename", requirementId, title });
      // 错误码结果（如 E_REQUIREMENT_NOT_FOUND）以文案形式直达 UI 行内提示（#84 不再静默）
      if (!r.ok) {
        log.error("重命名失败", { code: r.error.code, message: r.error.message, requirementId });
        return r.error.message;
      }
      return null;
    },
    [transport],
  );

  const setStage = useCallback(
    async (requirementId: string, stage: KanbanStageInput) => {
      if (!transport) return;
      const r = await transport.invoke({ channel: "kanban:setStage", requirementId, stage });
      if (!r.ok) log.error("阶段修正失败", { code: r.error.code, message: r.error.message, requirementId, stage });
    },
    [transport],
  );

  const removeRequirement = useCallback(
    async (requirementId: string) => {
      if (!transport) return;
      const r = await transport.invoke({ channel: "kanban:delete", requirementId });
      if (!r.ok) log.error("删除需求失败", { code: r.error.code, message: r.error.message, requirementId });
    },
    [transport],
  );

  const link = useCallback(
    async (sessionId: string, requirementId: string) => {
      // transport 缺席兜底：同 rename（arch D10 单源载体）
      if (!transport) return transportUnavailableError("transport 不可用").message;
      const r = await transport.invoke({ channel: "kanban:link", sessionId, requirementId });
      // 错误码结果（如 E_REQUIREMENT_NOT_FOUND）同样以原因形式呈现给用户
      if (!r.ok) return r.error.message;
      if (r.linked === false) return r.reason ?? "关联被拒绝";
      return null; // 成功（含幂等已关联同一需求）
    },
    [transport],
  );

  const unlink = useCallback(
    async (sessionId: string) => {
      if (!transport) return;
      const r = await transport.invoke({ channel: "kanban:unlink", sessionId });
      if (!r.ok) log.error("解除关联失败", { code: r.error.code, message: r.error.message, sessionId });
    },
    [transport],
  );

  return {
    requirements: snap.requirements,
    sessionToReq: snap.sessionToReq,
    activeRequirementId: snap.activeRequirementId,
    version: snap.version,
    store,
    setActive: (id: string | null) => store.setActive(id),
    refresh,
    create,
    rename,
    setStage,
    removeRequirement,
    link,
    unlink,
    memory,
  };
}
