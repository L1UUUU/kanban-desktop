// 用途：composer 输入区 —— 统一容器聚焦高亮、权限档位 chip（三档带说明）+ 模型选择、发送 ↔ 停止态切换（原型一致项 6/7；文案硬约束）
import { useState } from "react";
import type { PermMode } from "@kanban/ipc-schema";
import type { SessionView } from "../chat-store";

// 权限三档元数据（原型 §3.3 文案硬约束；fake 非 OpenCode，full 用通用说明）
const PERM_META: Record<PermMode, { icon: string; label: string; menuTitle: string; desc: string }> = {
  ask: {
    icon: "🔒",
    label: "请求",
    menuTitle: "🔒 请求",
    desc: "所有工具调用前弹出审批卡片",
  },
  auto: {
    icon: "⚡",
    label: "自动",
    menuTitle: "⚡ 自动（推荐）",
    desc: "安全操作放行，风险操作（写文件/命令）弹审批",
  },
  full: {
    icon: "🔓",
    label: "完全访问",
    menuTitle: "🔓 完全访问",
    desc: "全部自动放行，不弹任何审批",
  },
};

const PERM_CHIP_CLS: Record<PermMode, string> = {
  ask: "text-warn border-warn/55",
  auto: "text-ok border-ok/50",
  full: "text-muted-foreground border-border",
};

const MODELS = ["默认模型", "gpt-5.6-luna"];

export interface ComposerActions {
  onSend(text: string): void;
  onInterrupt(): void;
  onPermChange(mode: PermMode): void;
  onModelChange(model: string): void;
}

export function Composer({ session, actions }: { session: SessionView; actions: ComposerActions }) {
  const [text, setText] = useState("");
  const [permMenuOpen, setPermMenuOpen] = useState(false);
  const running = session.status === "running";
  const perm = PERM_META[session.permMode];

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
          <span className="relative">
            <button
              type="button"
              title="权限档位：由 Adapter 映射到各 CLI 原生审批机制"
              className={`inline-flex h-7 items-center rounded-full border px-3 text-xs hover:border-primary hover:text-foreground ${PERM_CHIP_CLS[session.permMode]}`}
              onClick={() => setPermMenuOpen((v) => !v)}
            >
              {perm.icon} 权限：{perm.label} ▾
            </button>
            {permMenuOpen ? (
              <div className="absolute bottom-full left-0 z-10 mb-1 min-w-[280px] rounded-lg border border-border bg-muted p-1 shadow-[0_8px_24px_rgba(0,0,0,.5)]">
                {(["ask", "auto", "full"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className="block w-full rounded-md px-2.5 py-1.5 text-left hover:bg-card"
                    onClick={() => {
                      actions.onPermChange(mode);
                      setPermMenuOpen(false);
                    }}
                  >
                    <span className="block text-[13px] font-semibold">{PERM_META[mode].menuTitle}</span>
                    <span className="block text-[11px] text-muted-foreground">{PERM_META[mode].desc}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </span>
          {/* 模型选择（演示值；真实模型列表来自各 CLI） */}
          <select
            aria-label="模型选择"
            className="h-7 cursor-pointer rounded-full border border-border bg-transparent px-3 text-xs text-muted-foreground hover:border-primary hover:text-foreground"
            value={session.model}
            onChange={(e) => actions.onModelChange(e.target.value)}
          >
            {MODELS.map((m) => (
              <option key={m} value={m} className="bg-muted text-foreground">
                {m}
              </option>
            ))}
          </select>
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
