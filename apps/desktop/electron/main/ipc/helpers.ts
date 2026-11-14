// 用途：kanban:ipc 子通道 handler 跨 feature 共享辅助 —— CLI 口径映射 / GUI 事件工厂 / 事件流落库与推送 / 创建后原子关联 / 会话行目录身份投影（#72 C1 Step2 自 ipc.ts 原样迁入；会话编排主体在 session-lifecycle，#70 C2；arch C12 起目录身份 wire 形状单点、arch D1 起 link 拒绝文案单点在此）
import { type Cli, type LinkRejectionReason, type NormalizedEvent, type TrackerChange } from "@kanban/tracker";
import type { SessionRow } from "@kanban/ipc-schema";
import type { IpcDeps } from "../ipc";
import { detectDirIdentity } from "../git-identity";

/** 会话行目录身份投影（arch C12 wire 形状单点）：cwd → { dirIdentity, worktreeName }——session:list 行投影与
 *  session:create / terminal:create 响应共用同一形状知识；逐行判定语义保持，不做判定缓存 */
export function dirIdentityFields(cwd: string | null): Pick<SessionRow, "dirIdentity" | "worktreeName"> {
  const identity = cwd ? detectDirIdentity(cwd) : { kind: "none" as const };
  return { dirIdentity: identity.kind, worktreeName: identity.kind === "worktree" ? identity.name : null };
}

/** 应用侧 cli 名（sessions 表：fake/codex/claude/opencode/pty）→ tracker CLIS（claude-code/codex/opencode/pty）；
 *  fake 演示链路的观察信号由 FakeAdapter 以 claude-code 口径上报，故同映射到 claude-code；
 *  #31 起 memory 装配复用本映射把关联会话 cli 归一为 tracker 口径（arch C10 起消费方 = linked-sessions.ts） */
export const TRACKER_CLI_BY_APP: Record<string, Cli> = {
  fake: "claude-code",
  codex: "codex",
  claude: "claude-code",
  opencode: "opencode",
  pty: "pty",
};

/** 统一时间戳（事件 occurredAt/receivedAt/eventId 后缀共用同一时刻） */
function nowIso(): string {
  return new Date().toISOString();
}

/** GUI 通道事件工厂（S1 评审收敛）：kanban:create/rename/setStage/unlink/delete 与 link 共用——缺省空 sessionId/cli/skill/
 *  stage/title/projectId/seq、verified 证据、同一 nowIso 时刻（eventId 后缀与 occurredAt/receivedAt 一致）；eventId = `${prefix}:${at}` */
export function guiEvent(
  prefix: string,
  partial: { kind: NormalizedEvent["kind"]; source: string; requirementId: string | null } & Partial<
    Pick<NormalizedEvent, "sessionId" | "cli" | "stage" | "title" | "projectId">
  >,
): NormalizedEvent {
  const at = nowIso();
  return {
    eventId: `${prefix}:${at}`,
    kind: partial.kind,
    sessionId: partial.sessionId ?? null,
    cli: partial.cli ?? null,
    skill: null,
    stage: partial.stage ?? null,
    requirementId: partial.requirementId,
    title: partial.title ?? null,
    projectId: partial.projectId ?? null,
    occurredAt: at,
    receivedAt: at,
    seq: null,
    evidenceLevel: "verified",
    source: partial.source,
  };
}

/** link 拒绝文案单源（arch D1）：tracker 结构化拒绝原因 → 用户可读中文；kanban:link 与创建后原子关联共用（替代两处逐字手抄） */
export function linkRejectionMessage(reason: LinkRejectionReason): string {
  switch (reason.kind) {
    case "requirement_absent":
      return `需求不存在：${reason.requirementId}`;
    case "session_conflict":
      return `会话已关联需求 ${reason.currentRequirementId}，请先解除关联`;
    case "session_unprojected":
      return "会话未归属项目，无法关联需求（请先在项目中创建会话）";
    case "project_mismatch":
      return `跨项目关联被拒绝：会话属项目 ${reason.sessionProjectId}，需求属项目 ${reason.requirementProjectId}`;
  }
}

/** 创建会话后的原子关联（session:create / terminal:create + requirementId 共用）：规则判定经 tracker.linkVerdict 单源（arch D1）；
 *  业务拒绝是合法结果——返回 {linked:false, reason} 直达调用方，不落 link 事件 */
export function linkAfterCreate(
  deps: IpcDeps,
  sessionId: string,
  requirementId: string,
  projectId: string | null,
  cli: Cli,
): { linked: boolean; reason?: string } {
  const verdict = deps.engine.tracker.linkVerdict(sessionId, requirementId, projectId);
  if (verdict.outcome === "rejected") return { linked: false, reason: linkRejectionMessage(verdict.reason) };
  if (verdict.outcome === "proceed") processLink(deps, sessionId, requirementId, verdict.projectId, cli);
  return { linked: true }; // proceed 落链成功；idempotent（新建会话理论不至）免落事件直接视为已关联
}

/** 构造 link 事件经 engine 落事件流并推送变更（kanban:link 与 session:create/terminal:create+requirementId 共用原子路径） */
export function processLink(deps: IpcDeps, sessionId: string, requirementId: string, projectId: string, cli: Cli): TrackerChange[] {
  return processAndEmit(deps, guiEvent(`link:${sessionId}:${requirementId}`, {
    kind: "link",
    source: "gui-card",
    requirementId,
    sessionId,
    cli,
    projectId,
  }));
}

/** 经 engine 落事件流并把引发的 tracker 变更推送 renderer（状态变化唯一路径：事件溯源 + tracker:event） */
export function processAndEmit(deps: IpcDeps, ev: NormalizedEvent): TrackerChange[] {
  const { changes } = deps.engine.process(ev);
  for (const c of changes) deps.emitTrackerChange?.(c);
  return changes;
}
