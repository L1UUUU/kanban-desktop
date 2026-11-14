// 用途：行内重命名交互单源（arch D11）——受控草稿 + Enter/blur 提交 + Esc 还原 + 空白/未变跳过 + settledRef 一次编辑会话只 settle 一次（覆盖 Enter-后-blur / Esc-后-blur 竞态）+ 失败错误槽；Sidebar 会话行 / RequirementCard / DetailPanel 三处共用（错误载体归一 string|null，会话域 ChatActionError 由调用方适配）
import { useEffect, useRef, useState, type FocusEvent } from "react";

/** 提交回调契约：null=成功；字符串=失败文案（回滚草稿 + 进错误槽，由调用方在行内渲染） */
export type InlineRenameSubmit = (next: string) => Promise<string | null>;

/** 编辑会话边界（哨兵/草稿/错误何时重置）两种形态：
 *  toggle——输入框随编辑开关换入换出，active 上升沿开新会话（重置哨兵 + 草稿同步外部值 + 清错误；Sidebar 挂载即会话传 active 恒 true，RequirementCard 传 editing）；
 *  persistent——常驻输入（DetailPanel）：编辑会话 = 一次聚焦（聚焦/输入重置哨兵），外部标题持续同步草稿，错误只在成功提交时清除 */
export type InlineRenameSession = { kind: "toggle"; active: boolean } | { kind: "persistent" };

export interface UseInlineRenameOptions {
  /** 外部当前标题：未变对比基准 / Esc 还原 / 失败回滚目标 */
  title: string;
  /** 提交回调（真实 IPC 由调用方驱动） */
  onCommit: InlineRenameSubmit;
  /** settle 收尾：空/未变跳过、Esc 还原后立即调用，真实提交在回调落定后调用（调用方在此清编辑态；常驻输入不传） */
  onSettle?(): void;
  /** 编辑会话边界形态 */
  session: InlineRenameSession;
  /** 聚焦全选（建卡即命名：输入即覆盖缺省标题）；缺省不全选（常驻输入维持原状） */
  selectOnFocus?: boolean;
}

export interface UseInlineRenameResult {
  /** 受控草稿值（绑定 input value） */
  draft: string;
  /** 失败文案（进入新 toggle 会话或成功提交时清除；渲染位置由调用方决定） */
  error: string | null;
  /** 更新草稿（绑定 input onChange；persistent 模式同时重置哨兵——新输入即新意图） */
  onChange(value: string): void;
  /** 提交（Enter/blur 绑定）：空白/未变跳过；哨兵保证一次编辑会话最多一次真实提交 */
  commit(): void;
  /** Esc 还原：放弃草稿回外部值并 settle（其后残余 blur 只收尾不提交） */
  cancel(): void;
  /** 输入聚焦（绑定 input onFocus；persistent 模式开新编辑会话，selectOnFocus 时全选） */
  onFocus(event: FocusEvent<HTMLInputElement>): void;
}

/** 行内重命名交互 hook：三消费方只剩提交回调、编辑会话形态与各自 input 样式 */
export function useInlineRename({
  title,
  onCommit,
  onSettle,
  session,
  selectOnFocus = false,
}: UseInlineRenameOptions): UseInlineRenameResult {
  // toggle 模式的当前编辑开关（persistent 恒 false，不经上升沿/哨兵重置路径）
  const toggleActive = session.kind === "toggle" && session.active;
  const [draft, setDraft] = useState(title);
  const [error, setError] = useState<string | null>(null);
  // 渲染期调整态基准：toggle 记上次编辑开关、persistent 记已同步的外部标题（React 调整态模式，不用 effect）
  const [seenActive, setSeenActive] = useState(toggleActive);
  const [syncedTitle, setSyncedTitle] = useState(title);
  // 竞态哨兵：一次编辑会话只 settle（提交或还原）一次——Enter 直接提交后残余 blur、unmount 前 blur、Esc 还原后 blur 不再重复提交
  const settledRef = useRef(false);

  if (session.kind === "toggle" && seenActive !== toggleActive) {
    // active 上升沿：新编辑会话以外部值为草稿并清错误（下降沿无操作；挂载即编辑时经 useState 初值等价成立）
    setSeenActive(toggleActive);
    if (toggleActive) {
      setDraft(title);
      setError(null);
    }
  }
  if (session.kind === "persistent" && syncedTitle !== title) {
    // 常驻输入：外部标题变化（rename 回流/再水化）持续同步回草稿
    setSyncedTitle(title);
    setDraft(title);
  }
  // 哨兵在 active 上升沿的 effect 中重置（React 保证 passive effects 先于下一离散事件处理，渲染期不写 ref）
  useEffect(() => {
    if (toggleActive) settledRef.current = false;
  }, [toggleActive]);

  /** 提交：空白/未变不落（恢复外部值显示 + settle 收尾），否则 onCommit——失败回滚外部值 + 错误槽，成功清错误 */
  const commit = (): void => {
    if (settledRef.current) return;
    settledRef.current = true;
    const next = draft.trim();
    if (!next || next === title) {
      setDraft(title);
      onSettle?.();
      return;
    }
    void onCommit(next).then((err) => {
      if (err) {
        setDraft(title); // store 未变（提交失败），显式回滚外部值
        setError(err);
      } else {
        setError(null);
      }
      onSettle?.();
    });
  };

  /** Esc 还原：放弃草稿回外部值并 settle（不经 blur 提交，避免草稿被当作提交内容） */
  const cancel = (): void => {
    if (settledRef.current) return;
    settledRef.current = true;
    setDraft(title);
    onSettle?.();
  };

  /** 草稿更新：persistent 模式新输入即新意图，解除 settle 哨兵（toggle 模式哨兵只随会话边界重置，提交进行中不再受理） */
  const onChange = (value: string): void => {
    if (session.kind === "persistent") settledRef.current = false;
    setDraft(value);
  };

  /** 聚焦：persistent 模式开新编辑会话（重置哨兵）；selectOnFocus 全选便于覆盖输入 */
  const onFocus = (event: FocusEvent<HTMLInputElement>): void => {
    if (session.kind === "persistent") settledRef.current = false;
    if (selectOnFocus) event.target.select();
  };

  return { draft, error, onChange, commit, cancel, onFocus };
}
