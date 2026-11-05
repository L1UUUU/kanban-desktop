// 用途：合成事件生成器 —— 生成带 simulated 证据等级的归一化事件（OpenCode 凭据过期无法真实调用，其分支以合成事件喂入同一归一化流；延迟旧事件/乱序并发等规则注入也复用此模块）
import { randomUUID } from "node:crypto";

// 合成 skill 事件（evidenceLevel 恒为 simulated，source 标注合成来源；occurredAt 可指定任意时间以模拟延迟/乱序）
export function synthSkillEvent({ sessionId, cli = "opencode", skill, occurredAt, seq = null, note = null }) {
  return {
    eventId: `synth:${cli}:${sessionId}:${skill}:${occurredAt}:${randomUUID().slice(0, 8)}`,
    kind: "skill",
    sessionId,
    cli,
    skill,
    stage: null,
    requirementId: null,
    occurredAt,
    receivedAt: new Date().toISOString(),
    seq,
    evidenceLevel: "simulated",
    source: note ? `synthetic:${note}` : "synthetic",
  };
}

// 合成 GUI 动作事件（link/unlink/manual），GUI 自身发起的动作证据等级为 verified（GUI 是自己动作的真相源）
export function guiEvent(kind, fields) {
  const occurredAt = fields.occurredAt ?? new Date().toISOString();
  const identity = kind === "manual" ? `${fields.requirementId}:${fields.stage}` : `${fields.sessionId}:${fields.requirementId ?? ""}`;
  return {
    eventId: `gui:${kind}:${identity}:${occurredAt}:${randomUUID().slice(0, 8)}`,
    kind,
    sessionId: fields.sessionId ?? null,
    cli: fields.cli ?? null,
    skill: null,
    stage: fields.stage ?? null,
    requirementId: fields.requirementId ?? null,
    occurredAt,
    receivedAt: new Date().toISOString(),
    seq: null,
    evidenceLevel: "verified",
    source: fields.source ?? "gui",
  };
}
