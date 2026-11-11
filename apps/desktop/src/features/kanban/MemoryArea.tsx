// 用途：详情面板「需求经验」区（#33，spec #27 I 节原型一致项 3–7 / 原型演示 ②③）—— 提取按钮（零 structured 关联会话禁用 + tooltip；进行中替换为四步进度 + 段 i/n + 取消）/ 批次卡（元信息 + 缺失警示 + failed 重试 + cancelled 灰显）/ proposed 提示条与对比弹层 / 候选列表（跨批次待审累计 + 已处置按批次折叠 + 冲突提示 + 三动作 + 去编辑）/ 候选编辑弹层；数据与动作经 use-requirement-memory controller 注入
import { useState } from "react";
import type { MemoryBatchRow, MemoryCandidateRow, MemoryResult, MemorySummaryChoice, RequirementCardRow } from "@kanban/ipc-schema";
import { sessionCliLabel } from "../../lib/cli-catalog";
import { CandidateEditDialog } from "./CandidateEditDialog";
import { SummaryCompareDialog } from "./SummaryCompareDialog";
import type { RequirementMemoryController } from "./use-requirement-memory";

/** MemoryArea 所需的会话视图投影（结构化会话数判定 + 溯源 cli 标注） */
export interface MemorySessionRef {
  sessionId: string;
  cli: string;
  title: string;
}

export interface MemoryAreaProps {
  /** 当前需求行（sessions = 已关联会话 id） */
  card: RequirementCardRow;
  /** 记忆控制器（use-requirement-memory；缺省保持占位形态——挂点在无上下文时不半渲染） */
  memory?: RequirementMemoryController | null;
  /** 会话视图（缺省空：structured 判定降级为关联数>0，后端业务拒绝兜底） */
  sessions?: MemorySessionRef[];
}

/** 会话/批次标识短显示（uuid 等长 id 截断展示，完整值放 title） */
export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/** ISO 时间 → MM-DD HH:mm（不可解析原样返回；批次状态时间用） */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mmdd = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${mmdd} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 四步进度键序（事件 step 词表一致：reading → chunking → extracting → merging） */
const STEP_KEYS = ["reading", "chunking", "extracting", "merging"] as const;
type StepKey = (typeof STEP_KEYS)[number];

const STEP_TITLES: Record<StepKey, string> = {
  reading: "读取关联会话历史",
  chunking: "分段",
  extracting: "逐段提取",
  merging: "合并写库",
};

/** 批次状态徽标文案 */
const BATCH_STATUS_LABELS: Record<MemoryBatchRow["status"], string> = {
  running: "提取中",
  completed: "完成",
  failed: "失败",
  cancelled: "已取消",
};

/** 候选状态徽标文案 */
const CANDIDATE_STATUS_LABELS: Record<MemoryCandidateRow["status"], string> = {
  pending: "待审核",
  accepted: "已接受",
  edited: "已编辑",
  ignored: "已忽略",
};

/** 候选状态徽标配色（对齐原型 st-chip：接受=ok 绿 / 已编辑=primary / 忽略=灰 / 待审=warn） */
const CANDIDATE_CHIP_CLS: Record<MemoryCandidateRow["status"], string> = {
  pending: "border-warn/40 text-warn",
  accepted: "border-ok/40 text-ok",
  edited: "border-primary/40 text-primary",
  ignored: "border-border text-fg-faint",
};

/** 业务拒绝 → 展示文案（detail 为 Main 侧中文可读补充） */
function rejectText(r: MemoryResult): string {
  return !r.ok ? r.detail ?? r.reason : "";
}

export function MemoryArea({ card, memory, sessions = [] }: MemoryAreaProps) {
  // 最近一次动作的业务拒绝文案（提取/取消/审核/处置共用，直达呈现）
  const [actionError, setActionError] = useState<string | null>(null);
  // 候选编辑弹层（pending=编辑后接受 / knowledge=已接受知识去编辑）
  const [editing, setEditing] = useState<{ mode: "pending" | "knowledge"; candidate: MemoryCandidateRow } | null>(null);
  // 总结对比弹层开合
  const [comparing, setComparing] = useState(false);
  // 已处置批次折叠态（默认全收起；Record<batchId, true>=展开）
  const [disposedOpen, setDisposedOpen] = useState<Record<string, boolean>>({});

  if (!memory) {
    // 无控制器上下文（transport 未接 memory 通道 / 面板占位形态）
    return (
      <section data-testid="memory-area" className="flex flex-col gap-2">
        <h5 className="text-[11px] tracking-wide text-muted-foreground">需求经验</h5>
        <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-fg-faint">
          需求经验提取与知识候选审核即将提供
        </p>
      </section>
    );
  }

  const data = memory.data;
  const progress = memory.progress;
  const runningBatch = data?.batches.find((b) => b.status === "running") ?? null;

  // structured 关联会话数：PTY 终端不参与提取（US2）；会话视图缺失时降级按关联数>0（后端 no-sessions 拒绝兜底）
  const structuredCount = card.sessions.filter((id) => {
    const s = sessions.find((x) => x.sessionId === id);
    return s ? s.cli !== "pty" : sessions.length === 0;
  }).length;
  const noStructuredSessions = card.sessions.length === 0 || (sessions.length > 0 && structuredCount === 0);

  /** 动作包装：业务拒绝文案直达呈现（成功清除） */
  const runAction = async (p: Promise<MemoryResult>): Promise<string | null> => {
    const r = await p;
    const text = rejectText(r);
    setActionError(text || null);
    return text || null;
  };

  const triggerExtract = (): void => {
    void runAction(memory.extract());
  };

  // 四步状态：当前步 run、此前 done、此后 todo（step=null 全 todo——已启动待首个进度事件）
  const stepIndex = progress?.step ? STEP_KEYS.indexOf(progress.step) : -1;
  const stepLabel = (key: StepKey): string => {
    if (key === "reading" && runningBatch && runningBatch.sourceSessionCount > 0) {
      return `${STEP_TITLES.reading}（${runningBatch.sourceSessionCount} 会话）`;
    }
    if (key === "chunking" && progress && progress.chunkCount > 0) {
      return `${STEP_TITLES.chunking}（${progress.chunkCount} 段）`;
    }
    if (key === "extracting" && progress && progress.chunkCount > 0) {
      return `${STEP_TITLES.extracting}（${Math.min(progress.chunkIndex + 1, progress.chunkCount)}/${progress.chunkCount}）`;
    }
    return STEP_TITLES[key];
  };

  // 候选分区：待审核（跨批次累计）/ 已处置（终态，按批次折叠）
  const pendingCandidates = data?.candidates.filter((c) => c.status === "pending") ?? [];
  const disposedCandidates = data?.candidates.filter((c) => c.status !== "pending") ?? [];
  const disposedGroups = (data?.batches ?? [])
    .map((b) => ({ batchId: b.id, items: disposedCandidates.filter((c) => c.batchId === b.id) }))
    .filter((g) => g.items.length > 0);
  /** 批次候选计数（批次卡元信息「候选 N 条（待审 M）」） */
  const batchCandidateStat = (batchId: string): { total: number; pending: number } => {
    const all = data?.candidates.filter((c) => c.batchId === batchId) ?? [];
    return { total: all.length, pending: all.filter((c) => c.status === "pending").length };
  };

  const summary = data?.summary ?? null;
  const hasProposed = summary != null && summary.proposedBatchId != null;

  /** proposed 二选一（提示条与对比弹层共用） */
  const resolveProposed = (choice: MemorySummaryChoice): void => {
    setComparing(false);
    void runAction(memory.resolveSummary(choice));
  };

  return (
    <section data-testid="memory-area" className="flex flex-col gap-2">
      <h5 className="text-[11px] tracking-wide text-muted-foreground">需求经验</h5>
      {/* 提取按钮（US1 手动触发；零 structured 关联会话禁用 + tooltip；进行中被四步进度替换） */}
      {runningBatch ? (
        <div data-testid="memory-extract-progress" className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1">
              批次 {shortId(progress?.batchId ?? runningBatch.id)} · 提取中（真实模型调用，分钟级）
            </span>
            <button
              type="button"
              data-testid="memory-cancel-button"
              title="取消并整批丢弃（不产出半成品候选）"
              className="flex-none rounded-md border border-border px-2.5 py-0.5 text-xs hover:border-primary hover:text-foreground"
              onClick={() => void runAction(memory.cancel())}
            >
              取消
            </button>
          </div>
          <div className="flex flex-col gap-1">
            {STEP_KEYS.map((key, ix) => {
              const state = stepIndex < 0 ? "todo" : ix < stepIndex ? "done" : ix === stepIndex ? "run" : "todo";
              return (
                <div key={key} data-testid={`memory-step-${key}`} data-state={state} className={state === "todo" ? "text-fg-faint" : ""}>
                  <span aria-hidden className="mr-1.5 inline-block w-3 text-center">
                    {state === "done" ? "✓" : state === "run" ? "◐" : "○"}
                  </span>
                  {stepLabel(key)}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-testid="memory-extract-button"
          disabled={noStructuredSessions}
          title={
            noStructuredSessions
              ? "该需求没有关联的结构化会话（PTY 终端不参与提取），先在看板关联会话"
              : "读取当前关联的结构化会话历史，提取需求经验（手动触发）"
          }
          className="self-start rounded-md border border-primary bg-primary/15 px-3.5 py-1.5 text-[13px] text-foreground hover:bg-primary/25 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={triggerExtract}
        >
          ⚡ 提取需求经验
        </button>
      )}

      {/* 批次卡（最新在前；running 批次由上方进度区呈现不重复出卡） */}
      {(data?.batches ?? [])
        .filter((b) => b.status !== "running")
        .slice()
        .reverse()
        .map((b) => {
          const stat = batchCandidateStat(b.id);
          const time = b.finishedAt ?? b.createdAt;
          return (
            <article
              key={b.id}
              data-testid="memory-batch-card"
              data-batch-id={b.id}
              data-status={b.status}
              className={`flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-xs ${
                b.status === "failed" ? "border-destructive/40" : b.status === "cancelled" ? "border-border opacity-55" : "border-border"
              }`}
            >
              <div className="flex items-center gap-2">
                <b title={b.id}>批次 {shortId(b.id)}</b>
                <span className="text-fg-faint">{formatTime(time)}</span>
                <span
                  className={`rounded-full border px-2 py-px text-[11px] ${
                    b.status === "failed"
                      ? "border-destructive/40 text-destructive"
                      : b.status === "completed"
                        ? "border-ok/40 text-ok"
                        : "border-border text-fg-faint"
                  }`}
                >
                  {BATCH_STATUS_LABELS[b.status]}
                </span>
              </div>
              <div data-testid="memory-batch-meta" className="text-fg-faint">
                来源 {b.sourceSessionCount} 会话 · 缺失 {b.missingSessions.length} · 分段 {b.chunkCount} · 模型调用 {b.modelCallCount} 次
                {b.status === "completed" ? ` · 候选 ${stat.total} 条（待审 ${stat.pending}）` : ""}
              </div>
              {/* 缺失会话警示条：列会话与原因，声明不覆盖（US3 不冒充完整） */}
              {b.missingSessions.length > 0 ? (
                <div data-testid="memory-missing-sessions" className="rounded-md border-l-[3px] border-warn bg-warn/10 px-2.5 py-1 text-warn">
                  ⚠ 缺失 {b.missingSessions.length} 个会话：
                  {b.missingSessions
                    .map((m) => `Session ${shortId(m.sessionId)}（${sessionCliLabel(m.cli)} · ${m.reason}）`)
                    .join("、")}
                  ——本次分析不覆盖其内容
                </div>
              ) : null}
              {/* failed：失败原因 + 重试（新批次） */}
              {b.status === "failed" ? (
                <>
                  <div data-testid="memory-batch-error" className="rounded-md border-l-[3px] border-destructive bg-destructive/10 px-2.5 py-1 text-destructive">
                    ✗ 失败原因：{b.error ?? "未知"}——本批次已整批丢弃，未产生候选
                  </div>
                  <button
                    type="button"
                    data-testid="memory-retry-button"
                    className="self-start rounded-md border border-primary bg-primary/15 px-2.5 py-0.5 text-xs text-foreground hover:bg-primary/25"
                    onClick={triggerExtract}
                  >
                    重试（新批次）
                  </button>
                </>
              ) : null}
            </article>
          );
        })}

      {/* proposed 提示条（US14：人工编辑过的总结不被覆盖，新版暂存待二选一） */}
      {hasProposed ? (
        <div data-testid="memory-proposed-bar" className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">📝 检测到人工编辑过的总结，新版已暂存（批次 {shortId(summary!.proposedBatchId!)}）</span>
          <button
            type="button"
            data-testid="memory-compare-button"
            className="rounded-md border border-border px-2.5 py-0.5 hover:border-primary hover:text-foreground"
            onClick={() => setComparing(true)}
          >
            对比查看
          </button>
          <button
            type="button"
            data-testid="memory-accept-new"
            className="rounded-md border border-primary bg-primary/15 px-2.5 py-0.5 text-foreground hover:bg-primary/25"
            onClick={() => resolveProposed("accept-new")}
          >
            采纳新版
          </button>
          <button
            type="button"
            data-testid="memory-keep-human"
            className="rounded-md border border-border px-2.5 py-0.5 hover:border-primary hover:text-foreground"
            onClick={() => resolveProposed("keep-human")}
          >
            保留人工版
          </button>
        </div>
      ) : null}

      {/* 候选列表（US15–18）：待审核跨批次累计 + 已处置按批次折叠 */}
      <div data-testid="memory-candidates" className="flex flex-col gap-2">
        <h6 className="text-[11px] tracking-wide text-muted-foreground">
          知识候选 · 待审核 {pendingCandidates.length}（跨批次累计）｜已处置 {disposedCandidates.length}（按批次折叠）
        </h6>
        {pendingCandidates.map((c) => (
          <article
            key={c.id}
            data-testid="memory-candidate"
            data-candidate-id={c.id}
            data-status={c.status}
            className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2.5"
          >
            <p data-testid="memory-candidate-claim" className="text-[13px]">
              {c.claim}
            </p>
            {c.evidence ? (
              <blockquote data-testid="memory-candidate-evidence" className="border-l-2 border-border pl-2 text-[11px] text-fg-faint">
                「{c.evidence}」
              </blockquote>
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-fg-faint">
              <span data-testid="memory-candidate-batch" title={c.batchId} className="rounded-full border border-border px-2 py-px text-muted-foreground">
                批次 {shortId(c.batchId)}
              </span>
              {c.scope ? (
                <span className="rounded-full border border-primary/40 px-2 py-px text-primary">适用范围：{c.scope}</span>
              ) : null}
              <span>来源 {c.sourceSessionIds.length} 会话</span>
              <span className={`rounded-full border px-2 py-px ${CANDIDATE_CHIP_CLS[c.status]}`}>{CANDIDATE_STATUS_LABELS[c.status]}</span>
            </div>
            {/* 冲突提示（US17）：相似度 + 对方编号 + 并存不替换声明；仅提示不阻断 */}
            {c.conflicts.map((k, i) => (
              <p key={`${k.displayNo}-${i}`} data-testid="memory-conflict-note" className="rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-1 text-xs text-warn">
                ⚠ 与已接受知识 {k.displayNo} 相似度 {k.similarity.toFixed(2)} —— 接受将以并存落库（带冲突标注），不会替换已有知识
              </p>
            ))}
            {c.notes.map((k, i) => (
              <p key={`${k.displayNo}-${i}`} data-testid="memory-note-ignored" className="rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-1 text-xs text-warn">
                ⚠ 与已忽略知识 {k.displayNo} 相似度 {k.similarity.toFixed(2)} —— 可能是被纠正的旧知识，请复核后再决定
              </p>
            ))}
            <div className="flex gap-2">
              <button
                type="button"
                data-testid="memory-accept-candidate"
                title="以并存落库（不替换相似知识）"
                className="rounded-md border border-primary bg-primary/15 px-2.5 py-0.5 text-xs text-foreground hover:bg-primary/25"
                onClick={() => void runAction(memory.reviewCandidate(c.id, "accept"))}
              >
                接受（并存）
              </button>
              <button
                type="button"
                data-testid="memory-edit-candidate"
                title="编辑 claim 与适用范围后接受（溯源只读）"
                className="rounded-md border border-border px-2.5 py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-foreground"
                onClick={() => setEditing({ mode: "pending", candidate: c })}
              >
                编辑后接受
              </button>
              <button
                type="button"
                data-testid="memory-ignore-candidate"
                className="rounded-md border border-border px-2.5 py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-foreground"
                onClick={() => void runAction(memory.reviewCandidate(c.id, "ignore"))}
              >
                忽略
              </button>
            </div>
          </article>
        ))}
        {/* 已处置候选按批次折叠（终态不可再流转；accepted/edited 知识给「去编辑」入口） */}
        {disposedGroups.map((g) => {
          const open = disposedOpen[g.batchId] === true;
          const counts = {
            accepted: g.items.filter((c) => c.status === "accepted").length,
            edited: g.items.filter((c) => c.status === "edited").length,
            ignored: g.items.filter((c) => c.status === "ignored").length,
          };
          return (
            <div key={g.batchId} data-testid="memory-disposed-group" data-batch-id={g.batchId} className="flex flex-col gap-1.5">
              <button
                type="button"
                data-testid="memory-disposed-toggle"
                className="self-start rounded-md border border-border px-2.5 py-0.5 text-[11px] text-muted-foreground hover:border-primary hover:text-foreground"
                onClick={() => setDisposedOpen((m) => ({ ...m, [g.batchId]: !open }))}
              >
                {open ? "收起" : "展开"}：批次 {shortId(g.batchId)} · {g.items.length} 条（已接受 {counts.accepted} · 已编辑 {counts.edited} · 已忽略 {counts.ignored}）
              </button>
              {open
                ? g.items.map((c) => (
                    <div
                      key={c.id}
                      data-testid="memory-disposed-candidate"
                      data-candidate-id={c.id}
                      data-status={c.status}
                      className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs opacity-75"
                    >
                      <span className="min-w-0 flex-1">{c.editedClaim ?? c.claim}</span>
                      {c.editedScope ?? c.scope ? (
                        <span className="rounded-full border border-primary/40 px-2 py-px text-[11px] text-primary">
                          适用范围：{c.editedScope ?? c.scope}
                        </span>
                      ) : null}
                      <span className={`rounded-full border px-2 py-px text-[11px] ${CANDIDATE_CHIP_CLS[c.status]}`}>
                        {CANDIDATE_STATUS_LABELS[c.status]}
                      </span>
                      {c.status === "accepted" || c.status === "edited" ? (
                        <button
                          type="button"
                          data-testid="memory-go-edit"
                          title="编辑已入库知识（claim/适用范围，溯源只读）"
                          className="rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary hover:text-foreground"
                          onClick={() => setEditing({ mode: "knowledge", candidate: c })}
                        >
                          去编辑
                        </button>
                      ) : null}
                    </div>
                  ))
                : null}
            </div>
          );
        })}
      </div>

      {/* 动作业务拒绝直达呈现（extraction-running/candidate-final/no-proposed 等） */}
      {actionError ? (
        <p data-testid="memory-action-error" className="rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[11px] text-warn">
          ⚠ {actionError}
        </p>
      ) : null}

      {/* 候选编辑弹层（pending 编辑后接受 / 终态知识去编辑，走 reviewCandidate edit / editAccepted） */}
      {editing ? (
        <CandidateEditDialog
          candidate={editing.candidate}
          mode={editing.mode}
          sessions={sessions}
          onClose={() => setEditing(null)}
          onSave={
            editing.mode === "pending"
              ? (edit) => runAction(memory.reviewCandidate(editing.candidate.id, "edit", edit))
              : (edit) => runAction(memory.editAccepted(editing.candidate.id, edit))
          }
        />
      ) : null}

      {/* 总结对比弹层（两栏并排只读 + 二选一） */}
      {comparing && hasProposed ? (
        <SummaryCompareDialog
          batchLabel={shortId(summary!.proposedBatchId!)}
          humanContent={summary!.content ?? "（人工版正文不可读）"}
          newContent={summary!.proposedContent ?? "（新版正文不可读）"}
          onClose={() => setComparing(false)}
          onResolve={resolveProposed}
        />
      ) : null}
    </section>
  );
}
