// 用途：多 CLI Requirement Tracker 状态机（演进自 poc-4 tracker.mjs，规则基线 poc-2）—— 自动建卡/关联/阶段排序/乱序延迟抵抗/证据分级；纯内存，持久化由 engine 负责
import { EVIDENCE_EFFECT, SKILL_STAGE, type Cli, type EvidenceLevel, type NormalizedEvent, type Stage } from "./schema";

/** 阶段依据：skill 事件（实际发生时间）或用户手动修正 */
export type StageBasis =
  | { kind: "skill"; skill: string; cli: Cli; evidenceLevel: EvidenceLevel; eventId: string | null; at: string }
  | { kind: "manual"; eventId: string; at: string; source: string | null };

export interface RequirementState {
  id: string;
  title: string;
  stage: Stage | null;
  stageBasisAt: number | null;
  stageBasis: StageBasis | null;
  uncertain: boolean;
  sessions: Set<string>;
}

/** 状态机引发的变更（空数组 = 无变化；供 UI/审计消费） */
export type TrackerChange =
  | { type: "requirement_created"; requirementId: string; stage: Stage; sessionId: string }
  | { type: "stage_changed"; requirementId: string; stage: Stage; basis: StageBasis; uncertain: boolean }
  | { type: "session_linked"; requirementId: string; sessionId: string }
  | { type: "session_unlinked"; requirementId: string; sessionId: string; stageKept: Stage | null };

/** 看板快照行（sessions 数组化，可 JSON 化） */
export interface RequirementSnapshot {
  id: string;
  title: string;
  stage: Stage | null;
  stageBasis: StageBasis | null;
  uncertain: boolean;
  sessions: string[];
}

/** 决策日志行（建卡/阶段变化/拒绝原因，测试与审计用） */
export interface DecisionLogEntry {
  decision: string;
  [key: string]: unknown;
}

function parseTs(ts: string | null): number | null {
  if (!ts || typeof ts !== "string") return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

export class RequirementTracker {
  readonly requirements = new Map<string, RequirementState>();
  readonly sessionToReq = new Map<string, string>();
  readonly sessionCli = new Map<string, Cli>();
  /** sessionId -> 已见 skill 事件（含未驱动阶段时记录的，供 link 后按实际时间同步） */
  readonly sessionEvents = new Map<string, NormalizedEvent[]>();
  /** eventId 幂等集合 */
  readonly processed = new Set<string>();
  nextId = 1;
  readonly log: DecisionLogEntry[] = [];

  req(id: string): RequirementState | undefined {
    return this.requirements.get(id);
  }

  ensureSession(sessionId: string | null, cli: Cli | null): void {
    if (sessionId && cli && !this.sessionCli.has(sessionId)) this.sessionCli.set(sessionId, cli);
  }

  createRequirement({ title = "待命名需求", sessionId }: { title?: string; sessionId?: string }): string {
    const id = `REQ-${String(this.nextId++).padStart(3, "0")}`;
    const r: RequirementState = { id, title, stage: null, stageBasisAt: null, stageBasis: null, uncertain: false, sessions: new Set() };
    this.requirements.set(id, r);
    if (sessionId) {
      r.sessions.add(sessionId);
      this.sessionToReq.set(sessionId, id);
    }
    this.log.push({ decision: "create_requirement", requirementId: id, sessionId: sessionId ?? null });
    return id;
  }

  /** 处理一条归一化事件，返回引发的变更列表（空数组 = 无变化）；eventId 幂等 */
  process(ev: NormalizedEvent): TrackerChange[] {
    if (this.processed.has(ev.eventId)) {
      this.log.push({ decision: "duplicate_ignored", eventId: ev.eventId });
      return [];
    }
    this.processed.add(ev.eventId);
    this.ensureSession(ev.sessionId, ev.cli);

    if (ev.kind === "skill") return this.onSkill(ev);
    if (ev.kind === "manual") return this.onManual(ev);
    if (ev.kind === "link") return this.onLink(ev);
    return this.onUnlink(ev);
  }

  private onSkill(ev: NormalizedEvent): TrackerChange[] {
    const changes: TrackerChange[] = [];
    const effect = EVIDENCE_EFFECT[ev.evidenceLevel];
    const stage = SKILL_STAGE[ev.skill as keyof typeof SKILL_STAGE] ?? null;
    if (!stage) {
      this.log.push({ decision: "unknown_skill_ignored", skill: ev.skill });
      return changes;
    }
    if (ev.sessionId == null) return changes; // schema 已保证 skill 事件带 sessionId（类型收窄守卫）

    // 缓存该 session 的 skill 事件（含未关联时记录的），link 后按实际发生时间同步用
    const seen = this.sessionEvents.get(ev.sessionId) ?? [];
    seen.push(ev);
    this.sessionEvents.set(ev.sessionId, seen);

    const reqId = this.sessionToReq.get(ev.sessionId);

    // 规则 §3：未关联 session 只有首次有效（verified）design-feature 建卡；其他 skill / 其他证据等级不建卡
    if (!reqId) {
      if (ev.skill === "design-feature" && effect.autoCreate) {
        const newId = this.createRequirement({ sessionId: ev.sessionId });
        const r = this.req(newId)!;
        r.stage = "Design";
        r.stageBasisAt = parseTs(ev.occurredAt);
        r.stageBasis = { kind: "skill", skill: ev.skill, cli: ev.cli!, evidenceLevel: ev.evidenceLevel, eventId: ev.eventId, at: ev.occurredAt };
        changes.push({ type: "requirement_created", requirementId: newId, stage: "Design", sessionId: ev.sessionId });
        this.log.push({ decision: "auto_create", requirementId: newId, sessionId: ev.sessionId, cli: ev.cli, skill: ev.skill });
        return changes;
      }
      // 未关联 + 非（design-feature×verified）：只记录 session 活动，不建卡不改阶段
      this.log.push({ decision: "unlinked_skill_no_card", sessionId: ev.sessionId, cli: ev.cli, skill: ev.skill, evidenceLevel: ev.evidenceLevel });
      return changes;
    }

    // 已关联：按证据等级效果驱动（self_reported/simulated 驱动但标 uncertain —— C2 冻结）
    return this.applyStageFromSkill(this.req(reqId)!, ev, stage, effect, changes);
  }

  // §4 规则核心：按 skill 实际发生时间与当前阶段依据比较；旧/乱序/延迟事件不覆盖；允许 PR→Implement 回退
  private applyStageFromSkill(r: RequirementState, ev: NormalizedEvent, stage: Stage, effect: (typeof EVIDENCE_EFFECT)[EvidenceLevel], changes: TrackerChange[]): TrackerChange[] {
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
        decision: "stale_event_ignored",
        requirementId: r.id,
        skill: ev.skill,
        eventAt: ev.occurredAt,
        basisAt: cur !== null ? new Date(cur).toISOString() : null,
      });
      return changes;
    }
    r.stage = stage;
    r.stageBasisAt = at;
    r.stageBasis = { kind: "skill", skill: ev.skill!, cli: ev.cli!, evidenceLevel: ev.evidenceLevel, eventId: ev.eventId, at: ev.occurredAt };
    r.uncertain = effect.uncertain;
    changes.push({ type: "stage_changed", requirementId: r.id, stage, basis: r.stageBasis, uncertain: r.uncertain });
    this.log.push({ decision: "stage_update", requirementId: r.id, stage, at: ev.occurredAt, evidenceLevel: ev.evidenceLevel, uncertain: r.uncertain });
    return changes;
  }

  private onManual(ev: NormalizedEvent): TrackerChange[] {
    // 规则 §4：用户手动修正/确认立即生效，不永久锁定；basisAt 用修正时间，之后更新的有效事件仍可覆盖
    const r = this.req(ev.requirementId!);
    const changes: TrackerChange[] = [];
    if (!r) {
      this.log.push({ decision: "manual_no_requirement", requirementId: ev.requirementId });
      return changes;
    }
    const at = parseTs(ev.occurredAt);
    r.stage = ev.stage as Stage;
    r.stageBasisAt = at; // 时间不可解析则置空 → 后续任何有效事件都可覆盖
    r.stageBasis = { kind: "manual", eventId: ev.eventId, at: ev.occurredAt, source: ev.source || null };
    r.uncertain = false; // 用户已亲自介入，视为确认
    changes.push({ type: "stage_changed", requirementId: r.id, stage: r.stage, basis: r.stageBasis, uncertain: false });
    this.log.push({ decision: "manual_override", requirementId: r.id, stage: r.stage, source: ev.source || null });
    return changes;
  }

  private onLink(ev: NormalizedEvent): TrackerChange[] {
    // 规则 §3/§4：关联 session 到需求；同一 session 同一时刻最多归属一个需求；阶段按已见 skill 事件的「实际发生时间」同步
    const changes: TrackerChange[] = [];
    const r = this.req(ev.requirementId!);
    if (!r) {
      this.log.push({ decision: "link_no_requirement", requirementId: ev.requirementId });
      return changes;
    }
    const existing = this.sessionToReq.get(ev.sessionId!);
    if (existing === ev.requirementId) {
      this.log.push({ decision: "link_already_associated", sessionId: ev.sessionId, requirementId: ev.requirementId });
      return changes;
    }
    if (existing) {
      // 一个 session 同一时刻最多归属一个需求（§3）
      this.log.push({ decision: "link_conflict_rejected", sessionId: ev.sessionId, currentRequirement: existing, requested: ev.requirementId });
      return changes;
    }
    r.sessions.add(ev.sessionId!);
    this.sessionToReq.set(ev.sessionId!, r.id);
    changes.push({ type: "session_linked", requirementId: r.id, sessionId: ev.sessionId! });
    this.log.push({ decision: "link", requirementId: r.id, sessionId: ev.sessionId, cli: ev.cli });

    // 关联后同步：取该 session 已见 skill 事件中可驱动且时间最新的，与当前阶段依据按实际发生时间比较（§4：不以关联操作时间冒充调用时间）
    const seen = (this.sessionEvents.get(ev.sessionId!) ?? [])
      .filter((e) => SKILL_STAGE[e.skill as keyof typeof SKILL_STAGE] && EVIDENCE_EFFECT[e.evidenceLevel].drive)
      .sort((a, b) => (parseTs(a.occurredAt) ?? 0) - (parseTs(b.occurredAt) ?? 0));
    const latest = seen[seen.length - 1];
    if (latest) {
      const stage = SKILL_STAGE[latest.skill as keyof typeof SKILL_STAGE]!;
      this.log.push({ decision: "link_stage_sync", requirementId: r.id, sessionId: ev.sessionId, skill: latest.skill, eventAt: latest.occurredAt, note: "以 skill 实际发生时间与当前依据比较" });
      changes.push(...this.applyStageFromSkill(r, latest, stage, EVIDENCE_EFFECT[latest.evidenceLevel], []));
    } else {
      this.log.push({ decision: "link_no_stage_signal", requirementId: r.id, sessionId: ev.sessionId });
    }
    return changes;
  }

  private onUnlink(ev: NormalizedEvent): TrackerChange[] {
    // 规则 §4：解除关联不删历史、不回退阶段
    const changes: TrackerChange[] = [];
    const reqId = this.sessionToReq.get(ev.sessionId!);
    if (!reqId) return changes;
    this.sessionToReq.delete(ev.sessionId!);
    this.req(reqId)!.sessions.delete(ev.sessionId!);
    changes.push({ type: "session_unlinked", requirementId: reqId, sessionId: ev.sessionId!, stageKept: this.req(reqId)!.stage });
    this.log.push({ decision: "unlink_stage_kept", requirementId: reqId, sessionId: ev.sessionId, stage: this.req(reqId)!.stage });
    return changes;
  }

  /** 看板快照（终态视图） */
  snapshot(): RequirementSnapshot[] {
    const out: RequirementSnapshot[] = [];
    for (const r of this.requirements.values()) {
      out.push({ id: r.id, title: r.title, stage: r.stage, stageBasis: r.stageBasis, uncertain: r.uncertain, sessions: [...r.sessions] });
    }
    return out;
  }
}

/** Claude hook 事件行 → verified 归一化事件（演进自 poc-2 transformHookEvents）：只取 PreToolUse(Skill)；eventId 确定性合成（同 hook 重发幂等）；#10 Claude Adapter 的接入点 */
export function transformHookEvents(lines: string[]): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const line of lines) {
    let e: Record<string, unknown>;
    try {
      e = (typeof line === "string" ? JSON.parse(line) : line) as Record<string, unknown>;
    } catch {
      continue;
    }
    // 只取 PreToolUse 的 Skill 工具调用作为 verified 证据（verified 只认 hook —— C2）
    if (e.hookEventName !== "PreToolUse" || e.toolName !== "Skill") continue;
    const toolInput = (e.toolInput ?? {}) as Record<string, unknown>;
    const skill = (toolInput.skill as string | undefined) ?? (toolInput.command as string | undefined) ?? null;
    if (!skill) continue;
    const sessionId = e.sessionId as string;
    const capturedAt = e.capturedAt as string;
    out.push({
      eventId: `hook:${sessionId}:${skill}:${capturedAt}`,
      kind: "skill",
      sessionId,
      cli: "claude-code",
      skill,
      stage: null,
      requirementId: null,
      occurredAt: capturedAt,
      receivedAt: capturedAt,
      seq: null,
      evidenceLevel: "verified",
      source: "claude-hook",
    });
  }
  return out;
}
