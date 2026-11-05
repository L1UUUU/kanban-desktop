// 用途：Requirement Tracker —— 消费归一化 Skill/手动修正/关联事件流，实现自动建卡、阶段排序、幂等与冲突规则（计划 §3/§4）
// 事件输入格式（JSONL，每行一个）：
//   { kind: "skill", sessionId, cli, skill, occurredAt(ISO), evidenceLevel: "verified"|"self_reported", eventId?, seq? }
//   { kind: "manual", requirementId, stage, occurredAt, eventId?, seq? }        // 用户手动修正阶段
//   { kind: "link",   sessionId, requirementId, occurredAt, eventId?, seq? }    // 关联 session 到需求
//   { kind: "unlink", sessionId, occurredAt, eventId?, seq? }                   // 解除关联
// 幂等键：eventId 优先；缺失时用 kind+sessionId+skill/stage+occurredAt 合成。

export const SKILL_STAGE = {
  "design-feature": "Design",
  "implement-spec": "Implement",
  pr: "PR",
  retro: "Retro",
};

// 证据等级：verified = CLI 原生 hook 确认的 Skill 调用；self_reported = 仅自报，不驱动阶段
export const TRUSTED_EVIDENCE = new Set(["verified"]);

// 从 hook-events.jsonl（本 PoC 的 hook 捕获格式）转换为归一化 skill 事件流
export function transformHookEvents(lines) {
  const out = [];
  for (const line of lines) {
    let e;
    try {
      e = typeof line === "string" ? JSON.parse(line) : line;
    } catch {
      continue;
    }
    // 只取 PreToolUse 的 Skill 工具调用作为 verified 证据（PostToolUse 可用于成功确认，此处从简）
    if (e.hookEventName !== "PreToolUse" || e.toolName !== "Skill") continue;
    const skill = e.toolInput?.skill ?? e.toolInput?.command ?? null;
    if (!skill) continue;
    out.push({
      kind: "skill",
      sessionId: e.sessionId,
      cli: e.cli ?? "claude-code",
      skill,
      occurredAt: e.capturedAt,
      evidenceLevel: "verified",
      eventId: `hook:${e.sessionId}:${skill}:${e.capturedAt}`,
      transcriptPath: e.transcriptPath ?? null,
    });
  }
  return out;
}

function synthEventId(ev) {
  const base = ev.kind === "skill" ? `${ev.sessionId}:${ev.skill}` : ev.kind === "manual" ? `manual:${ev.requirementId}:${ev.stage}` : `${ev.kind}:${ev.sessionId}`;
  return `${base}:${ev.occurredAt ?? "no-time"}:${ev.seq ?? ""}`;
}

function parseTs(ts) {
  if (!ts || typeof ts !== "string") return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

export class RequirementTracker {
  constructor() {
    this.requirements = new Map(); // reqId -> {id,title,stage,stageBasisAt,stageBasis,uncertain,sessions:Set,activity:[]}
    this.sessionToReq = new Map(); // sessionId -> reqId
    this.processed = new Set(); // eventId 幂等
    this.nextId = 1;
    this.log = []; // 决策日志（建卡/阶段变化/拒绝原因），便于测试与审计
  }

  req(id) {
    return this.requirements.get(id);
  }

  createRequirement({ title = "待命名需求", sessionId }) {
    const id = `REQ-${String(this.nextId++).padStart(3, "0")}`;
    this.requirements.set(id, { id, title, stage: null, stageBasisAt: null, stageBasis: null, uncertain: false, sessions: new Set(), activity: [] });
    if (sessionId) {
      this.requirements.get(id).sessions.add(sessionId);
      this.sessionToReq.set(sessionId, id);
    }
    this.log.push({ decision: "create_requirement", requirementId: id, sessionId });
    return id;
  }

  // 处理一条事件，返回本条引发的变更列表（空数组 = 无变化）
  process(ev) {
    const eventId = ev.eventId ?? synthEventId(ev);
    if (this.processed.has(eventId)) {
      this.log.push({ decision: "duplicate_ignored", eventId });
      return [];
    }
    this.processed.add(eventId);

    if (ev.kind === "skill") return this.onSkill(ev);
    if (ev.kind === "manual") return this.onManual(ev);
    if (ev.kind === "link") return this.onLink(ev);
    if (ev.kind === "unlink") return this.onUnlink(ev);
    this.log.push({ decision: "unknown_kind_ignored", kind: ev.kind });
    return [];
  }

  onSkill(ev) {
    const changes = [];
    const reqId = this.sessionToReq.get(ev.sessionId);
    const stage = SKILL_STAGE[ev.skill] ?? null;

    // 规则 §3：未关联 session 只有首次有效 design-feature 建卡；其他 skill 不建卡
    if (!reqId) {
      const effective = TRUSTED_EVIDENCE.has(ev.evidenceLevel);
      if (ev.skill === "design-feature" && effective) {
        const newId = this.createRequirement({ sessionId: ev.sessionId });
        const r = this.req(newId);
        r.stage = "Design";
        r.stageBasisAt = parseTs(ev.occurredAt);
        r.stageBasis = { kind: "skill", skill: ev.skill, eventId: ev.eventId ?? null, at: ev.occurredAt };
        changes.push({ type: "requirement_created", requirementId: newId, stage: "Design" });
        this.log.push({ decision: "auto_create", requirementId: newId, sessionId: ev.sessionId, skill: ev.skill });
        return changes;
      }
      // 未关联 + 非 design-feature（或证据不足）：记录 session 活动，不建卡不改阶段
      this.log.push({ decision: "unlinked_skill_no_card", sessionId: ev.sessionId, skill: ev.skill, effective });
      return changes;
    }

    // 已关联：证据不足只记活动
    if (!TRUSTED_EVIDENCE.has(ev.evidenceLevel)) {
      this.req(reqId).activity.push({ at: ev.occurredAt, sessionId: ev.sessionId, skill: ev.skill, evidenceLevel: ev.evidenceLevel });
      this.log.push({ decision: "self_reported_activity_only", requirementId: reqId, skill: ev.skill });
      return changes;
    }

    // 规则 §4：按 skill 实际发生时间与当前阶段依据比较；旧事件/乱序不覆盖
    const at = parseTs(ev.occurredAt);
    const r = this.req(reqId);
    if (!stage) {
      this.log.push({ decision: "unknown_skill_ignored", skill: ev.skill });
      return changes;
    }
    if (at === null) {
      // 无法可靠排序：保留当前阶段并标注不确定（§4）
      if (r.stage !== null) {
        r.uncertain = true;
        this.log.push({ decision: "unorderable_event_marked_uncertain", requirementId: reqId, skill: ev.skill });
      }
      return changes;
    }
    const cur = r.stageBasisAt;
    if (r.stage !== null && cur !== null && at < cur) {
      this.log.push({ decision: "stale_event_ignored", requirementId: reqId, skill: ev.skill, eventAt: ev.occurredAt, basisAt: new Date(cur).toISOString() });
      return changes;
    }
    r.stage = stage;
    r.stageBasisAt = at;
    r.stageBasis = { kind: "skill", skill: ev.skill, at: ev.occurredAt };
    r.uncertain = false;
    changes.push({ type: "stage_changed", requirementId: reqId, stage, basis: r.stageBasis });
    this.log.push({ decision: "stage_update", requirementId: reqId, stage, at: ev.occurredAt });
    return changes;
  }

  onManual(ev) {
    // 规则 §4：手动修正立即生效，不永久锁定；basisAt 用修正时间，后续更新的有效事件可覆盖
    const r = this.req(ev.requirementId);
    const changes = [];
    if (!r) {
      this.log.push({ decision: "manual_no_requirement", requirementId: ev.requirementId });
      return changes;
    }
    const at = parseTs(ev.occurredAt);
    r.stage = ev.stage;
    r.stageBasisAt = at; // 若时间不可解析则置空 → 后续任何有效事件都可覆盖
    r.stageBasis = { kind: "manual", at: ev.occurredAt };
    r.uncertain = false;
    changes.push({ type: "stage_changed", requirementId: r.id, stage: ev.stage, basis: r.stageBasis });
    this.log.push({ decision: "manual_override", requirementId: r.id, stage: ev.stage });
    return changes;
  }

  onLink(ev) {
    // 规则 §3/§4：关联已有 session 到需求；session 带来的最近 skill 事件按实际时间与当前依据比较
    const changes = [];
    const r = this.req(ev.requirementId);
    if (!r) {
      this.log.push({ decision: "link_no_requirement", requirementId: ev.requirementId });
      return changes;
    }
    if (this.sessionToReq.has(ev.sessionId)) {
      this.log.push({ decision: "link_already_associated", sessionId: ev.sessionId });
      return changes;
    }
    r.sessions.add(ev.sessionId);
    this.sessionToReq.set(ev.sessionId, r.id);
    changes.push({ type: "session_linked", requirementId: r.id, sessionId: ev.sessionId });
    this.log.push({ decision: "link", requirementId: r.id, sessionId: ev.sessionId, note: "该 session 的历史 skill 事件由后续 process 调用按实际发生时间重放比较" });
    return changes;
  }

  onUnlink(ev) {
    // 规则 §4：解除关联不回退阶段
    const changes = [];
    const reqId = this.sessionToReq.get(ev.sessionId);
    if (!reqId) return changes;
    this.sessionToReq.delete(ev.sessionId);
    this.req(reqId).sessions.delete(ev.sessionId);
    changes.push({ type: "session_unlinked", requirementId: reqId, sessionId: ev.sessionId, stageKept: this.req(reqId).stage });
    this.log.push({ decision: "unlink_stage_kept", requirementId: reqId, sessionId: ev.sessionId, stage: this.req(reqId).stage });
    return changes;
  }

  snapshot() {
    const out = [];
    for (const r of this.requirements.values()) {
      out.push({ id: r.id, title: r.title, stage: r.stage, stageBasis: r.stageBasis, uncertain: r.uncertain, sessions: [...r.sessions], activityCount: r.activity.length });
    }
    return out;
  }
}
