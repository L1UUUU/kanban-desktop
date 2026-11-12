// 用途：composer 控件共享件 —— 权限档位 chip（三档下拉带说明；#59 起会话 composer 与草稿面板共用，DOM 输出与原 Composer 内联形态一致）；模型选择自 #77 起独立为 ModelCombobox（真实目录数据源）
import type { PermMode } from "@kanban/ipc-schema";
import { useClosableOverlay } from "./use-closable-overlay";

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

/** 权限档位 chip + 下拉菜单（三档带说明；原型一致项 6）—— 浮层关闭交互（外部点击/Esc）经共享 useClosableOverlay，issue #83 */
export function PermChip({ value, onChange }: { value: PermMode; onChange(mode: PermMode): void }) {
  const { open, setOpen, rootRef } = useClosableOverlay<HTMLSpanElement>();
  const perm = PERM_META[value];
  return (
    <span ref={rootRef} className="relative">
      <button
        type="button"
        title="权限档位：由 Adapter 映射到各 CLI 原生审批机制"
        className={`inline-flex h-7 items-center rounded-full border px-3 text-xs hover:border-primary hover:text-foreground ${PERM_CHIP_CLS[value]}`}
        onClick={() => setOpen((v) => !v)}
      >
        {perm.icon} 权限：{perm.label} ▾
      </button>
      {open ? (
        <div className="absolute bottom-full left-0 z-10 mb-1 min-w-[280px] rounded-lg border border-border bg-muted p-1 shadow-[0_8px_24px_rgba(0,0,0,.5)]">
          {(["ask", "auto", "full"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className="block w-full rounded-md px-2.5 py-1.5 text-left hover:bg-card"
              onClick={() => {
                onChange(mode);
                setOpen(false);
              }}
            >
              <span className="block text-[13px] font-semibold">{PERM_META[mode].menuTitle}</span>
              <span className="block text-[11px] text-muted-foreground">{PERM_META[mode].desc}</span>
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
