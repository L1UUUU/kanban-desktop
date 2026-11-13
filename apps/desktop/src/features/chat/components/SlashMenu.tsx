// 用途：斜杠补全菜单纯展示组件（issue #90 / spec #82 E 块；ADR 0004 零内置）—— 单组列表（CLI 命令源）；焦点始终留在输入框：行以 mousedown+preventDefault 接受，光标不离开草稿（role=option/aria-selected/scrollIntoView nearest 对齐 PI ComposerAutocomplete）
import { Fragment, useEffect, useRef } from "react";
import type { MenuCommand } from "./slash-trigger";

/** 分组标题（ADR 0004 后单组：CLI 命令） */
const GROUP_LABELS: Record<MenuCommand["group"], string> = { cli: "CLI 命令" };

export interface SlashMenuProps {
  items: MenuCommand[];
  highlight: number;
  onHover(index: number): void;
  onAccept(index: number): void;
}

/** 补全菜单（挂输入框上方 bottom-full；键盘协议由 use-slash-menu 持有，本组件只渲染与鼠标接受） */
export function SlashMenu({ items, highlight, onHover, onAccept }: SlashMenuProps) {
  const listRef = useRef<HTMLDivElement | null>(null);

  // 高亮行滚动到可视区（jsdom 无实现，特性检测跳过）
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-slash-index="${highlight}"]`);
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="斜杠命令"
      data-testid="slash-menu"
      className="absolute bottom-full left-0 z-20 mb-1 max-h-[260px] w-full overflow-y-auto rounded-lg border border-border bg-muted p-1 shadow-[0_8px_24px_rgba(0,0,0,.5)]"
    >
      {items.length === 0 ? (
        // 空态引导（ADR 0004：无命令源/无命中不填占位命令；降级判据——未匹配的 / 开头输入按原样发送）
        <div className="px-2.5 py-1.5 text-[11.5px] text-muted-foreground">无可用命令：未匹配的 / 开头输入将按原样发送</div>
      ) : (
        items.map((item, i) => (
          <Fragment key={`${item.group}:${item.name}`}>
            {i === 0 || items[i - 1].group !== item.group ? (
              <div data-testid="slash-menu-group" className="px-2.5 pb-0.5 pt-1.5 text-[10.5px] uppercase tracking-wide text-fg-faint">
                {GROUP_LABELS[item.group]}
              </div>
            ) : null}
            <button
              type="button"
              role="option"
              aria-selected={i === highlight}
              data-slash-index={i}
              data-testid="slash-menu-item"
              // mousedown+preventDefault 接受：不转移焦点，光标留在输入框
              onMouseDown={(e) => {
                e.preventDefault();
                onAccept(i);
              }}
              onMouseMove={() => onHover(i)}
              className={`block w-full truncate rounded-md px-2.5 py-1.5 text-left ${i === highlight ? "bg-card" : "hover:bg-card"}`}
            >
              <span className="font-mono text-[12.5px] font-semibold text-foreground">/{item.name}</span>
              {item.argsHint ? <span className="ml-1.5 font-mono text-[10.5px] text-fg-faint">{item.argsHint}</span> : null}
              {item.userOnly ? (
                <span className="ml-1.5 rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">仅用户</span>
              ) : null}
              <span className="ml-2 text-[11.5px] text-muted-foreground">{item.description}</span>
            </button>
          </Fragment>
        ))
      )}
    </div>
  );
}
