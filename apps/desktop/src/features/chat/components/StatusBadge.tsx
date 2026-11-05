// 用途：会话活动状态徽标 —— 五状态文案与配色（原型 §3.4 硬约束）
import type { SessionStatus } from "@kanban/ipc-schema";

const STATUS_META: Record<SessionStatus, { label: string; cls: string }> = {
  idle: { label: "空闲", cls: "border-border text-muted-foreground" },
  running: { label: "运行中", cls: "border-ok/40 text-ok" },
  waiting: { label: "等待审批", cls: "border-warn/50 text-warn" },
  interrupted: { label: "已中断", cls: "border-destructive/50 text-destructive" },
  disconnected: { label: "已断开", cls: "border-transparent text-fg-faint" },
};

export function StatusBadge({ status }: { status: SessionStatus }) {
  const meta = STATUS_META[status];
  return <span className={`rounded-full border px-[7px] py-px text-[11px] ${meta.cls}`}>{meta.label}</span>;
}
