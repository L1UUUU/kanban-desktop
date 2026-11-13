// 用途：会话活跃时间基准单源 —— COALESCE(lastActiveAt, createdAt) 的 ISO 毫秒时间戳（#64 自动归档与 #86 启动自动选中共用同一规则定义，防两处口径漂移）
/** 活跃基准：lastActiveAt 优先、缺省回落 createdAt；两者皆缺或不可解析返回 null（调用方保守跳过，与 selectAutoArchiveIds 同口径） */
export function activityBasisMs(lastActiveAt: string | null, createdAt: string | null): number | null {
  const basis = Date.parse(lastActiveAt ?? createdAt ?? "");
  return Number.isNaN(basis) ? null : basis;
}
