// 用途：tracker 测试共享构造器 —— 固定时间轴 + 各类归一化事件工厂（#16 起含 projectId/title 可选参与 mkCreate/mkRename/mkDelete；演进自 poc-4 tracker.test.mjs 的 mk* 辅助与测试用 SQLite 打开器）
import * as nodeSqlite from "node:sqlite";
import type { NormalizedEvent } from "./schema";

// 固定时间轴 t1<t2<...<t9，避免真实时钟抖动
export const T = {
  t1: "2026-11-05T10:00:01.000Z",
  t2: "2026-11-05T10:00:02.000Z",
  t3: "2026-11-05T10:00:03.000Z",
  t4: "2026-11-05T10:00:04.000Z",
  t5: "2026-11-05T10:00:05.000Z",
  t6: "2026-11-05T10:00:06.000Z",
  t7: "2026-11-05T10:00:07.000Z",
  t8: "2026-11-05T10:00:08.000Z",
  t9: "2026-11-05T10:00:09.000Z",
} as const;

let n = 0;
// v2 wire 契约（spec #15 A 节）：进 Engine 的事件由 Main 注入会话项目；工厂缺省给测试项目 p-test，行为用例无需逐条携带
const DEFAULT_PROJECT = "p-test";

/** skill 事件工厂（eventId 缺省自增；时间/证据等级/CLI/projectId 可覆盖） */
export function mkSkill({
  sessionId = "s-a",
  cli = "claude-code",
  skill = "design-feature",
  at = T.t1,
  evidence = "verified",
  eventId,
  seq = null,
  projectId = DEFAULT_PROJECT,
}: {
  sessionId?: string;
  cli?: "claude-code" | "codex" | "opencode";
  skill?: string;
  at?: string;
  evidence?: "verified" | "self_reported" | "simulated";
  eventId?: string;
  seq?: number | null;
  projectId?: string | null;
} = {}): NormalizedEvent {
  return {
    eventId: eventId ?? `ev-${++n}`,
    kind: "skill",
    sessionId,
    cli,
    skill,
    stage: null,
    requirementId: null,
    title: null,
    projectId,
    occurredAt: at,
    receivedAt: at,
    seq,
    evidenceLevel: evidence,
    source: "test",
  };
}

/** 手动修正/确认事件工厂（stage 支持 "none" 字面量——归一测试用） */
export function mkManual(reqId: string, stage: string, at: string, source = "gui-manual"): NormalizedEvent {
  return {
    eventId: `m-${++n}`,
    kind: "manual",
    sessionId: null,
    cli: null,
    skill: null,
    stage,
    requirementId: reqId,
    title: null,
    projectId: null,
    occurredAt: at,
    receivedAt: at,
    seq: null,
    evidenceLevel: "verified",
    source,
  };
}

/** GUI 关联事件工厂（cli 允许 pty；#16 起携带 session 项目，缺省与 mkSkill 同项目） */
export function mkLink(
  sessionId: string,
  reqId: string,
  at: string,
  cli: "claude-code" | "codex" | "opencode" | "pty" = "codex",
  projectId: string | null = DEFAULT_PROJECT,
): NormalizedEvent {
  return {
    eventId: `l-${++n}`,
    kind: "link",
    sessionId,
    cli,
    skill: null,
    stage: null,
    requirementId: reqId,
    title: null,
    projectId,
    occurredAt: at,
    receivedAt: at,
    seq: null,
    evidenceLevel: "verified",
    source: "gui-card",
  };
}

/** GUI 解除关联事件工厂 */
export function mkUnlink(sessionId: string, at: string): NormalizedEvent {
  return {
    eventId: `u-${++n}`,
    kind: "unlink",
    sessionId,
    cli: null,
    skill: null,
    stage: null,
    requirementId: null,
    title: null,
    projectId: null,
    occurredAt: at,
    receivedAt: at,
    seq: null,
    evidenceLevel: "verified",
    source: "gui",
  };
}

/** 手动建卡事件工厂（确定性 requirementId/title/projectId，spec #15 A 节） */
export function mkCreate(
  reqId: string,
  projectId: string,
  at: string,
  title = "待命名需求",
  eventId?: string,
): NormalizedEvent {
  return {
    eventId: eventId ?? `c-${++n}`,
    kind: "create",
    sessionId: null,
    cli: null,
    skill: null,
    stage: null,
    requirementId: reqId,
    title,
    projectId,
    occurredAt: at,
    receivedAt: at,
    seq: null,
    evidenceLevel: "verified",
    source: "gui-create",
  };
}

/** 标题编辑事件工厂（requirementId+title，经事件流持久化重放） */
export function mkRename(reqId: string, title: string, at: string): NormalizedEvent {
  return {
    eventId: `r-${++n}`,
    kind: "rename",
    sessionId: null,
    cli: null,
    skill: null,
    stage: null,
    requirementId: reqId,
    title,
    projectId: null,
    occurredAt: at,
    receivedAt: at,
    seq: null,
    evidenceLevel: "verified",
    source: "gui-rename",
  };
}

/** 删除需求（墓碑）事件工厂 */
export function mkDelete(reqId: string, at: string): NormalizedEvent {
  return {
    eventId: `d-${++n}`,
    kind: "delete",
    sessionId: null,
    cli: null,
    skill: null,
    stage: null,
    requirementId: reqId,
    title: null,
    projectId: null,
    occurredAt: at,
    receivedAt: at,
    seq: null,
    evidenceLevel: "verified",
    source: "gui-delete",
  };
}

// 与 apps/desktop db.ts 相同的 node:sqlite 入口回退（新名 Database 优先，回退 DatabaseSync，见 decisions.md D2）
const exportsRecord = nodeSqlite as unknown as Record<string, unknown>;
const DatabaseCtor = (typeof exportsRecord.Database === "function"
  ? exportsRecord.Database
  : nodeSqlite.DatabaseSync) as new (path: string) => nodeSqlite.DatabaseSync;

/** 测试用 SQLite 连接（临时文件/内存库） */
export function openTestDb(path: string): nodeSqlite.DatabaseSync {
  return new DatabaseCtor(path);
}
