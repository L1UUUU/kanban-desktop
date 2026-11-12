// 用途：composer 输入区 —— 统一容器聚焦高亮、权限档位 chip（三档带说明）+ 模型 combobox（真实目录/恢复会话派生显示）、发送 ↔ 停止态切换（原型一致项 6/7；文案硬约束；#59 起权限/模型控件与草稿面板共享 ComposerControls；#85 起上缘可拖拽调高（与 DraftPane 共享同一持久化偏好）；#90 输入框带斜杠补全菜单）
import { useState } from "react";
import type { CliKind, PermMode } from "@kanban/ipc-schema";
import type { SessionView } from "../chat-store";
import type { ModelCatalog } from "../model-catalog";
import type { ComposerCommandSource } from "../composer-command-source";
import { useComposerPanelHeight } from "../../../lib/use-panel-size";
import { PermChip } from "./ComposerControls";
import { ComposerTextarea } from "./ComposerTextarea";
import { ModelCombobox } from "./ModelCombobox";

export interface ComposerActions {
  /** 发送编排含斜杠派发（issue #92）：返回 true=输入已消费（清空输入框）；false=保留输入（派发失败错误卡已展示，可重试） */
  onSend(text: string): Promise<boolean>;
  onInterrupt(): void;
  onPermChange(mode: PermMode): void;
  onModelChange(model: string): void;
}

export function Composer({
  session,
  models,
  commands,
  actions,
}: {
  session: SessionView;
  models: ModelCatalog;
  /** 斜杠命令源（issue #90）：补全菜单数据（会话 cli/cwd 键控） */
  commands: ComposerCommandSource;
  actions: ComposerActions;
}) {
  const [text, setText] = useState("");
  // #85 输入框高度（与草稿 DraftPane 共享 key：两态联动为预期行为）
  const composer = useComposerPanelHeight();
  const running = session.status === "running";
  // #79：模型切换在 turn 进行中（含审批待决 waiting）被禁用——main 侧同语义校验拒绝
  const busy = running || session.status === "waiting";

  // #92：发送编排含斜杠派发（await 展开完成后再决定是否清空；fail-closed/展开失败返回 false 保留输入可重试）
  const send = async (): Promise<void> => {
    if (text.trim().length === 0) return;
    const consumed = await actions.onSend(text);
    if (consumed) setText("");
  };

  return (
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
          value={text}
          onChange={setText}
          commands={commands}
          cli={session.cli as CliKind}
          cwd={session.cwd}
          disabled={running}
          style={{ height: Math.round(composer.size) }}
          className="w-full resize-none bg-transparent text-[13px] outline-none placeholder:text-fg-faint disabled:text-muted-foreground"
        />
        <div className="mt-2 flex items-center gap-2">
          {/* 权限档位 chip + 下拉菜单（三档带说明） */}
          <PermChip value={session.permMode} onChange={actions.onPermChange} />
          {/* 模型 combobox：真实目录数据源；已建会话模型为空（恢复会话）时仅派生显示默认名，不写 store（中途切换走 session:setModel，#79）；PTY 会话不经本组件（TerminalWorkspace 渲染），cli 收窄为 CliKind */}
          <ModelCombobox cli={session.cli as CliKind} cwd={session.cwd} value={session.model} onChange={actions.onModelChange} catalog={models} disabled={busy} />
          <span className="flex-1" />
          {running ? (
            <button
              type="button"
              className="h-[30px] rounded-full border border-destructive px-4 text-xs text-destructive hover:bg-destructive/10"
              onClick={actions.onInterrupt}
            >
              ⏹ 停止输出
            </button>
          ) : (
            <button
              type="button"
              disabled={text.trim().length === 0}
              className="h-[30px] rounded-full bg-primary px-4 text-xs text-primary-foreground hover:bg-accent2 disabled:opacity-50"
              onClick={() => void send()}
            >
              发送 ➤
            </button>
          )}
        </div>
      </div>
      {/* OpenCode 权限为 server 级（spec B：同项目共享）——档位变更须明示影响同项目全部会话（原型 permnote 文案） */}
      {session.cli === "opencode" ? (
        <div className="mt-1.5 text-center text-[11px] text-muted-foreground">
          OpenCode 权限档位为 server 级（同项目下会话共享）；切换后新会话生效
        </div>
      ) : null}
      {/* #79：模型切换成功提示——当前轮仍用旧模型，下一轮起生效（turn_started 自动收起） */}
      {session.modelChangePending ? (
        <div data-testid="model-switch-note" className="mt-1.5 text-center text-[11px] text-muted-foreground">
          模型已切换，下一轮起生效
        </div>
      ) : null}
    </footer>
  );
}
