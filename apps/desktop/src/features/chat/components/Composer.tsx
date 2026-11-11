// 用途：composer 输入区 —— 统一容器聚焦高亮、权限档位 chip（三档带说明）+ 模型选择、发送 ↔ 停止态切换（原型一致项 6/7；文案硬约束；#59 起权限/模型控件与草稿面板共享 ComposerControls）
import { useState } from "react";
import type { PermMode } from "@kanban/ipc-schema";
import type { SessionView } from "../chat-store";
import { ModelSelect, PermChip } from "./ComposerControls";

export interface ComposerActions {
  onSend(text: string): void;
  onInterrupt(): void;
  onPermChange(mode: PermMode): void;
  onModelChange(model: string): void;
}

export function Composer({ session, actions }: { session: SessionView; actions: ComposerActions }) {
  const [text, setText] = useState("");
  const running = session.status === "running";

  const send = (): void => {
    if (text.trim().length === 0) return;
    actions.onSend(text);
    setText("");
  };

  return (
    <footer className="border-t border-border bg-card px-6 pb-4 pt-3">
      <div className="mx-auto max-w-[860px] rounded-[14px] border border-border bg-muted px-3.5 pb-2 pt-2.5 transition-colors focus-within:border-primary">
        <textarea
          placeholder="输入消息，/ 开头触发 Skill…"
          rows={2}
          disabled={running}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="min-h-[46px] w-full resize-none bg-transparent text-[13px] outline-none placeholder:text-fg-faint disabled:text-muted-foreground"
        />
        <div className="mt-2 flex items-center gap-2">
          {/* 权限档位 chip + 下拉菜单（三档带说明） */}
          <PermChip value={session.permMode} onChange={actions.onPermChange} />
          {/* 模型选择：选定值随新建会话下发，作用于该会话（已建会话不动态改模型） */}
          <ModelSelect value={session.model} onChange={actions.onModelChange} />
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
              onClick={send}
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
    </footer>
  );
}
