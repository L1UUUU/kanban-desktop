// 用途：残留进程通知条（#49 spec #40 F/G 节 + 原型 d4 必须一致项）—— 警示色顶部条（检测计数 + 确认提示）+ 进程表（勾选/PID/进程路径/启动时间/关联会话记录）+「清理选中」（逐 pid killed/failed 回报）+「忽略本次」；默认勾选仅精确匹配的 sessionTitle，「无会话记录」与「疑似上次会话」回落均不勾（防误杀），全程确认式无自动清理
import { useState } from "react";
import type { ResidueKillResult, ResidueProcess } from "@kanban/ipc-schema";

/** 启动时间显示（ISO → 本地 YYYY-MM-DD HH:mm；缺失显示 —） */
function formatStartedAt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 默认勾选集合：仅精确匹配（sessionTitle 非空）的进程；「无会话记录」与「疑似上次会话」回落（suspectedSessionTitle）均不勾（可能是用户自己打开的，防误杀，P2） */
function defaultChecked(processes: ResidueProcess[]): Set<number> {
  return new Set(processes.filter((p) => p.sessionTitle != null).map((p) => p.pid));
}

/** 通知条局部状态（gen=清单引用：新一轮检测结果时整体重置——render 期调整，React 官方模式） */
interface BannerState {
  gen: ResidueProcess[];
  killedPids: number[];
  failures: Map<number, string>;
  checked: Set<number>;
}

export function ResidueBanner({
  processes,
  onKill,
  onDismiss,
}: {
  /** Main 检测出的残留清单（app:event 推送或 residue:detect 拉取；空/undefined 不渲染） */
  processes: ResidueProcess[];
  /** 确认式清理（residue:kill）：逐 pid 终止结果回报 */
  onKill: (pids: number[]) => Promise<ResidueKillResult[]>;
  /** 忽略本次（条消失，下次启动重新检测） */
  onDismiss: () => void;
}) {
  const [state, setState] = useState<BannerState>({ gen: processes, killedPids: [], failures: new Map(), checked: defaultChecked(processes) });
  // 清单引用变化（新一轮检测推送）→ render 期整体重置（清理进度/失败原因/勾选回默认）
  if (state.gen !== processes) {
    setState({ gen: processes, killedPids: [], failures: new Map(), checked: defaultChecked(processes) });
  }
  const [busy, setBusy] = useState(false);
  const rows = processes.filter((p) => !state.killedPids.includes(p.pid));

  if (rows.length === 0) return null;

  const toggle = (pid: number): void => {
    setState((prev) => {
      const checked = new Set(prev.checked);
      if (checked.has(pid)) checked.delete(pid);
      else checked.add(pid);
      return { ...prev, checked };
    });
  };

  const cleanSelected = async (): Promise<void> => {
    const pids = [...state.checked];
    if (pids.length === 0 || busy) return;
    setBusy(true);
    try {
      const results = await onKill(pids);
      const killed = results.filter((r) => r.status === "killed").map((r) => r.pid);
      const failed = new Map(results.filter((r) => r.status === "failed").map((r) => [r.pid, r.error ?? "终止失败"]));
      setState((prev) => ({ ...prev, killedPids: [...prev.killedPids, ...killed], failures: failed }));
      // 全部清理完成（本轮 + 此前累计 killed 覆盖全部进程）：条消失
      const remaining = processes.filter((p) => !killed.includes(p.pid) && !state.killedPids.includes(p.pid));
      if (remaining.length === 0) onDismiss();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-none border-b border-warn/40 bg-warn/10" data-testid="residue-banner">
      <div className="flex items-center gap-3 px-4 py-1.5 text-xs text-warn">
        <span className="min-w-0">
          🧹 检测到 {rows.length} 个疑似残留 CLI 进程（不属于本应用管理）。清理前请确认它们不是你自己打开的。
        </span>
        <span className="ml-auto flex flex-none gap-2">
          <button
            type="button"
            className="rounded-md border border-destructive/60 px-3 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:cursor-default disabled:opacity-50"
            disabled={state.checked.size === 0 || busy}
            onClick={() => void cleanSelected()}
          >
            清理选中
          </button>
          <button
            type="button"
            className="rounded-md border border-warn/60 px-3 py-1 text-xs text-warn hover:bg-warn/20"
            onClick={onDismiss}
          >
            忽略本次
          </button>
        </span>
      </div>
      <div className="overflow-x-auto px-4 pb-2">
        <table className="w-full border-collapse font-mono text-xs" data-testid="residue-table">
          <thead>
            <tr className="text-left text-fg-faint">
              <th className="py-1 pr-3 font-normal" />
              <th className="py-1 pr-3 font-normal">PID</th>
              <th className="py-1 pr-3 font-normal">进程</th>
              <th className="py-1 pr-3 font-normal">启动时间</th>
              <th className="py-1 font-normal">关联记录</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.pid} className="border-t border-warn/20 text-fg-muted" data-testid={`residue-row-${p.pid}`}>
                <td className="py-1 pr-3">
                  <input
                    type="checkbox"
                    aria-label={`勾选 PID ${p.pid}`}
                    checked={state.checked.has(p.pid)}
                    onChange={() => toggle(p.pid)}
                  />
                </td>
                <td className="py-1 pr-3">{p.pid}</td>
                <td className="max-w-[360px] truncate py-1 pr-3" title={p.exePath}>
                  {p.exePath}
                </td>
                <td className="py-1 pr-3">{formatStartedAt(p.startedAt)}</td>
                <td className="py-1">
                  {p.sessionTitle
                    ? `会话「${p.sessionTitle}」（上次运行遗留）`
                    : p.suspectedSessionTitle
                      ? `疑似上次会话「${p.suspectedSessionTitle}」（非精确匹配，默认不勾选）`
                      : "无会话记录（可能是你手动打开的）"}
                  {state.failures.has(p.pid) ? <span className="ml-2 text-destructive">终止失败：{state.failures.get(p.pid)}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
