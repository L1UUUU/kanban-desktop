// 用途：PoC Engine —— 组合 tracker（内存状态机）与 store（SQLite 持久化）：事件入口硬校验、处理后状态落库、进程重启后恢复，供测试与端到端运行共用
import { validateEvent } from "./schema.mjs";
import { RequirementTracker } from "./tracker.mjs";
import { Store } from "./store.mjs";

export class PoCEngine {
  constructor(dbPath) {
    this.store = new Store(dbPath);
    this.tracker = new RequirementTracker();
  }

  // 重启恢复：从 SQLite 全量恢复 tracker 状态（需求终态、关联、processed 幂等集、各 session 已见事件）
  restore() {
    const state = this.store.loadTrackerState();
    this.tracker.restore(state);
    return state;
  }

  // 处理一条归一化事件：校验 → tracker 状态机 → 事件与状态落库；返回 {accepted, changes}
  process(rawEv) {
    const ev = validateEvent(rawEv); // 非法输入在入口拒绝，不进事件流不落库
    const changes = this.tracker.process(ev);
    this.store.appendEvent(ev);
    this.persistAll();
    return { accepted: true, changes };
  }

  // 把 tracker 当前状态全量落库（状态量小，胜过增量 diff 的复杂度）
  persistAll() {
    for (const r of this.tracker.requirements.values()) {
      this.store.saveRequirement({ ...r, stageBasisAt: r.stageBasisAt ?? null, stageBasis: r.stageBasis ?? null });
    }
    for (const [sessionId, reqId] of this.tracker.sessionToReq) {
      this.store.saveSession(sessionId, this.tracker.sessionCli.get(sessionId) ?? "unknown", reqId);
    }
    for (const sessionId of this.tracker.sessionCli.keys()) {
      if (!this.tracker.sessionToReq.has(sessionId)) this.store.saveSession(sessionId, this.tracker.sessionCli.get(sessionId), null);
    }
  }

  snapshot() {
    return this.tracker.snapshot();
  }

  close() {
    this.store.close();
  }
}
