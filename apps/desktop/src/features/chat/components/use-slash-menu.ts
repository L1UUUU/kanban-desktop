// 用途：斜杠补全菜单状态机 hook（issue #90 / spec #82 E 块）—— 触发检测（纯函数）× 命令源（预热/TTL）× 键盘协议（↑↓ 循环/Enter/Tab/Esc）× IME 合成冻结（合成中用冻结快照不重算，不闪动）；IME isComposing/keyCode 229 首行守门；Esc 按 token 内容记忆（同 token 不重弹）
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CliKind } from "@kanban/ipc-schema";
import { COMMANDS_IDLE, type ComposerCommandSource } from "../composer-command-source";
import {
  APP_SLASH_COMMANDS,
  applySlashCompletion,
  detectSlashTrigger,
  filterSlashCommands,
  nextSlashHighlight,
  slashDismissKey,
  toMenuCommand,
  type MenuCommand,
  type SlashTrigger,
} from "./slash-trigger";

export interface UseSlashMenuArgs {
  /** 草稿文本（会话 Composer 本地态 / 草稿 store 受控态，由外层持有） */
  value: string;
  /** 草稿变更出口（接受补全 = 替换 slash token 后回写） */
  onChange(next: string): void;
  /** renderer 命令源（TTL 缓存 + 预热；菜单 CLI 命令组数据） */
  source: ComposerCommandSource;
  cli: CliKind;
  /** 命令目录拉取 cwd（null = 不拉取不弹菜单：会话 cwd 未知等过渡态） */
  cwd: string | null;
  /** 输入框禁用（running / 提交中）：菜单不弹 */
  disabled?: boolean;
  /** 选中回调（#92 执行接线数据面：app 命令本地执行 / cli 命令派发前置钩子） */
  onAcceptCommand?(cmd: MenuCommand): void;
  /** 输入框 ref（接受补全后光标恢复到实参位） */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

/** 菜单可见面（SlashMenu 展示 props） */
export interface SlashMenuView {
  open: boolean;
  items: MenuCommand[];
  highlight: number;
  onHover(index: number): void;
  onAccept(index: number): void;
}

export interface SlashMenuController {
  onChange(e: React.ChangeEvent<HTMLTextAreaElement>): void;
  onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void;
  onCompositionStart(): void;
  onCompositionEnd(): void;
  onSelect(e: React.SyntheticEvent<HTMLTextAreaElement>): void;
  menu: SlashMenuView;
}

/** 斜杠补全菜单状态机：检测/过滤为纯函数，本 hook 只管 DOM 事件接线与快照冻结 */
export function useSlashMenu(args: UseSlashMenuArgs): SlashMenuController {
  const { value, onChange, source, cli, cwd, disabled = false, onAcceptCommand, textareaRef } = args;
  const [cursor, setCursor] = useState(value.length);
  const [composing, setComposing] = useState(false);
  // 高亮存储（key=所属 token 的 dismissKey）：token 变化或候选缩短时在渲染期派生重置/夹取
  const [highlightState, setHighlightState] = useState<{ key: string | null; value: number }>({ key: null, value: 0 });
  const [dismissed, setDismissed] = useState<string | null>(null);
  // IME 冻结快照：compositionstart 时拍下的 live 触发（合成中不重算，不开不关不过滤；compositionend 后用最新 live 重估）
  const [frozen, setFrozen] = useState<SlashTrigger | null>(null);
  // 接受补全后的待恢复光标（受控 value 回流后再落 selection）
  const pendingCursorRef = useRef<number | null>(null);

  // 命令源订阅 + 挂载预热（首次输入 / 不等冷启动）；触发期再 ensure（TTL 过期幂等刷新）
  const subscribe = useCallback(
    (listener: () => void) => (cwd ? source.subscribe(cli, cwd, listener) : () => undefined),
    [source, cli, cwd],
  );
  const getSnapshot = useCallback(() => (cwd ? source.getState(cli, cwd) : COMMANDS_IDLE), [source, cli, cwd]);
  const state = useSyncExternalStore(subscribe, getSnapshot);
  useEffect(() => {
    if (cwd) source.ensure(cli, cwd);
  }, [source, cli, cwd]);

  const live = useMemo(() => detectSlashTrigger(value, cursor), [value, cursor]);
  const trigger = composing ? frozen : live;
  const menuActive = trigger !== null;
  useEffect(() => {
    // 菜单激活中兜底 ensure：预热错过/TTL 过期时触发期补拉（ensure 幂等）
    if (cwd && menuActive) source.ensure(cli, cwd);
  }, [source, cli, cwd, menuActive]);

  const entries = useMemo(() => (state.status === "ready" ? state.commands.map(toMenuCommand) : []), [state]);
  const items = useMemo(
    () => (trigger ? filterSlashCommands([...APP_SLASH_COMMANDS, ...entries], trigger.query) : []),
    [trigger, entries],
  );

  const dismissKey = trigger ? slashDismissKey(value, trigger) : null;
  const open = !disabled && trigger !== null && dismissed !== dismissKey && state.status === "ready";

  // 高亮派生：token（dismissKey）变化重置到 0；候选缩短夹取到界内
  let highlight = highlightState.key === dismissKey ? highlightState.value : 0;
  if (highlight >= items.length) highlight = Math.max(0, items.length - 1);
  const setHighlight = useCallback(
    (next: number | ((h: number) => number)) => {
      setHighlightState((prev) => {
        const current = prev.key === dismissKey ? prev.value : 0;
        return { key: dismissKey, value: typeof next === "function" ? next(current) : next };
      });
    },
    [dismissKey],
  );

  // 受控 value 回流后恢复接受位光标
  useEffect(() => {
    if (pendingCursorRef.current === null) return;
    const el = textareaRef.current;
    if (el) el.setSelectionRange(pendingCursorRef.current, pendingCursorRef.current);
    pendingCursorRef.current = null;
  }, [value, textareaRef]);

  const accept = useCallback(
    (index: number) => {
      if (!trigger) return;
      const item = items[index];
      if (!item) return;
      const next = applySlashCompletion(value, trigger, item.name);
      pendingCursorRef.current = next.cursor;
      setCursor(next.cursor);
      setComposing(false);
      onChange(next.value);
      onAcceptCommand?.(item);
    },
    [trigger, items, value, onChange, onAcceptCommand],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // IME 守门（首行）：合成期（isComposing 或 keyCode 229 兜底）不驱动菜单——确认候选的 Enter 绝不触发接受
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      if (!open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(dismissKey);
        return;
      }
      if (items.length === 0) return; // 无匹配：其余按键走默认行为
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight(nextSlashHighlight(highlight, items.length, 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight(nextSlashHighlight(highlight, items.length, -1));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        accept(highlight);
        return;
      }
    },
    [open, dismissKey, items.length, highlight, accept, setHighlight],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      // 丢 compositionend 兜底（PI #929 同款）：下一次非合成 input 也解冻
      if (!(e.nativeEvent as InputEvent).isComposing) setComposing(false);
      setCursor(e.target.selectionStart ?? e.target.value.length);
      onChange(e.target.value);
    },
    [onChange],
  );

  const handleSelect = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    setCursor(e.currentTarget.selectionStart ?? 0);
  }, []);

  const handleCompositionStart = useCallback(() => {
    // 快照当前 live 触发：合成期以本快照驱动菜单（冻结不闪动）
    setFrozen(live);
    setComposing(true);
  }, [live]);

  const handleCompositionEnd = useCallback(() => {
    // 解冻后用最后一次 live 值重估（本组件 value/cursor 已随 onChange 更新）
    setComposing(false);
  }, []);

  return {
    onChange: handleChange,
    onKeyDown,
    onCompositionStart: handleCompositionStart,
    onCompositionEnd: handleCompositionEnd,
    onSelect: handleSelect,
    menu: {
      open,
      items,
      highlight,
      onHover: setHighlight,
      onAccept: accept,
    },
  };
}
