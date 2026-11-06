// 用途：Tracker Engine（演进自 poc-4 engine.mjs）—— 组合 tracker 状态机与 SQLite store：入口硬校验、事件落库、状态投影落库、重启后按事件日志重放恢复（事件溯源，比 poc-4 快照恢复更强：状态与日志不可分叉）
import type { DatabaseSync } from "node:sqlite";
import { validateEvent } from "./schema";
import { Store } from "./store";
import { RequirementTracker, type RequirementSnapshot, type TrackerChange } from "./tracker";

export class TrackerEngine {
  readonly store: Store;
  tracker: RequirementTracker;

  /** DB 连接经注入（node:sqlite 实例；main 用 openDatabase 打开，测试用临时文件/内存库） */
  constructor(db: DatabaseSync) {
    this.store = new Store(db);
    this.tracker = new RequirementTracker();
  }

  /**
   * 重启恢复：按 stage_events 事件日志顺序重放重建 tracker 全量状态（需求/关联/processed 幂等集/各 session 已见事件）。
   * 演进自 poc-4 loadTrackerState 快照读取：重放与在线处理走同一状态机，天然保证恢复态 = 退出态。
   */
  restore(): void {
    const replayed = new RequirementTracker();
    for (const raw of this.store.listEvents()) {
      replayed.process(validateEvent(raw)); // 落库前已校验；重放再校验一次（防手工改库）
    }
    this.tracker = replayed;
  }

  /** 处理一条归一化事件：校验 → tracker 状态机 → 事件与状态投影落库；非法输入抛错（不进事件流不落库） */
  process(raw: unknown): { accepted: true; changes: TrackerChange[] } {
    const ev = validateEvent(raw);
    const changes = this.tracker.process(ev);
    this.store.appendEvent(ev);
    this.persistAll();
    return { accepted: true, changes };
  }

  /** 把 tracker 当前状态投影落库（requirements 表全量 upsert + #16 墓碑对账删行，供阶段 2 看板直读与一致性审计） */
  persistAll(): void {
    for (const r of this.tracker.requirements.values()) {
      this.store.saveRequirement({ ...r, stageBasisAt: r.stageBasisAt ?? null, stageBasis: r.stageBasis ?? null });
    }
    // 墓碑对账：投影中已不在内存态的行删掉（delete 后投影不留残留；事件日志仍在 stage_events）
    const live = new Set(this.tracker.requirements.keys());
    for (const row of this.store.listRequirements()) {
      if (!live.has(row.id)) this.store.deleteRequirement(row.id);
    }
  }

  snapshot(): RequirementSnapshot[] {
    return this.tracker.snapshot();
  }

  /** 关闭注入的 DB 连接（poc-4 API 面保留；宿主与 engine 不得重复 close） */
  close(): void {
    this.store.close();
  }
}
