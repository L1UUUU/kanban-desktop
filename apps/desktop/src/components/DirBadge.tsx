// 用途：目录身份徽标（spec I-3 / 原型一致项 3）—— 主仓库绿 / worktree: xxx 蓝，tooltip 说明工作目录；none 不渲染
export interface DirBadgeProps {
  identity: "main" | "worktree" | "none";
  worktreeName?: string | null;
  cwd?: string | null;
}

export function DirBadge({ identity, worktreeName, cwd }: DirBadgeProps) {
  if (identity === "none") return null;
  if (identity === "main") {
    return (
      <span
        title={`工作在主仓库（${cwd ?? ""}）`}
        className="flex-none rounded px-1.5 py-px text-[11px] text-ok"
      >
        主仓库
      </span>
    );
  }
  return (
    <span
      title={`工作在独立 worktree（${cwd ?? ""}），与其他会话文件隔离`}
      className="flex-none rounded px-1.5 py-px text-[11px] text-accent2"
    >
      worktree: {worktreeName ?? "?"}
    </span>
  );
}
