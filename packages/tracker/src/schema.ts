// 用途：C2 归一化事件 schema（演进自 poc/poc-4-cross-cli/lib/schema.mjs；#16 起 spec #15 A 节演进：create/rename/delete kind + pty CLI + projectId/title 字段 + manual "none"）—— 事件字段/证据等级效果/有效事件表 + validateEvent 入口硬校验，供 tracker/engine/adapters 共用
export const CLIS = ["claude-code", "codex", "opencode", "pty"] as const;
export type Cli = (typeof CLIS)[number];

// 证据等级（C2 冻结）：verified=Claude hook 独立验证；self_reported=GUI 可观察提交但无 per-turn hook；simulated=合成信号
export const EVIDENCE_LEVELS = ["verified", "self_reported", "simulated"] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

// 各证据等级对阶段状态机的效果（C2 冻结，e2e 25/25 实证）
export const EVIDENCE_EFFECT = {
  verified: { drive: true, uncertain: false, autoCreate: true },
  self_reported: { drive: true, uncertain: true, autoCreate: false },
  simulated: { drive: true, uncertain: true, autoCreate: false },
} as const;

export const KINDS = ["skill", "manual", "link", "unlink", "create", "rename", "delete"] as const;
export type EventKind = (typeof KINDS)[number];

// 计划 §4 有效事件表（skill → 阶段）
export const SKILL_STAGE = {
  "design-feature": "Design",
  "implement-spec": "Implement",
  pr: "PR",
  retro: "Retro",
} as const;
export type StageSkill = keyof typeof SKILL_STAGE;

export const STAGES = ["Design", "Implement", "PR", "Retro"] as const;
export type Stage = (typeof STAGES)[number];

/** 归一化事件形状（单一归一化流，所有 CLI 的观察信号转换为该形状后进入 tracker）
 *  #16（spec #15 A 节）：加可选 projectId（Main 进 Engine 前注入，Adapter 不感知）与 title（create/rename 携带）；缺省均归 null */
export interface NormalizedEvent {
  eventId: string;
  kind: EventKind;
  sessionId: string | null;
  cli: Cli | null;
  skill: string | null;
  stage: string | null;
  requirementId: string | null;
  title: string | null;
  projectId: string | null;
  occurredAt: string;
  receivedAt: string;
  seq: number | string | null;
  evidenceLevel: EvidenceLevel;
  source: string;
}

function fail(field: string, value: unknown): Error {
  return new Error(`invalid event: ${field}=${JSON.stringify(value)}`);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** 校验并规范化一条归一化事件；不合法抛错（入口硬校验，非法输入不进事件流不落库） */
export function validateEvent(ev: unknown): NormalizedEvent {
  if (!isRecord(ev)) throw fail("event", ev);
  if (typeof ev.eventId !== "string" || ev.eventId.length === 0) throw fail("eventId", ev.eventId);
  if (!KINDS.includes(ev.kind as EventKind)) throw fail("kind", ev.kind);
  if (!EVIDENCE_LEVELS.includes(ev.evidenceLevel as EvidenceLevel)) throw fail("evidenceLevel", ev.evidenceLevel);
  if (typeof ev.occurredAt !== "string") throw fail("occurredAt", ev.occurredAt);
  if (typeof ev.receivedAt !== "string") throw fail("receivedAt", ev.receivedAt);
  if (ev.cli != null && !CLIS.includes(ev.cli as Cli)) throw fail("cli", ev.cli);
  if (ev.kind === "skill") {
    if (typeof ev.sessionId !== "string" || ev.sessionId.length === 0) throw fail("sessionId", ev.sessionId);
    if (ev.cli == null || ev.cli === "pty") throw fail("cli", ev.cli); // pty 无 skill 信号，skill 证据仍限三真实 CLI（spec #15 A 节）
    if (typeof ev.skill !== "string" || ev.skill.length === 0) throw fail("skill", ev.skill);
  }
  // manual 阶段条 wire 允许 "none" 字面量（未开始），归一 null；null 亦合法（重放已归一事件）；其余须为四阶段（spec #15 A 节）
  if (ev.kind === "manual" && ev.stage !== "none" && ev.stage !== null && !STAGES.includes(ev.stage as Stage)) {
    throw fail("stage", ev.stage);
  }
  if (ev.kind === "manual" && (typeof ev.requirementId !== "string" || ev.requirementId.length === 0)) {
    throw fail("requirementId", ev.requirementId);
  }
  if ((ev.kind === "link" || ev.kind === "unlink") && (typeof ev.sessionId !== "string" || ev.sessionId.length === 0)) {
    throw fail("sessionId", ev.sessionId);
  }
  // link 时 session 可能首次出现需登记 cli（pty 允许——PTY 终端会话可关联）；unlink 的 cli 已在会话登记中（C2 冻结）
  if (ev.kind === "link" && ev.cli == null) throw fail("cli", ev.cli);
  if (ev.kind === "link" && (typeof ev.requirementId !== "string" || ev.requirementId.length === 0)) {
    throw fail("requirementId", ev.requirementId);
  }
  // 新 kind（spec #15 A 节）：create 携带确定性 requirementId/title/projectId；rename 携带 requirementId/title；delete 仅 requirementId；均不要求 sessionId，delete/rename 不要求 cli
  if (ev.kind === "create" || ev.kind === "rename" || ev.kind === "delete") {
    if (typeof ev.requirementId !== "string" || ev.requirementId.length === 0) throw fail("requirementId", ev.requirementId);
  }
  if ((ev.kind === "create" || ev.kind === "rename") && (typeof ev.title !== "string" || ev.title.length === 0)) {
    throw fail("title", ev.title);
  }
  if (ev.kind === "create" && (typeof ev.projectId !== "string" || ev.projectId.length === 0)) {
    throw fail("projectId", ev.projectId);
  }
  const out: NormalizedEvent = {
    eventId: ev.eventId,
    kind: ev.kind as EventKind,
    sessionId: (ev.sessionId as string | null | undefined) ?? null,
    cli: (ev.cli as Cli | null | undefined) ?? null,
    skill: (ev.skill as string | null | undefined) ?? null,
    stage: ev.kind === "manual" && ev.stage === "none" ? null : ((ev.stage as string | null | undefined) ?? null),
    requirementId: (ev.requirementId as string | null | undefined) ?? null,
    title: (ev.title as string | null | undefined) ?? null,
    projectId: (ev.projectId as string | null | undefined) ?? null,
    occurredAt: ev.occurredAt,
    receivedAt: ev.receivedAt,
    seq: (ev.seq as number | string | null | undefined) ?? null,
    evidenceLevel: ev.evidenceLevel as EvidenceLevel,
    source: (ev.source as string | undefined) ?? "",
  };
  return out;
}
