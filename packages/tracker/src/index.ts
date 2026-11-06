// 用途：@kanban/tracker 入口 —— C2 冻结事件 schema（validateEvent）+ RequirementTracker 状态机 + TrackerEngine（接线：事件进→落库→驱动状态机）+ SQLite Store；纯 Node 包无 Electron 依赖
export {
  CLIS,
  EVIDENCE_EFFECT,
  EVIDENCE_LEVELS,
  KINDS,
  SKILL_STAGE,
  STAGES,
  validateEvent,
  type Cli,
  type EvidenceLevel,
  type EventKind,
  type NormalizedEvent,
  type Stage,
  type StageSkill,
} from "./schema";
export {
  RequirementTracker,
  formatRequirementId,
  parseRequirementId,
  transformHookEvents,
  type DecisionLogEntry,
  type RequirementSnapshot,
  type RequirementState,
  type StageBasis,
  type TrackerChange,
} from "./tracker";
export { TrackerEngine } from "./engine";
export { Store, type RequirementRow, type StageEventRow } from "./store";
