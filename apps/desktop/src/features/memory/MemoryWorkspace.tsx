// 用途：记忆工作区（#34，spec #27 I 节原型一致项 1/2、US19–21；#38 总结编辑弹层接通保存通道）—— 当前项目分区：搜索框（占位文案声明口径）+ 已接受知识列表（claim 正文/适用范围徽标/来源会话数/状态 chip/编辑/复制路径/复制内容）+ 需求总结区（标题/更新时间/查看/编辑/复制路径）+ 无匹配/无项目空态；知识编辑弹层走 memory:editAccepted，总结编辑弹层走 memory:editSummary（I 节第 8 条）；含侧栏底部「记忆」入口按钮（与看板入口同款形态）
import { useState } from "react";
import type { MemoryCandidateRow, MemorySummaryRow } from "@kanban/ipc-schema";
import { Modal } from "../../components/Modal";
import type { MemoryController } from "./use-memory";

/** 知识有效值：编辑值优先、缺省回原值（与 store 冲突比较基准同口径） */
function effectiveValue(edited: string | null, original: string): string {
  return edited ?? original;
}

/** ISO 时间 → 本地展示「YYYY-MM-DD HH:mm」（总结行更新时间） */
function formatUpdatedAt(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/** 写剪贴板；成功返回 true（失败由调用方提示，不抛出） */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 侧栏底部「记忆」入口按钮（原型一致项 1，与 KanbanEntryButton 同款整宽形态）：◈ 记忆 + 当前项目指示（active=记忆视图态；点击在聊天/记忆间切换） */
export function MemoryEntryButton({
  active,
  projectName,
  onToggle,
}: {
  active: boolean;
  projectName: string | null;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      data-testid="memory-entry"
      title="进入当前项目的记忆视图"
      className={`mb-1 flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[13px] ${
        active ? "border-primary bg-primary/10 text-accent2" : "border-transparent text-muted-foreground hover:border-border hover:bg-muted"
      }`}
      onClick={onToggle}
    >
      <span aria-hidden>◈</span>
      <span>记忆</span>
      <span className="ml-auto truncate text-[11px] text-fg-faint">{projectName ?? "当前项目"} →</span>
    </button>
  );
}

/** 弹层小按钮样式（取消/次要动作共用） */
const DIALOG_BTN = "rounded-md border border-border px-3 py-1 text-xs text-muted-foreground hover:border-primary hover:text-primary";
/** 弹层主按钮样式（保存） */
const DIALOG_BTN_PRIMARY = "rounded-md border border-primary bg-primary/15 px-3 py-1 text-xs hover:bg-primary/25";

/**
 * 记忆工作区：按当前项目分区展示与搜索（数据源 memory:projectMemory 一次读，pending/ignored 不进）。
 * projectName 为 null（无当前项目）渲染空态引导；知识编辑/总结查看与编辑弹层渲染于本区内。
 */
export function MemoryWorkspace({ memory, projectName }: { memory: MemoryController; projectName: string | null }) {
  const knowledge = memory.knowledge;
  const summaries = memory.summaries;
  const query = memory.query.trim();
  // 搜索态下零命中分区隐藏（原型：搜索时只留命中项）；有查询且全空 → 无匹配空态
  const showKnowledge = knowledge.length > 0 || query === "";
  const showSummaries = summaries.length > 0 || query === "";
  const noMatch = query !== "" && knowledge.length === 0 && summaries.length === 0;

  // 复制反馈（「已复制路径/内容」或失败提示；下次动作覆盖）
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  // 知识编辑弹层：编辑对象 + 草稿（保存走 memory:editAccepted；保存失败保留弹层并提示）
  const [editing, setEditing] = useState<{ k: MemoryCandidateRow; claim: string; scope: string } | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  // 总结查看（只读）与编辑弹层（编辑保存走 memory:editSummary，#38；保存失败保留弹层并提示）
  const [viewing, setViewing] = useState<MemorySummaryRow | null>(null);
  const [editingSummary, setEditingSummary] = useState<{ s: MemorySummaryRow; text: string } | null>(null);
  const [summarySaving, setSummarySaving] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  /** 复制并提示（路径/内容共用） */
  const copy = (text: string, notice: string): void => {
    void copyText(text).then((ok) => setCopyNotice(ok ? notice : "复制失败（剪贴板不可用）"));
  };

  /** 打开知识编辑弹层（预填当前有效值） */
  const openEdit = (k: MemoryCandidateRow): void => {
    setEditError(null);
    setEditing({ k, claim: effectiveValue(k.editedClaim, k.claim), scope: effectiveValue(k.editedScope, k.scope) });
  };

  /** 保存知识编辑：memory:editAccepted（仅 claim/适用范围）；成功关弹层，失败保留并提示 */
  const saveEdit = (): void => {
    if (!editing || editSaving) return;
    setEditSaving(true);
    void memory.editAccepted(editing.k.id, { claim: editing.claim, scope: editing.scope }).then((err) => {
      setEditSaving(false);
      if (err) {
        setEditError(err);
        return;
      }
      setEditing(null);
    });
  };

  /** 保存总结编辑：memory:editSummary（完整正文写回并纳入防覆盖基准，#38）；成功关弹层，失败保留并提示 */
  const saveSummaryEdit = (): void => {
    if (!editingSummary || summarySaving) return;
    setSummarySaving(true);
    void memory.editSummary(editingSummary.s.requirementId, editingSummary.text).then((err) => {
      setSummarySaving(false);
      if (err) {
        setSummaryError(err);
        return;
      }
      setEditingSummary(null);
    });
  };

  return (
    <section data-testid="memory-workspace" className="relative flex min-h-0 min-w-0 flex-col bg-background">
      {projectName == null ? (
        // 无项目上下文空态（S2-18 同款引导口径）
        <p data-testid="memory-empty-project" className="flex-none border-b border-border px-6 py-2 text-xs text-muted-foreground">
          选择或注册项目后查看项目记忆
        </p>
      ) : (
        <>
          <div className="flex-none border-b border-border px-5 pb-3 pt-3.5">
            <h2 className="mb-2 text-[15px] font-semibold">{projectName} · 项目记忆</h2>
            <input
              data-testid="memory-search"
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-[13px] outline-none focus:border-primary"
              placeholder="搜索已接受知识与需求总结（标题+正文，大小写不敏感）…"
              value={memory.query}
              onChange={(e) => memory.setQuery(e.target.value)}
            />
            {copyNotice ? (
              <p data-testid="memory-copy-notice" className="mt-1.5 text-[11px] text-fg-faint">
                {copyNotice}
              </p>
            ) : null}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-4">
            {noMatch ? (
              <p data-testid="memory-empty-search" className="py-6 text-center text-xs text-fg-faint">
                没有匹配的知识或总结
              </p>
            ) : null}
            {showKnowledge ? (
              <div>
                <div className="text-[11px] tracking-wide text-fg-faint">已接受知识（{knowledge.length}）</div>
                <div className="mt-2 flex flex-col gap-2.5">
                  {knowledge.map((k) => (
                    <KnowledgeCard
                      key={k.id}
                      k={k}
                      onEdit={() => openEdit(k)}
                      onCopyPath={() => copy(k.mdPath ?? "", "已复制路径（Markdown 绝对路径）")}
                      onCopyContent={() => copy(effectiveValue(k.editedClaim, k.claim), "已复制内容")}
                    />
                  ))}
                </div>
              </div>
            ) : null}
            {showSummaries ? (
              <div>
                <div className="text-[11px] tracking-wide text-fg-faint">需求总结（{summaries.length}）</div>
                <div className="mt-2 flex flex-col gap-2">
                  {summaries.map((s) => (
                    <SummaryRow
                      key={s.requirementId}
                      s={s}
                      onView={() => setViewing(s)}
                      onEdit={() => {
                        setSummaryError(null);
                        setEditingSummary({ s, text: s.content ?? "" });
                      }}
                      onCopyPath={() => copy(s.mdPath, "已复制路径（Markdown 绝对路径）")}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {/* 知识编辑弹层（原型一致项 7 同款形态）：claim textarea + 适用范围 input 可编辑，溯源只读；保存中遮罩禁关（busy） */}
          {editing ? (
            <Modal
              variant="absolute"
              closeOnOverlay
              busy={editSaving}
              onClose={() => setEditing(null)}
              maskTestId="memory-edit-mask"
              dialogTestId="memory-knowledge-dialog"
              dialogClassName="w-[460px] max-w-full"
            >
              <h3 className="mb-3 text-sm font-semibold">编辑知识 {editing.k.displayNo}</h3>
              <label className="mb-1 block text-[11px] text-muted-foreground" htmlFor="memory-edit-claim">
                知识内容（claim）
              </label>
              <textarea
                id="memory-edit-claim"
                data-testid="memory-edit-claim"
                aria-label="知识内容（claim）"
                rows={3}
                className="mb-3 w-full resize-y rounded-lg border border-border bg-muted px-2.5 py-2 text-[13px] outline-none focus:border-primary"
                value={editing.claim}
                onChange={(e) => setEditing({ ...editing, claim: e.target.value })}
              />
              <label className="mb-1 block text-[11px] text-muted-foreground" htmlFor="memory-edit-scope">
                适用范围（scope）
              </label>
              <input
                id="memory-edit-scope"
                data-testid="memory-edit-scope"
                aria-label="适用范围（scope）"
                className="mb-3 w-full rounded-lg border border-border bg-muted px-2.5 py-2 text-[13px] outline-none focus:border-primary"
                value={editing.scope}
                onChange={(e) => setEditing({ ...editing, scope: e.target.value })}
              />
              {/* 溯源信息只读（保证可追溯） */}
              <div className="mb-3 rounded-lg border border-dashed border-border px-2.5 py-2 text-[11px] leading-relaxed text-fg-faint">
                溯源信息（只读，保证可追溯）：
                <br />
                来源会话：{editing.k.sourceSessionIds.length} 个 · {editing.k.evidence}
                <br />
                编号：{editing.k.displayNo}
              </div>
              {editError ? <p className="mb-2 text-xs text-destructive">保存失败：{editError}</p> : null}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  data-testid="memory-knowledge-cancel"
                  className={DIALOG_BTN}
                  disabled={editSaving}
                  onClick={() => setEditing(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  data-testid="memory-knowledge-save"
                  className={DIALOG_BTN_PRIMARY}
                  disabled={editSaving || editing.claim.trim() === ""}
                  onClick={saveEdit}
                >
                  {editSaving ? "保存中…" : "保存"}
                </button>
              </div>
            </Modal>
          ) : null}

          {/* 总结查看弹层（只读正文；遮罩点击即关） */}
          {viewing ? (
            <Modal
              variant="absolute"
              closeOnOverlay
              onClose={() => setViewing(null)}
              maskTestId="memory-view-mask"
              dialogTestId="memory-summary-dialog"
              dialogClassName="max-h-[80%] w-[560px] max-w-full overflow-y-auto"
            >
              <h3 className="mb-2 text-sm font-semibold">
                需求总结 · {viewing.requirementId} {viewing.title ? `· ${viewing.title}` : ""}
              </h3>
              <pre className="mb-3 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-muted-foreground">
                {viewing.content ?? "（总结内容不可用）"}
              </pre>
              <div className="flex justify-end">
                <button type="button" className={DIALOG_BTN} onClick={() => setViewing(null)}>
                  关闭
                </button>
              </div>
            </Modal>
          ) : null}

          {/* 总结编辑弹层（原型一致项 8：同款弹层形态 textarea；保存走 memory:editSummary 写回并纳入防覆盖基准，#38；保存中遮罩禁关（busy）） */}
          {editingSummary ? (
            <Modal
              variant="absolute"
              closeOnOverlay
              busy={summarySaving}
              onClose={() => setEditingSummary(null)}
              maskTestId="memory-summary-edit-mask"
              dialogTestId="memory-summary-edit-dialog"
              dialogClassName="max-h-[80%] w-[560px] max-w-full overflow-y-auto"
            >
              <h3 className="mb-2 text-sm font-semibold">
                编辑需求总结 · {editingSummary.s.requirementId} {editingSummary.s.title ? `· ${editingSummary.s.title}` : ""}
              </h3>
              <textarea
                data-testid="memory-summary-textarea"
                aria-label="总结正文"
                rows={12}
                className="mb-2 w-full resize-y rounded-lg border border-border bg-muted px-2.5 py-2 text-[12px] leading-relaxed outline-none focus:border-primary"
                value={editingSummary.text}
                onChange={(e) => setEditingSummary({ ...editingSummary, text: e.target.value })}
              />
              {summaryError ? <p className="mb-2 text-xs text-destructive">保存失败：{summaryError}</p> : null}
              <div className="flex justify-end gap-2">
                <button type="button" className={DIALOG_BTN} disabled={summarySaving} onClick={() => setEditingSummary(null)}>
                  关闭
                </button>
                <button
                  type="button"
                  data-testid="memory-summary-save"
                  className={DIALOG_BTN_PRIMARY}
                  disabled={summarySaving || editingSummary.text.trim() === ""}
                  onClick={saveSummaryEdit}
                >
                  {summarySaving ? "保存中…" : "保存"}
                </button>
              </div>
            </Modal>
          ) : null}
        </>
      )}
    </section>
  );
}

/** 知识卡（原型一致项 2）：claim 正文（有效值）+ 适用范围徽标 + 来源会话数 + 编号 + 状态 chip + 编辑/复制路径/复制内容 */
function KnowledgeCard({
  k,
  onEdit,
  onCopyPath,
  onCopyContent,
}: {
  k: MemoryCandidateRow;
  onEdit(): void;
  onCopyPath(): void;
  onCopyContent(): void;
}) {
  const claim = effectiveValue(k.editedClaim, k.claim);
  const scope = effectiveValue(k.editedScope, k.scope);
  return (
    <div data-testid="memory-knowledge-card" className="rounded-[10px] border border-border bg-card px-3.5 py-3">
      <p data-testid="memory-knowledge-claim" className="text-[13px] leading-relaxed">
        {claim}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-fg-faint">
        <span data-testid="memory-knowledge-scope" className="rounded-full border border-primary/40 px-2 py-px text-primary">
          适用范围：{scope}
        </span>
        <span data-testid="memory-knowledge-source">来源 {k.sourceSessionIds.length} 会话</span>
        <span>{k.displayNo}</span>
        <span
          data-testid="memory-knowledge-status"
          className={`rounded-full border px-2 py-px ${
            k.status === "edited" ? "border-primary/40 text-primary" : "border-ok/40 text-ok"
          }`}
        >
          {k.status === "edited" ? "已编辑" : "已接受"}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            data-testid="memory-knowledge-edit"
            title="编辑知识（claim 与适用范围）"
            className={DIALOG_BTN}
            onClick={onEdit}
          >
            编辑
          </button>
          <button
            type="button"
            data-testid="memory-knowledge-copy-path"
            title="复制 Markdown 绝对路径（供 CLI 按需读取）"
            className={DIALOG_BTN}
            onClick={onCopyPath}
          >
            复制路径
          </button>
          <button
            type="button"
            data-testid="memory-knowledge-copy-content"
            title="复制知识正文（有效 claim）"
            className={DIALOG_BTN}
            onClick={onCopyContent}
          >
            复制内容
          </button>
        </div>
      </div>
    </div>
  );
}

/** 总结行（原型一致项 2）：需求编号+标题 / 更新时间 / 查看/编辑/复制路径 */
function SummaryRow({ s, onView, onEdit, onCopyPath }: { s: MemorySummaryRow; onView(): void; onEdit(): void; onCopyPath(): void }) {
  return (
    <div data-testid="memory-summary-row" className="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-border bg-card px-3.5 py-2.5">
      <span className="text-[13px]">
        {s.requirementId} · {s.title ?? "（需求已删除）"}
      </span>
      <span className="text-[11px] text-fg-faint">更新于 {formatUpdatedAt(s.updatedAt)}</span>
      <div className="ml-auto flex gap-2">
        <button type="button" data-testid="memory-summary-view" className={DIALOG_BTN} onClick={onView}>
          查看
        </button>
        <button type="button" data-testid="memory-summary-edit" className={DIALOG_BTN} onClick={onEdit}>
          编辑
        </button>
        <button
          type="button"
          data-testid="memory-summary-copy-path"
          title="复制 summary.md 绝对路径（供 CLI 按需读取）"
          className={DIALOG_BTN}
          onClick={onCopyPath}
        >
          复制路径
        </button>
      </div>
    </div>
  );
}
