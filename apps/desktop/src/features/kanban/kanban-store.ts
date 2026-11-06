// 用途：看板需求 store（#18）—— kanban:list 再水化整表替换 + TrackerChange 六成员事件归并；useSyncExternalStore 兼容（快照引用稳定，ChatStore 同模式）
import type { RequirementCardRow, TrackerChangeWire } from "@kanban/ipc-schema";

export interface KanbanSnapshot {
  /** 全量需求行（不按项目过滤；视图层按当前项目过滤，S2-08） */
  requirements: RequirementCardRow[];
  /** 会话 → 需求反查映射（侧栏会话行徽标数据源，#20 消费） */
  sessionToReq: Record<string, string>;
  /** 详情面板选中（#19 消费；本票仅留状态位） */
  activeRequirementId: string | null;
  version: number;
}

export class KanbanStore {
  private requirements = new Map<string, RequirementCardRow>();
  private sessionToReq: Record<string, string> = {};
  private activeRequirementId: string | null = null;
  private listeners = new Set<() => void>();
  private version = 0;
  private snapshot: KanbanSnapshot | null = null;

  /** useSyncExternalStore 数据源：变更间引用稳定（箭头属性保证 this 绑定） */
  getSnapshot = (): KanbanSnapshot => {
    if (!this.snapshot) {
      this.snapshot = {
        requirements: [...this.requirements.values()],
        sessionToReq: { ...this.sessionToReq },
        activeRequirementId: this.activeRequirementId,
        version: this.version,
      };
    }
    return this.snapshot;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** kanban:list 再水化：整表替换（行与会话映射克隆隔离，旧快照不被就地修改污染） */
  hydrate(rows: RequirementCardRow[], sessionToReq: Record<string, string>): void {
    this.requirements = new Map(rows.map((r) => [r.id, { ...r, sessions: [...r.sessions] }]));
    this.sessionToReq = { ...sessionToReq };
    if (this.activeRequirementId && !this.requirements.has(this.activeRequirementId)) this.activeRequirementId = null;
    this.changed();
  }

  setActive(id: string | null): void {
    if (this.activeRequirementId === id) return;
    this.activeRequirementId = id;
    this.changed();
  }

  /**
   * TrackerChange 归并（tracker:event 实时刷新）：五补丁成员直接更新对应卡片；
   * requirement_created 变更不携带 title/projectId（不猜缺失字段），由 controller 经 kanban:list 再水化补全
   */
  applyTrackerChange(change: TrackerChangeWire): void {
    switch (change.type) {
      case "requirement_created":
        // no-op：controller 收到 created 即 refetch（见 use-kanban）
        break;
      case "stage_changed": {
        const r = this.requirements.get(change.requirementId);
        if (!r) return;
        r.stage = change.stage;
        r.stageBasis = change.basis;
        r.uncertain = change.uncertain;
        break;
      }
      case "session_linked": {
        const r = this.requirements.get(change.requirementId);
        if (!r) return;
        if (!r.sessions.includes(change.sessionId)) r.sessions = [...r.sessions, change.sessionId];
        this.sessionToReq = { ...this.sessionToReq, [change.sessionId]: change.requirementId };
        break;
      }
      case "session_unlinked": {
        const r = this.requirements.get(change.requirementId);
        if (!r) return;
        r.sessions = r.sessions.filter((s) => s !== change.sessionId);
        const next = { ...this.sessionToReq };
        delete next[change.sessionId];
        this.sessionToReq = next;
        break;
      }
      case "requirement_renamed": {
        const r = this.requirements.get(change.requirementId);
        if (!r) return;
        r.title = change.title;
        break;
      }
      case "requirement_deleted": {
        this.requirements.delete(change.requirementId);
        const next: Record<string, string> = {};
        for (const [sid, rid] of Object.entries(this.sessionToReq)) if (rid !== change.requirementId) next[sid] = rid;
        this.sessionToReq = next;
        if (this.activeRequirementId === change.requirementId) this.activeRequirementId = null;
        break;
      }
    }
    this.changed();
  }

  private changed(): void {
    this.version += 1;
    this.snapshot = null;
    for (const l of this.listeners) l();
  }
}
