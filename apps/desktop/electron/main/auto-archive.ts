// 用途：自动归档引擎（#64 spec #57）—— 判定为纯函数（会话集合 + 配置 + 当前时间 → 待归档 id 列表，便于密封测试）+ 执行器（逐条容错 allSettled 全部尝试，参照退出序列范式；归档编排经 session-lifecycle 唯一写者（#70 C2），与 session:archive 通道共用同一实例，不另起平行实现）+ 扫描摘要（设置区反馈数据源）
import { activityBasisMs, type AutoArchiveConfig, type AutoArchiveScanSummary, type SessionStatus } from "@kanban/ipc-schema";
import type { LogFn } from "./logger";
import type { PtyHost } from "./pty-host";
import type { SessionLifecycle } from "./session-lifecycle";
import { isSessionBusy, isStructuredProcessAlive, type SessionStore } from "./session-store";

/** 判定输入行：store 全量记录的判定面投影（processAlive 由执行器按 kind 计算，判定本身不依赖宿主） */
export interface AutoArchiveCandidate {
  id: string;
  kind: "structured" | "pty";
  status: SessionStatus | null;
  lastActiveAt: string | null;
  createdAt: string | null;
  archivedAt: string | null;
  /** 底层进程存活（PTY=宿主 isRunning；结构化=本运行内句柄仍在即 status≠disconnected）——正开着的空闲终端亦为 true */
  processAlive: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 判定纯函数（spec #57 D 节）：默认关恒空；跳过 已归档 / 运行中 / 等待审批 / 底层进程存活；
 * 超期基准 COALESCE(last_active_at, created_at)，距基准满 N 天（含整点）即待归档；基准不可解析保守跳过
 */
export function selectAutoArchiveIds(
  sessions: readonly AutoArchiveCandidate[],
  config: AutoArchiveConfig,
  now: Date,
): string[] {
  if (!config.enabled) return [];
  const cutoffMs = config.days * DAY_MS;
  const ids: string[] = [];
  for (const s of sessions) {
    if (s.archivedAt != null) continue;
    if (isSessionBusy(s.status)) continue;
    if (s.processAlive) continue;
    const basis = activityBasisMs(s.lastActiveAt, s.createdAt);
    if (basis === null) continue; // 基准不可解析保守跳过（单源 activityBasisMs，#86 启动自动选中同口径）
    if (now.getTime() - basis >= cutoffMs) ids.push(s.id);
  }
  return ids;
}

/** 执行器依赖（#70 C2 起归档编排走 session-lifecycle 唯一写者）：判定所需会话集合与 PTY 存活探测读数据面，终止在 lifecycle.archive 内经 SessionProcesses 分派 */
export interface AutoArchiveEngineDeps {
  sessions: SessionStore;
  /** PTY 存活探测（判定用，权威：DB 状态可能滞后） */
  pty: Pick<PtyHost, "isRunning">;
  /** 单会话归档编排（与 session:archive 通道共用同一 lifecycle 实例） */
  lifecycle: Pick<SessionLifecycle, "archive">;
  log?: LogFn;
}

/**
 * 执行一次扫描（触发点 = 应用启动后 + 配置保存成功后，均由 index.ts 调用，无常驻定时器）：
 * 默认关零动作（不读库、老数据不动）；判定 → 逐条归档（allSettled 单条失败不影响其余，失败记 error 日志）
 * → 命中时记完成摘要日志；引擎自身不抛错（意外异常记 error 返回零摘要，不打断启动/保存链路）
 */
export async function runAutoArchiveScan(
  deps: AutoArchiveEngineDeps,
  config: AutoArchiveConfig,
  now: Date = new Date(),
): Promise<AutoArchiveScanSummary> {
  if (!config.enabled) return { archived: 0, failed: 0 };
  try {
    const candidates: AutoArchiveCandidate[] = deps.sessions.listAll().map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status ?? null,
      lastActiveAt: r.lastActiveAt,
      createdAt: r.createdAt ?? null,
      archivedAt: r.archivedAt,
      // 底层进程存活判定（arch C11 谓词单点）：PTY 用宿主 isRunning（权威，DB 状态可能滞后）；结构化以 DB 状态投影（isStructuredProcessAlive：disconnected=进程不在，其余=本运行内句柄仍在=使用中）
      processAlive: r.kind === "pty" ? deps.pty.isRunning(r.id) : isStructuredProcessAlive(r.status),
    }));
    const targets = selectAutoArchiveIds(candidates, config, now);
    // 逐条容错（参照退出序列 allSettled 范式）：busy/存活已被判定排除，无需 interrupt 后的有限等待
    const results = await Promise.allSettled(targets.map((id) => deps.lifecycle.archive(id)));
    let archived = 0;
    let failed = 0;
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        archived += 1;
      } else {
        failed += 1;
        deps.log?.("error", "auto-archive", `归档失败（其余继续）：${targets[i]} ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      }
    });
    if (targets.length > 0) {
      deps.log?.("info", "auto-archive", `自动归档扫描完成：命中 ${targets.length} 条，归档 ${archived} 条，失败 ${failed} 条`);
    }
    return { archived, failed };
  } catch (err) {
    // 意外异常（如 DB 读失败）：不抛错（触发点在启动/保存链路上），记 error 返回零摘要
    deps.log?.("error", "auto-archive", `自动归档扫描异常：${err instanceof Error ? err.message : String(err)}`);
    return { archived: 0, failed: 0 };
  }
}
