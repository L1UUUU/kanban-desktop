// 用途：结构化会话草稿面板（#59 / spec #57 原型演示①）—— 点「＋」后的中央区草稿态：提示行（不落库、未启 CLI）+ 首条消息 composer（权限/模型可改、输入失败保留；#77 起模型为真实目录 combobox：就绪前阻塞首条发送）+ 提交失败卡（重试=重新执行创建+发送）；#85 起上缘可拖拽调高（与会话 Composer 共享同一持久化偏好）；#90 输入框带斜杠补全菜单
import { useState } from "react";
import type { PermMode } from "@kanban/ipc-schema";
import type { DraftSession } from "../chat-store";
import type { ModelCatalog } from "../model-catalog";
import type { ComposerCommandSource } from "../composer-command-source";
import { useComposerPanelHeight } from "../../../lib/use-panel-size";
import { PermChip } from "./ComposerControls";
import { ComposerTextarea } from "./ComposerTextarea";
import { ModelCombobox } from "./ModelCombobox";
import { CreateErrorCard } from "./CreateErrorCard";

export interface DraftPaneActions {
  /** 提交草稿：经 Main 原子链「创建原生会话→落库→发送首条消息」；失败返回 false（草稿与输入保留） */
  onSubmit(): Promise<boolean>;
  /** 首条消息输入（受控于草稿：失败保留、丢弃即失） */
  onInput(input: string): void;
  onPermChange(mode: PermMode): void;
  onModelChange(model: string): void;
  /** 失败卡「知道了」：仅清除错误（草稿与输入保留） */
  onDismissError(): void;
}

export function DraftPane({
  draft,
  models,
  commands,
  configPath,
  actions,
}: {
  draft: DraftSession;
  /** 模型目录控制器（issue #77）：combobox 数据源与挂载预取 */
  models: ModelCatalog;
  /** 斜杠命令源（issue #90）：补全菜单数据（草稿 cli/cwd 键控） */
  commands: ComposerCommandSource;
  /** 配置文件绝对路径（spawn 失败卡「复制配置路径」数据源） */
  configPath: string | null;
  actions: DraftPaneActions;
}) {
  const [submitting, setSubmitting] = useState(false);
  // #85 输入框高度（与会话 Composer 共享 key：两态联动为预期行为）
  const composer = useComposerPanelHeight();

  // 提交中禁用输入与按钮（防双发）；单一就绪态：模型未选（列表未就绪/未手输兜底）禁发（issue #77）；
  // 失败时 draft 仍在（输入保留在草稿上）；返回值不在此消费：成功草稿消失 / 失败经 draft.submitError 渲染失败卡（均由 store 状态驱动）
  const blocked = draft.model === undefined;
  const submit = async (): Promise<void> => {
    if (draft.input.trim().length === 0 || submitting || blocked) return;
    setSubmitting(true);
    await actions.onSubmit();
    setSubmitting(false);
  };

  return (
    <section data-testid="draft-pane" className="flex min-h-0 min-w-0 flex-col bg-background">
      {/* 草稿提示行（原型 .draft-hint）：明确「不落库、不启 CLI、发首条消息才创建会话」；替换提示为全局单草稿的明确反馈 */}
      <div data-testid="draft-hint" className="flex-none border-b border-warn/40 bg-warn/10 px-6 py-2 text-xs text-warn">
        ✎ 草稿 · <b>{draft.title}</b> — 尚未保存、未启动 CLI，发出第一条消息后才创建会话
        {draft.replacedHint ? "（已替换上一个草稿：全局仅一个）" : ""}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto max-w-[860px]">
          {draft.submitError ? (
            // 提交失败卡（原型演示① err-card）：保留输入与草稿，重试=重新执行「创建+发送首条消息」
            <CreateErrorCard
              failure={{
                cli: draft.cli,
                code: draft.submitError.code,
                message: draft.submitError.message,
                cwd: draft.cwd,
                projectId: draft.projectId,
              }}
              configPath={configPath}
              retryLabel="重试发送"
              onRetry={() => void submit()}
              onDismiss={actions.onDismissError}
            />
          ) : null}
        </div>
      </div>
      {/* 首条消息 composer：结构与会话 Composer 一致；输入受控于草稿（失败保留、丢弃即失）；斜杠补全菜单（#90） */}
      <footer className="relative border-t border-border bg-card px-6 pb-4 pt-3">
        {/* #85 输入框上缘拖拽把手（footer 顶边全宽命中区） */}
        <div
          data-testid="composer-resize-handle"
          className={`absolute inset-x-0 top-0 z-10 h-1.5 cursor-row-resize select-none hover:bg-primary/25 focus-visible:bg-primary/40 ${
            composer.dragging ? "bg-primary/40" : ""
          }`}
          {...composer.handleProps}
        />
        <div className="mx-auto max-w-[860px] rounded-[14px] border border-border bg-muted px-3.5 pb-2 pt-2.5 transition-colors focus-within:border-primary">
          <ComposerTextarea
            value={draft.input}
            onChange={(input) => actions.onInput(input)}
            commands={commands}
            cli={draft.cli}
            cwd={draft.cwd}
            disabled={submitting}
            style={{ height: Math.round(composer.size) }}
            className="w-full resize-none bg-transparent text-[13px] outline-none placeholder:text-fg-faint disabled:text-muted-foreground"
          />
          <div className="mt-2 flex items-center gap-2">
            <PermChip value={draft.permMode} onChange={actions.onPermChange} />
            {/* 模型 combobox（草稿语义：就绪后自动选中默认项并随首条消息真实下发——所见即所发，issue #77） */}
            <ModelCombobox
              cli={draft.cli}
              cwd={draft.cwd}
              value={draft.model}
              onChange={actions.onModelChange}
              catalog={models}
              autoSelectDefault
            />
            <span className="flex-1" />
            <button
              type="button"
              disabled={submitting || blocked || draft.input.trim().length === 0}
              className="h-[30px] rounded-full bg-primary px-4 text-xs text-primary-foreground hover:bg-accent2 disabled:opacity-50"
              onClick={() => void submit()}
            >
              发送 ➤
            </button>
          </div>
        </div>
        {draft.cli === "opencode" ? (
          <div className="mt-1.5 text-center text-[11px] text-muted-foreground">
            OpenCode 权限档位为 server 级（同项目下会话共享）；切换后新会话生效
          </div>
        ) : null}
      </footer>
    </section>
  );
}
