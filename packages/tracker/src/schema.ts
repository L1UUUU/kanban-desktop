// 用途：C2 冻结归一化事件 schema（演进自 poc/poc-4-cross-cli/lib/schema.mjs）—— 事件字段/证据等级效果/有效事件表 + validateEvent 入口硬校验，供 tracker/engine/adapters 共用
export const CLIS = ["claude-code", "codex", "opencode"] as const;
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

export const KINDS = ["skill", "manual", "link", "unlink"] as const;
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

/** 归一化事件形状（单一归一化流，所有 CLI 的观察信号转换为该形状后进入 tracker） */
export interface NormalizedEvent {
  eventId: string;
  kind: EventKind;
  sessionId: string | null;
  cli: Cli | null;
  skill: string | null;
  stage: string | null;
  requirementId: string | null;
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
    if (ev.cli == null) throw fail("cli", ev.cli);
    if (typeof ev.skill !== "string" || ev.skill.length === 0) throw fail("skill", ev.skill);
  }
  if (ev.kind === "manual" && !STAGES.includes(ev.stage as Stage)) throw fail("stage", ev.stage);
  if (ev.kind === "manual" && (typeof ev.requirementId !== "string" || ev.requirementId.length === 0)) {
    throw fail("requirementId", ev.requirementId);
  }
  if ((ev.kind === "link" || ev.kind === "unlink") && (typeof ev.sessionId !== "string" || ev.sessionId.length === 0)) {
    throw fail("sessionId", ev.sessionId);
  }
  // link 时 session 可能首次出现需登记 cli；unlink 的 cli 已在会话登记中（C2 冻结）
  if (ev.kind === "link" && ev.cli == null) throw fail("cli", ev.cli);
  if (ev.kind === "link" && (typeof ev.requirementId !== "string" || ev.requirementId.length === 0)) {
    throw fail("requirementId", ev.requirementId);
  }
  const out: NormalizedEvent = {
    eventId: ev.eventId,
    kind: ev.kind as EventKind,
    sessionId: (ev.sessionId as string | null | undefined) ?? null,
    cli: (ev.cli as Cli | null | undefined) ?? null,
    skill: (ev.skill as string | null | undefined) ?? null,
    stage: (ev.stage as string | null | undefined) ?? null,
    requirementId: (ev.requirementId as string | null | undefined) ?? null,
    occurredAt: ev.occurredAt,
    receivedAt: ev.receivedAt,
    seq: (ev.seq as number | string | null | undefined) ?? null,
    evidenceLevel: ev.evidenceLevel as EvidenceLevel,
    source: (ev.source as string | undefined) ?? "",
  };
  return out;
}
