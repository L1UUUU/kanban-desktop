// 用途：跨 CLI 归一化事件 schema —— 定义事件字段、证据等级、CLI 枚举与 Skill→阶段映射，供 tracker/engine/adapters 共用
// 事件形状（单一归一化流，所有 CLI 的观察信号都转换为该形状后进入 tracker）：
//   { eventId, kind, sessionId, cli, skill, stage, requirementId, occurredAt, receivedAt, seq, evidenceLevel, source }

export const CLIS = ["claude-code", "codex", "opencode"];

// 证据等级（计划 §8.5 skill-ledger 思路 + §4 规则）：
//   verified      = CLI 原生 hook/事件流确认的 Skill 真调用（Claude PreToolUse(Skill)）→ 直接驱动阶段，确定
//   self_reported = GUI 可观察「用户提交了 /skill 且 turn 真实开始/完成」，但 CLI 无 per-turn hook（Codex）→ 驱动阶段但标 uncertain，待手动确认
//   simulated     = 合成/未接真实事件源的替代事件（本 PoC OpenCode 凭据阻塞）→ 驱动阶段但标 uncertain，事件与结论均需明确标注
export const EVIDENCE_LEVELS = ["verified", "self_reported", "simulated"];

// 各证据等级对阶段状态机的效果（PoC 4 核心设计决策，见 RESULT.md「证据分级策略」）
export const EVIDENCE_EFFECT = {
  verified: { drive: true, uncertain: false, autoCreate: true },
  self_reported: { drive: true, uncertain: true, autoCreate: false },
  simulated: { drive: true, uncertain: true, autoCreate: false },
};

export const KINDS = ["skill", "manual", "link", "unlink"];

// 计划 §4 有效事件表
export const SKILL_STAGE = {
  "design-feature": "Design",
  "implement-spec": "Implement",
  pr: "PR",
  retro: "Retro",
};

export const STAGES = ["Design", "Implement", "PR", "Retro"];

function fail(field, value) {
  return new Error(`invalid event: ${field}=${JSON.stringify(value)}`);
}

// 校验并规范化一条归一化事件；不合法抛错（入口硬校验，非法输入不进事件流）
export function validateEvent(ev) {
  if (!ev || typeof ev !== "object") throw fail("event", ev);
  if (!ev.eventId || typeof ev.eventId !== "string") throw fail("eventId", ev.eventId);
  if (!KINDS.includes(ev.kind)) throw fail("kind", ev.kind);
  if (!EVIDENCE_LEVELS.includes(ev.evidenceLevel)) throw fail("evidenceLevel", ev.evidenceLevel);
  if (typeof ev.occurredAt !== "string") throw fail("occurredAt", ev.occurredAt);
  if (typeof ev.receivedAt !== "string") throw fail("receivedAt", ev.receivedAt);
  if (ev.cli != null && !CLIS.includes(ev.cli)) throw fail("cli", ev.cli);
  if (ev.kind === "skill") {
    if (!ev.sessionId || typeof ev.sessionId !== "string") throw fail("sessionId", ev.sessionId);
    if (!ev.cli) throw fail("cli", ev.cli);
    if (typeof ev.skill !== "string" || !ev.skill) throw fail("skill", ev.skill);
  }
  if (ev.kind === "manual" && !STAGES.includes(ev.stage)) throw fail("stage", ev.stage);
  if (ev.kind === "manual" && !ev.requirementId) throw fail("requirementId", ev.requirementId);
  if ((ev.kind === "link" || ev.kind === "unlink") && !ev.sessionId) throw fail("sessionId", ev.sessionId);
  if (ev.kind === "link" && !ev.cli) throw fail("cli", ev.cli); // link 时 session 可能首次出现，需登记 cli；unlink 的 cli 已在 sessions 表
  if (ev.kind === "link" && !ev.requirementId) throw fail("requirementId", ev.requirementId);
  return { ...ev, seq: ev.seq ?? null, stage: ev.stage ?? null, skill: ev.skill ?? null, requirementId: ev.requirementId ?? null, sessionId: ev.sessionId ?? null, cli: ev.cli ?? null };
}
