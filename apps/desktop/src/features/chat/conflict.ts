// 用途：主仓库并行会话冲突判据（spec I-4/#13 一致项 4）—— 当前会话属主仓库且同目录活跃（running/waiting）结构化会话 ≥2 时返回会话名列表；worktree/断开/空闲/PTY 不计入
import type { SessionView } from "./chat-store";

/** cwd 归一化比较键：小写 + 正斜杠 + 去尾部分隔符（同项目会话 cwd 来自同一 canonicalPath，防大小写/分隔符形态差异漏判） */
export function normalizeCwdKey(cwd: string): string {
  return cwd.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 冲突提示条判据（纯函数）：
 * - 当前会话须为结构化会话且目录身份 = 主仓库（dirIdentity=main）；
 * - 同 canonical cwd 下主仓库活跃（running/waiting）结构化会话 ≥2；
 * - 返回这些会话的标题列表（含当前会话自身），否则 null（不渲染提示条）。
 * 仅提示不阻止；会话数变化经 store 快照自然重算（动态更新）。
 */
export function detectMainRepoConflict(sessions: SessionView[], activeId: string | null): string[] | null {
  const current = sessions.find((s) => s.sessionId === activeId);
  if (!current || current.cli === "pty" || current.dirIdentity !== "main" || !current.cwd) return null;
  const key = normalizeCwdKey(current.cwd);
  const group = sessions.filter(
    (s) =>
      s.cli !== "pty" &&
      s.dirIdentity === "main" &&
      !!s.cwd &&
      normalizeCwdKey(s.cwd) === key &&
      (s.status === "running" || s.status === "waiting"),
  );
  return group.length >= 2 ? group.map((s) => s.title) : null;
}
