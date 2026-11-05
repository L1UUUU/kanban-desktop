// 用途：审批卡片 —— 请求命令 + suggestions（规则/目录）+ 允许一次/总是允许/拒绝三键（原型一致项 5；决定即时改变后续输出）
import type { ApprovalDecision } from "@kanban/ipc-schema";
import type { PendingApproval } from "../chat-store";

export function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: PendingApproval;
  onDecide: (decision: ApprovalDecision) => void;
}) {
  return (
    <div className="mx-auto mb-3.5 max-w-[860px] rounded-[10px] border border-warn bg-[#241f14] px-3.5 py-3">
      <div className="mb-1.5 font-mono text-xs">⚙ 需要审批：{approval.command}</div>
      {approval.suggestions.length > 0 ? (
        <div className="mb-2.5 text-xs text-muted-foreground">
          建议：
          {approval.suggestions.map((s, i) => (
            <span key={s.kind + i}>
              {i > 0 ? " · " : ""}
              <b className="font-semibold text-foreground">{s.label}</b> {s.detail}
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded-md border border-ok/60 px-3 py-1 text-xs text-ok hover:bg-ok/10"
          onClick={() => onDecide("allow-once")}
        >
          允许一次
        </button>
        <button
          type="button"
          className="rounded-md border border-ok/60 px-3 py-1 text-xs text-ok hover:bg-ok/10"
          onClick={() => onDecide("allow-always")}
        >
          总是允许
        </button>
        <button
          type="button"
          className="rounded-md border border-destructive/60 px-3 py-1 text-xs text-destructive hover:bg-destructive/10"
          onClick={() => onDecide("deny")}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}
