// 用途：启动自动选中候选判定（issue #86）—— 纯函数：当前项目（无=无项目）下未归档非 PTY 会话中按活跃基准取最近者；活跃基准与自动归档共用单源 activityBasisMs（COALESCE(lastActiveAt, createdAt)，全部无活跃时间自然回落为「最新创建」）
import { activityBasisMs, type SessionRow } from "@kanban/ipc-schema";

/**
 * 选出启动自动选中目标（issue #86，只选中不恢复）：排除 PTY（kind）与已归档（archivedAt，wire 默认列表恒未归档、口径守恒）；
 * 项目作用域与侧栏一致（有当前项目=该项目会话，无=无项目会话）；基准不可解析保守跳过（与 selectAutoArchiveIds 同口径）；
 * 平局取先出现者（session:list 按 created_at 倒序，先出现=更新）。无候选返回 null。
 */
export function selectStartupSessionId(sessions: readonly SessionRow[], currentProjectId: string | null): string | null {
  let bestId: string | null = null;
  let bestBasis = Number.NEGATIVE_INFINITY;
  for (const s of sessions) {
    if (s.kind !== "structured") continue;
    if (s.archivedAt != null) continue;
    if ((s.projectId ?? null) !== currentProjectId) continue;
    const basis = activityBasisMs(s.lastActiveAt, s.createdAt);
    if (basis === null) continue;
    if (basis > bestBasis) {
      bestBasis = basis;
      bestId = s.id;
    }
  }
  return bestId;
}
