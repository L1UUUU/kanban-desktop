// 用途：多 CLI Requirement Tracker —— 消费跨 CLI 归一化事件流，实现自动建卡、Session 关联、阶段排序、去重/乱序/延迟抵抗与证据分级（计划 §3/§4，规则基线复制自 poc-2 tracker 并扩展多 CLI 与三级证据）
// 事件形状与校验见 schema.mjs；tracker 为纯内存状态机，持久化由 engine.mjs 负责（exportState/restore 往返）

import { SKILL_STAGE, EVIDENCE_EFFECT } from "./schema.mjs";

function parseTs(ts) {
  if (!ts || typeof ts !== "string") return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

function synthEventId(ev) {
  const base =
    ev.kind === "skill"
      ? `${ev.cli}:${ev.sessionId}:${ev.skill}`
      : ev.kind === "manual"
        ? `manual:${ev.requirementId}:${ev.stage}`
        : `${ev.kind}:${ev.sessionId ?? ""}`;
  return `${base}:${ev.occurredAt ?? "no-time"}:${ev.seq ?? ""}`;
}

export class RequirementTracker {
  constructor() {
    this.requirements = new Map(); // reqId -> {id,title,stage,stageBasisAt,stageBasis,uncertain,sessions:Set}
    this.sessionToReq = new Map(); // sessionId -> reqId
    this.sessionCli = new Map(); // sessionId -> cli（首个含 sessionId 的事件到达时登记）
    this.sessionEvents = new Map(); // sessionId -> 已见 skill 事件数组（含未驱动阶段时记录的，供 link 后按实际时间同步）
    this.processed = new Set(); // eventId 幂等集合
    this.nextId = 1;
    this.log = []; // 决策日志（建卡/阶段变化/拒绝原因），供测试与审计
  }

  req(id) {
    return this.requirements.get(id);
  }

  ensureSession(sessionId, cli) {
    if (sessionId && cli && !this.sessionCli.has(sessionId)) this.sessionCli.set(sessionId, cli);
  }

  createRequirement({ title = "待命名需求", sessionId }) {
    const id = `REQ-${String(this.nextId++).padStart(3, "0")}`;
    this.requirements.set(id, { id, title, stage: null, stageBasisAt: null, stageBasis: null, uncertain: false, sessions: new Set() });
    if (sessionId) {
      this.requirements.get(id).sessions.add(sessionId);
      this.sessionToReq.set(sessionId, id);
    }
    this.log.push({ decision: "create_requirement", requirementId: id, sessionId });
    return id;
  }

  // 处理一条归一化事件，返回引发的变更列表（空数组 = 无变化）
  process(ev) {
    const eventId = ev.eventId ?? synthEventId(ev);
    if (this.processed.has(eventId)) {
      this.log.push({ decision: "duplicate_ignored", eventId });
      return [];
    }
    this.processed.add(eventId);
    this.ensureSession(ev.sessionId, ev.cli);

    if (ev.kind === "skill") return this.onSkill(ev, eventId);
    if (ev.kind === "manual") return this.onManual(ev, eventId);
    if (ev.kind === "link") return this.onLink(ev, eventId);
    if (ev.kind === "unlink") return this.onUnlink(ev, eventId);
    this.log.push({ decision: "unknown_kind_ignored", kind: ev.kind });
    return [];
  }

  onSkill(ev, eventId) {
    const changes = [];
    const effect = EVIDENCE_EFFECT[ev.evidenceLevel];
    const stage = SKILL_STAGE[ev.skill] ?? null;
    if (!stage) {
      this.log.push({ decision: "unknown_skill_ignored", skill: ev.skill });
      return changes;
    }

    // 缓存该 session 的 skill 事件（含未关联时记录的），link 后按实际发生时间同步用
    if (!this.sessionEvents.has(ev.sessionId)) this.sessionEvents.set(ev.sessionId, []);
    this.sessionEvents.get(ev.sessionId).push(ev);

    const reqId = this.sessionToReq.get(ev.sessionId);

    // 规则 §3：未关联 session 只有首次有效（verified）design-feature 建卡；其他 skill / 其他证据等级不建卡
    if (!reqId) {
      if (ev.skill === "design-feature" && effect.autoCreate) {
        const newId = this.createRequirement({ sessionId: ev.sessionId });
        const r = this.req(newId);
        r.stage = "Design";
        r.stageBasisAt = parseTs(ev.occurredAt);
        r.stageBasis = { kind: "skill", skill: ev.skill, cli: ev.cli, evidenceLevel: ev.evidenceLevel, eventId, at: ev.occurredAt };
        changes.push({ type: "requirement_created", requirementId: newId, stage: "Design", sessionId: ev.sessionId });
        this.log.push({ decision: "auto_create", requirementId: newId, sessionId: ev.sessionId, cli: ev.cli, skill: ev.skill });
        return changes;
      }
      // 未关联 + 非（design-feature×verified）：只记录 session 活动，不建卡不改阶段
      this.log.push({ decision: "unlinked_skill_no_card", sessionId: ev.sessionId, cli: ev.cli, skill: ev.skill, evidenceLevel: ev.evidenceLevel });
      return changes;
    }

    // 已关联：按证据等级效果驱动（self_reported/simulated 驱动但标 uncertain —— PoC 4 设计决策）
    return this.applyStageFromSkill(this.req(reqId), ev, stage, effect, changes);
  }

  // §4 规则核心：按 skill 实际发生时间与当前阶段依据比较；旧/乱序/延迟事件不覆盖；允许 PR→Implement 回退
  applyStageFromSkill(r, ev, stage, effect, changes) {
    const at = parseTs(ev.occurredAt);
    if (at === null) {
      // 无法可靠排序：保留当前阶段并标注不确定（§4）
      if (r.stage !== null) {
        r.uncertain = true;
        this.log.push({ decision: "unorderable_event_marked_uncertain", requirementId: r.id, skill: ev.skill });
      }
      return changes;
    }
    const cur = r.stageBasisAt;
    if (r.stage !== null && cur !== null && at < cur) {
      this.log.push({
        decision: "stale_event_ignored", requirementId: r.id, skill: ev.skill,
        eventAt: ev.occurredAt, basisAt: cur !== null ? new Date(cur).toISOString() : null,
      });
      return changes;
    }
    r.stage = stage;
    r.stageBasisAt = at;
    r.stageBasis = { kind: "skill", skill: ev.skill, cli: ev.cli, evidenceLevel: ev.evidenceLevel, eventId: ev.eventId ?? null, at: ev.occurredAt };
    r.uncertain = effect.uncertain;
    changes.push({ type: "stage_changed", requirementId: r.id, stage, basis: r.stageBasis, uncertain: r.uncertain });
    this.log.push({ decision: "stage_update", requirementId: r.id, stage, at: ev.occurredAt, evidenceLevel: ev.evidenceLevel, uncertain: r.uncertain });
    return changes;
  }

  onManual(ev, eventId) {
    // 规则 §4：用户手动修正/确认立即生效，不永久锁定；basisAt 用修正时间，之后更新的有效事件仍可覆盖
    const r = this.req(ev.requirementId);
    const changes = [];
    if (!r) {
      this.log.push({ decision: "manual_no_requirement", requirementId: ev.requirementId });
      return changes;
    }
    const at = parseTs(ev.occurredAt);
    r.stage = ev.stage;
    r.stageBasisAt = at; // 时间不可解析则置空 → 后续任何有效事件都可覆盖
    r.stageBasis = { kind: "manual", eventId, at: ev.occurredAt, source: ev.source ?? null };
    r.uncertain = false; // 用户已亲自介入，视为确认
    changes.push({ type: "stage_changed", requirementId: r.id, stage: ev.stage, basis: r.stageBasis, uncertain: false });
    this.log.push({ decision: "manual_override", requirementId: r.id, stage: ev.stage, source: ev.source ?? null });
    return changes;
  }

  onLink(ev, eventId) {
    // 规则 §3/§4：关联 session 到需求；同一 session 同一时刻最多归属一个需求；阶段按该 session 已见 skill 事件的「实际发生时间」同步
    const changes = [];
    const r = this.req(ev.requirementId);
    if (!r) {
      this.log.push({ decision: "link_no_requirement", requirementId: ev.requirementId });
      return changes;
    }
    const existing = this.sessionToReq.get(ev.sessionId);
    if (existing === ev.requirementId) {
      this.log.push({ decision: "link_already_associated", sessionId: ev.sessionId, requirementId: ev.requirementId });
      return changes;
    }
    if (existing) {
      // 一个 session 同一时刻最多归属一个需求（§3）
      this.log.push({ decision: "link_conflict_rejected", sessionId: ev.sessionId, currentRequirement: existing, requested: ev.requirementId });
      return changes;
    }
    r.sessions.add(ev.sessionId);
    this.sessionToReq.set(ev.sessionId, r.id);
    changes.push({ type: "session_linked", requirementId: r.id, sessionId: ev.sessionId });
    this.log.push({ decision: "link", requirementId: r.id, sessionId: ev.sessionId, cli: ev.cli });

    // 关联后同步：取该 session 已见 skill 事件中可驱动且时间最新的，与当前阶段依据按实际发生时间比较（§4：不以关联操作时间冒充调用时间）
    const seen = (this.sessionEvents.get(ev.sessionId) ?? [])
      .filter((e) => SKILL_STAGE[e.skill] && EVIDENCE_EFFECT[e.evidenceLevel].drive)
      .sort((a, b) => (parseTs(a.occurredAt) ?? 0) - (parseTs(b.occurredAt) ?? 0));
    const latest = seen[seen.length - 1];
    if (latest) {
      const stage = SKILL_STAGE[latest.skill];
      this.log.push({ decision: "link_stage_sync", requirementId: r.id, sessionId: ev.sessionId, skill: latest.skill, eventAt: latest.occurredAt, note: "以 skill 实际发生时间与当前依据比较" });
      changes.push(...this.applyStageFromSkill(r, latest, stage, EVIDENCE_EFFECT[latest.evidenceLevel], []));
    } else {
      this.log.push({ decision: "link_no_stage_signal", requirementId: r.id, sessionId: ev.sessionId });
    }
    return changes;
  }

  onUnlink(ev) {
    // 规则 §4：解除关联不删历史、不回退阶段
    const changes = [];
    const reqId = this.sessionToReq.get(ev.sessionId);
    if (!reqId) return changes;
    this.sessionToReq.delete(ev.sessionId);
    this.req(reqId).sessions.delete(ev.sessionId);
    changes.push({ type: "session_unlinked", requirementId: reqId, sessionId: ev.sessionId, stageKept: this.req(reqId).stage });
    this.log.push({ decision: "unlink_stage_kept", requirementId: reqId, sessionId: ev.sessionId, stage: this.req(reqId).stage });
    return changes;
  }

  // ---- 持久化往返（engine 调用） ----

  exportState() {
    return {
      requirements: [...this.requirements.values()].map((r) => ({ ...r, sessions: [...r.sessions] })),
      sessionToReq: [...this.sessionToReq.entries()],
      sessionCli: [...this.sessionCli.entries()],
      sessionEvents: [...this.sessionEvents.entries()].map(([sid, evs]) => [sid, evs.map((e) => ({ ...e }))]),
      processedEventIds: [...this.processed],
      nextId: this.nextId,
    };
  }

  restore(state) {
    this.requirements = new Map(state.requirements.map((r) => [r.id, { ...r, sessions: new Set(r.sessions) }]));
    this.sessionToReq = new Map(state.sessionToReq);
    this.sessionCli = new Map(state.sessionCli);
    this.sessionEvents = new Map(state.sessionEvents.map(([sid, evs]) => [sid, evs.map((e) => ({ ...e }))]));
    this.processed = new Set(state.processedEventIds);
    this.nextId = state.nextId;
  }

  snapshot() {
    const out = [];
    for (const r of this.requirements.values()) {
      out.push({ id: r.id, title: r.title, stage: r.stage, stageBasis: r.stageBasis, uncertain: r.uncertain, sessions: [...r.sessions] });
    }
    return out;
  }
}
