// 用途：候选编辑弹层（#33，原型一致项 7 / 演示 ③）—— claim textarea + 适用范围 input 可编辑、溯源区只读（来源会话/证据摘录/批次/编号）；两种模式：pending「编辑后接受」（保存=reviewCandidate edit，标注已编辑）与终态知识「去编辑」（保存=editAccepted）
import { useState } from "react";
import type { MemoryCandidateRow } from "@kanban/ipc-schema";
import { Modal } from "../../components/Modal";
import { sessionCliLabel } from "../../lib/cli-catalog";
import type { MemorySessionRef } from "./MemoryArea";
import { shortId } from "./MemoryArea";

export interface CandidateEditDialogProps {
  /** 待编辑候选（pending 或 accepted/edited 知识） */
  candidate: MemoryCandidateRow;
  /** pending=编辑后接受（reviewCandidate edit）；knowledge=已接受知识再编辑（editAccepted） */
  mode: "pending" | "knowledge";
  /** 会话视图（溯源区 cli 标注；缺省仅列 id） */
  sessions?: MemorySessionRef[];
  onClose(): void;
  /** 保存：返回拒绝原因文案（null=成功并关闭）；edit 仅含发生修改且合法的字段 */
  onSave(edit: { claim?: string; scope?: string }): Promise<string | null>;
}

/** 候选编辑弹层：仅 claim/scope 可编辑（spec #27 G 节：edit 仅 claim/scope、溯源不可编辑） */
export function CandidateEditDialog({ candidate, mode, sessions = [], onClose, onSave }: CandidateEditDialogProps) {
  // 初值：knowledge 模式取编辑后有效值（editedClaim ?? claim）
  const effectiveClaim = mode === "knowledge" ? candidate.editedClaim ?? candidate.claim : candidate.claim;
  const effectiveScope = mode === "knowledge" ? candidate.editedScope ?? candidate.scope : candidate.scope;
  const [claim, setClaim] = useState(effectiveClaim);
  const [scope, setScope] = useState(effectiveScope);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /** 保存：组装载荷（claim 空串不发送——wire min(1)；两字段皆空 = 无修改，提示） */
  const save = async (): Promise<void> => {
    const nextClaim = claim.trim();
    const nextScope = scope.trim();
    if (!nextClaim && !nextScope) {
      setError("claim 与适用范围至少保留一项内容");
      return;
    }
    setSaving(true);
    // 与原值相同的不重发（保持载荷最小）；claim 允许单独为空（仅改 scope 的合法路径）
    const edit: { claim?: string; scope?: string } = {};
    if (nextClaim && nextClaim !== effectiveClaim) edit.claim = nextClaim;
    if (nextScope !== effectiveScope) edit.scope = nextScope;
    if (!edit.claim && !edit.scope) {
      setSaving(false);
      onClose();
      return;
    }
    const rejectText = await onSave(edit);
    setSaving(false);
    if (rejectText) setError(rejectText);
  };

  return (
    <Modal
      variant="absolute"
      closeOnOverlay
      onClose={onClose}
      maskTestId="memory-edit-mask"
      dialogTestId="memory-edit-dialog"
      dialogClassName="flex w-[420px] max-w-full flex-col"
    >
      <h3 className="mb-3 text-sm font-semibold">{mode === "knowledge" ? "编辑已接受知识" : "编辑知识候选"}</h3>
      <label className="mb-1 block text-[11px] text-muted-foreground" htmlFor="memory-edit-claim-input">
        知识内容（claim）— 可编辑
      </label>
      <textarea
        id="memory-edit-claim-input"
        data-testid="memory-edit-claim"
        rows={3}
        className="mb-3 w-full resize-y rounded-lg border border-border bg-muted px-2.5 py-2 text-[13px] text-foreground outline-none focus:border-primary"
        value={claim}
        onChange={(e) => setClaim(e.target.value)}
      />
      <label className="mb-1 block text-[11px] text-muted-foreground" htmlFor="memory-edit-scope-input">
        适用范围（scope）— 可编辑
      </label>
      <input
        id="memory-edit-scope-input"
        data-testid="memory-edit-scope"
        className="mb-3 w-full rounded-lg border border-border bg-muted px-2.5 py-2 text-[13px] text-foreground outline-none focus:border-primary"
        value={scope}
        onChange={(e) => setScope(e.target.value)}
      />
      {/* 溯源区只读：来源会话/证据摘录/批次/编号（保证可追溯，不可编辑） */}
      <div data-testid="memory-edit-source" className="mb-3 rounded-lg border border-dashed border-border px-2.5 py-2 text-[11px] leading-relaxed text-fg-faint">
        溯源信息（只读，保证可追溯）：
        <br />
        来源会话：
        {candidate.sourceSessionIds.length > 0
          ? candidate.sourceSessionIds
              .map((id) => {
                const s = sessions.find((x) => x.sessionId === id);
                return s ? `${s.kind === "pty" ? "PTY" : sessionCliLabel(s.cli)} · ${shortId(id)}` : shortId(id);
              })
              .join("、")
          : "（未记录）"}
        <br />
        证据摘录：「{candidate.evidence || "（无）"}」
        <br />
        批次：{shortId(candidate.batchId)} · 候选编号 {candidate.displayNo}
      </div>
      {error ? (
        <p data-testid="memory-edit-error" className="mb-2 rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[11px] text-warn">
          ⚠ {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          data-testid="memory-edit-cancel"
          className="rounded-md border border-border px-3 py-1 text-xs text-muted-foreground hover:border-primary hover:text-foreground"
          onClick={onClose}
        >
          取消
        </button>
        <button
          type="button"
          data-testid="memory-edit-save"
          disabled={saving}
          className="rounded-md border border-primary bg-primary/15 px-3 py-1 text-xs text-foreground hover:bg-primary/25"
          onClick={() => void save()}
        >
          {mode === "knowledge" ? "保存" : "保存（标记为已编辑）"}
        </button>
      </div>
    </Modal>
  );
}
