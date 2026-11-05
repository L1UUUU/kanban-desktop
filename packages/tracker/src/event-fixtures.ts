// 用途：tracker 测试共享构造器 —— 固定时间轴 + 四类归一化事件工厂（演进自 poc-4 tracker.test.mjs 的 mk* 辅助与测试用 SQLite 打开器）
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
/** skill 事件工厂（eventId 缺省自增；时间/证据等级/CLI 可覆盖） */
export function mkSkill({
  sessionId = "s-a",
  cli = "claude-code",
  skill = "design-feature",
  at = T.t1,
  evidence = "verified",
  eventId,
  seq = null,
}: {
  sessionId?: string;
  cli?: "claude-code" | "codex" | "opencode";
  skill?: string;
  at?: string;
  evidence?: "verified" | "self_reported" | "simulated";
  eventId?: string;
  seq?: number | null;
} = {}): NormalizedEvent {
  return {
    eventId: eventId ?? `ev-${++n}`,
    kind: "skill",
    sessionId,
    cli,
    skill,
    stage: null,
    requirementId: null,
    occurredAt: at,
    receivedAt: at,
    seq,
    evidenceLevel: evidence,
    source: "test",
  };
}

/** 手动修正/确认事件工厂 */
export function mkManual(reqId: string, stage: string, at: string, source = "gui-manual"): NormalizedEvent {
  return {
    eventId: `m-${++n}`,
    kind: "manual",
    sessionId: null,
    cli: null,
    skill: null,
    stage,
    requirementId: reqId,
    occurredAt: at,
    receivedAt: at,
    seq: null,
    evidenceLevel: "verified",
    source,
  };
}

/** GUI 关联事件工厂 */
export function mkLink(sessionId: string, reqId: string, at: string, cli: "claude-code" | "codex" | "opencode" = "codex"): NormalizedEvent {
  return {
    eventId: `l-${++n}`,
    kind: "link",
    sessionId,
    cli,
    skill: null,
    stage: null,
    requirementId: reqId,
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
    occurredAt: at,
    receivedAt: at,
    seq: null,
    evidenceLevel: "verified",
    source: "gui",
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
