// 用途：模型选择 combobox（issue #77 / spec #75，替代旧 ModelSelect 硬编码下拉）—— 输入框 + 自定义下拉（形态对齐权限 chip）：就绪（isDefault 项带「默认」角标）/ 过滤（displayName·id 不分大小写）/ 加载中（只读提示）/ 拉取失败（原因行 + 手输 id 兜底）四状态；挂载即经模型目录预取；原型 docs/prototypes/model-combobox.prototype.html 五状态为一致项
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { CliKind } from "@kanban/ipc-schema";
import { findDefaultModel, type ModelCatalog, type ModelsState } from "../model-catalog";
import { useClosableOverlay } from "./use-closable-overlay";

/** 目录状态订阅 + 挂载预取（草稿面板与已建会话 composer 挂载即拉取；StrictMode 双挂载经目录 in-flight 去重只发一次） */
export function useModelsState(catalog: ModelCatalog, cli: CliKind, cwd: string | null): ModelsState {
  const subscribe = useCallback((listener: () => void) => catalog.subscribe(cli, listener), [catalog, cli]);
  const getSnapshot = useCallback(() => catalog.getState(cli), [catalog, cli]);
  const state = useSyncExternalStore(subscribe, getSnapshot);
  useEffect(() => {
    if (cwd) catalog.prefetch(cli, cwd);
  }, [catalog, cli, cwd]);
  return state;
}

/** 非编辑态显示值：选中项 displayName / 列表外原始 id / 模型为空取默认项名（恢复会话派生显示）/ 加载中提示 */
function deriveDisplay(state: ModelsState, value: string | undefined): string {
  if (state.status === "loading" || state.status === "idle") return "模型列表加载中…";
  if (state.status === "error") return value ?? "";
  if (value !== undefined) {
    const entry = state.models.find((m) => m.id === value);
    return entry ? entry.displayName : value; // 不在列表（手输）：展示原始 id，下发原样
  }
  const def = findDefaultModel(state.models);
  return def ? def.displayName : "";
}

/** 过滤匹配：displayName / id 包含（不分大小写）；空白查询视为不过滤 */
function matchesQuery(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.trim().toLowerCase());
}

export interface ModelComboboxProps {
  cli: CliKind;
  /** 预取用工作目录（opencode 按项目拉起 server；草稿必有，事件先至占位会话可短暂为 null——null 不预取） */
  cwd: string | null;
  /** 当前选中模型 id（undefined = 未选择/未就绪；恢复会话为 undefined 时仅派生显示默认名） */
  value: string | undefined;
  onChange(model: string): void;
  catalog: ModelCatalog;
  /** 就绪后未选中时自动选中 isDefault 项（草稿面板 true；已建会话 composer false——不写会话 store） */
  autoSelectDefault?: boolean;
  /** #79：禁用（turn 进行中/审批待决）——只读不展开（main 侧同语义校验兜底） */
  disabled?: boolean;
}

/** 模型选择 combobox：输入框（role=combobox）+ 自定义下拉；加载与错误态不提供「默认/自选」逃生项 */
export function ModelCombobox({ cli, cwd, value, onChange, catalog, autoSelectDefault = false, disabled = false }: ModelComboboxProps) {
  const state = useModelsState(catalog, cli, cwd);
  // 编辑查询（null = 非编辑态，输入框显示派生值）；输入或收起时切换
  const [query, setQuery] = useState<string | null>(null);
  // 可关闭浮层（#83 与权限菜单共享同一 hook）：外部点击/Esc 收起并放弃未确认的过滤输入
  const { open, setOpen, rootRef } = useClosableOverlay<HTMLSpanElement>(() => setQuery(null));

  // 就绪后默认选中（草稿语义：经 onChange 写回 store；无默认项不强制——用户自选或手输）
  useEffect(() => {
    if (!autoSelectDefault || state.status !== "ready" || value !== undefined) return;
    const def = findDefaultModel(state.models);
    if (def) onChange(def.id);
  }, [autoSelectDefault, state, value, onChange]);

  const loading = state.status === "loading" || state.status === "idle";
  const models = state.status === "ready" ? state.models : [];
  const effectiveQuery = query === null ? "" : query.trim();
  const filtered = query === null ? models : models.filter((m) => matchesQuery(m.displayName, effectiveQuery) || matchesQuery(m.id, effectiveQuery));

  const commit = (model: string): void => {
    onChange(model);
    setOpen(false);
    setQuery(null);
  };

  return (
    <span ref={rootRef} className="relative inline-flex">
      <input
        role="combobox"
        aria-label="模型选择"
        aria-expanded={open}
        aria-haspopup="listbox"
        readOnly={loading || disabled}
        value={query ?? deriveDisplay(state, value)}
        title={value ?? undefined}
        onFocus={() => {
          if (!loading && !disabled) setOpen(true);
        }}
        onChange={(e) => {
          if (loading || disabled) return;
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          // Esc 收起由共享 useClosableOverlay 统一处理（#83）；此处只管 Enter 手输提交
          if (e.key === "Enter" && query !== null && effectiveQuery.length > 0) commit(effectiveQuery);
        }}
        className={`h-7 w-[190px] rounded-full border bg-transparent pl-3 pr-7 text-xs text-muted-foreground outline-none focus:border-primary focus:text-foreground ${
          disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-primary hover:text-foreground"
        } ${state.status === "error" ? "border-warn/60" : "border-border"}`}
      />
      <span className="pointer-events-none absolute right-2.5 self-center text-[10px] text-muted-foreground">▾</span>
      {open ? (
        <div
          role="listbox"
          aria-label="模型列表"
          className="absolute bottom-full left-0 z-10 mb-1 max-h-[240px] min-w-[300px] overflow-y-auto rounded-lg border border-border bg-muted p-1 shadow-[0_8px_24px_rgba(0,0,0,.5)]"
        >
          {state.status === "error" ? (
            // 拉取失败：原因行 + 手输指引（无「默认/自选」逃生项）
            <>
              <span className="block px-2.5 py-1.5 text-[11.5px] text-warn">模型列表获取失败：{state.message}</span>
              <span className="block px-2.5 py-1.5 text-[11.5px] text-muted-foreground">手动输入模型 id 后回车</span>
            </>
          ) : (
            <>
              {filtered.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={m.id === value}
                  className="block w-full rounded-md px-2.5 py-1.5 text-left hover:bg-card"
                  onClick={() => commit(m.id)}
                >
                  <span className="block text-[13px] font-semibold">
                    {m.displayName}
                    {m.isDefault ? <span className="ml-1.5 rounded-full border border-ok/40 px-1.5 text-[10.5px] font-normal text-ok">默认</span> : null}
                  </span>
                  <span className="block font-mono text-[11px] text-muted-foreground">{m.id}</span>
                </button>
              ))}
              {query === null ? (
                <span className="block px-2.5 py-1.5 text-[11.5px] text-muted-foreground">未在列表中？直接输入模型 id</span>
              ) : (
                <span className="block px-2.5 py-1.5 text-[11.5px] text-muted-foreground">匹配 {filtered.length} 项 · 回车使用输入内容</span>
              )}
            </>
          )}
        </div>
      ) : null}
    </span>
  );
}
