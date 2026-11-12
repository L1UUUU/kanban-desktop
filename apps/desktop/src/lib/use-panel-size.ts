// 用途：面板尺寸拖拽手势 hook（#85）—— 指针捕获 + rAF 帧合并预览 + Esc/pointercancel/丢捕获回滚 + 双击复位 + 键盘步进（Shift 加倍、Home/End 到边界）+ localStorage 持久化；约束计算与常量见 panel-resize.ts（纯函数）
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import {
  clampPanelSize,
  COMPOSER_DEFAULT_HEIGHT,
  composerHeightBounds,
  loadPanelSize,
  PANEL_SIZE_KEYS,
  type PanelBounds,
} from "./panel-resize";

/** hook 入参：持久化 key、轴向、位移符号、当前边界（含视口联动）、默认值、把手无障碍名 */
export interface UsePanelSizeOptions {
  storageKey: string;
  /** x=水平（宽度，把手纵向分隔），y=垂直（高度，把手横向分隔） */
  axis: "x" | "y";
  /** 指针位移 → 尺寸增量符号：+1 正向=加大（侧栏向右拖加宽）；-1 负向=加大（输入框向上拖增高） */
  sign: 1 | -1;
  bounds: PanelBounds;
  defaultSize: number;
  ariaLabel: string;
  /** 键盘步进像素（Shift 加倍），默认 16 */
  step?: number;
}

/** 把手展开 props：事件全套 + separator 角色无障碍属性 */
export interface PanelHandleProps {
  role: "separator";
  tabIndex: 0;
  "aria-orientation": "vertical" | "horizontal";
  "aria-label": string;
  "aria-valuemin": number;
  "aria-valuemax": number;
  "aria-valuenow": number;
  onPointerDown(e: PointerEvent<HTMLDivElement>): void;
  onPointerMove(e: PointerEvent<HTMLDivElement>): void;
  onPointerUp(e: PointerEvent<HTMLDivElement>): void;
  onPointerCancel(e: PointerEvent<HTMLDivElement>): void;
  onLostPointerCapture(e: PointerEvent<HTMLDivElement>): void;
  onKeyDown(e: KeyboardEvent<HTMLDivElement>): void;
  onDoubleClick(e: MouseEvent<HTMLDivElement>): void;
}

/** 手势进行态（ref 持有，拖拽中不触发重渲染以外的状态写入） */
interface Gesture {
  pointerId: number;
  /** 手势锚定起点的指针坐标（轴向分量）——数学永远锚定起点，杜绝增量累加漂移 */
  startClient: number;
  /** 手势锚定起点尺寸 */
  startSize: number;
  /** 最新计算尺寸（rAF 帧载荷） */
  size: number;
  /** rAF 句柄（非 null 时不再调度新帧） */
  frame: number | null;
}

export interface PanelSizeController {
  /** 当前生效尺寸：拖拽预览优先，否则已提交偏好；按当前边界夹取（视口收缩即时反映，不改写偏好） */
  size: number;
  /** 拖拽进行中（外层可加禁过渡/禁选中样式） */
  dragging: boolean;
  handleProps: PanelHandleProps;
}

/**
 * 单尺寸面板拖拽控制器。提交路径（pointerUp/键盘/双击）写 state + localStorage；
 * 取消路径（Esc/pointercancel/lostpointercapture）只清预览不写——宽度自动回到已提交值。
 */
export function usePanelSize(options: UsePanelSizeOptions): PanelSizeController {
  const { storageKey, axis, sign, bounds, defaultSize, ariaLabel } = options;
  const step = options.step ?? 16;

  // 最新边界走 ref：手势回调闭包不过期（渲染期不可写 ref，effect 内同步）
  const boundsRef = useRef(bounds);
  useEffect(() => {
    boundsRef.current = bounds;
  }, [bounds]);

  // 已提交偏好（原始值）；初始读持久化（非法/缺失回落默认，越界按当前边界夹取）
  const [committed, setCommitted] = useState(() =>
    loadPanelSize(typeof window === "undefined" ? null : window.localStorage, storageKey, bounds, defaultSize),
  );
  // 拖拽预览尺寸（null=非拖拽态）
  const [preview, setPreview] = useState<number | null>(null);
  const gestureRef = useRef<Gesture | null>(null);

  // 卸载清理：取消未完结手势的挂起帧（不写任何状态）
  useEffect(() => {
    const gesture = gestureRef;
    return () => {
      const g = gesture.current;
      if (g && g.frame !== null) cancelAnimationFrame(g.frame);
      gesture.current = null;
    };
  }, []);

  const currentSize = clampPanelSize(preview ?? committed, bounds.min, bounds.max);

  // 提交：写偏好 + 持久化（best-effort，写失败不影响交互）
  const commit = (value: number): void => {
    const clamped = clampPanelSize(value, boundsRef.current.min, boundsRef.current.max);
    setCommitted(clamped);
    try {
      window.localStorage.setItem(storageKey, String(Math.round(clamped)));
    } catch {
      // 存储不可用：仅会话内生效
    }
  };

  // 收尾：清手势与预览；cancelled=true 回滚（不提交），false 且尺寸有变才提交
  const finishGesture = (cancelled: boolean): void => {
    const g = gestureRef.current;
    if (!g) return;
    if (g.frame !== null) cancelAnimationFrame(g.frame);
    gestureRef.current = null;
    setPreview(null);
    if (!cancelled && g.size !== g.startSize) commit(g.size);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || gestureRef.current) return; // 仅主键；已有手势不被第二指针覆盖
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    const startSize = clampPanelSize(committed, boundsRef.current.min, boundsRef.current.max);
    gestureRef.current = {
      pointerId: e.pointerId,
      startClient: axis === "x" ? e.clientX : e.clientY,
      startSize,
      size: startSize,
      frame: null,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // 捕获不可用（jsdom/已失效指针）：预览与提交仍可用，丢捕获路径照常兜底
    }
    setPreview(startSize); // 进入预览态（dragging=true）
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const g = gestureRef.current;
    if (!g || e.pointerId !== g.pointerId) return;
    const client = axis === "x" ? e.clientX : e.clientY;
    const b = boundsRef.current;
    g.size = clampPanelSize(g.startSize + (client - g.startClient) * sign, b.min, b.max);
    if (g.frame !== null) return; // 帧合并：挂起帧存在则只更新载荷
    g.frame = requestAnimationFrame(() => {
      g.frame = null;
      if (gestureRef.current === g) setPreview(g.size);
    });
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (gestureRef.current?.pointerId !== e.pointerId) return;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // jsdom 无实现：跳过（提交仍继续）
    }
    finishGesture(false);
  };

  const onPointerCancel = (e: PointerEvent<HTMLDivElement>): void => {
    if (gestureRef.current?.pointerId !== e.pointerId) return;
    finishGesture(true);
  };

  // 丢捕获 = 取消（系统手势接管等）；pointerUp 提交后手势已清，此分支自然 no-op
  const onLostPointerCapture = (e: PointerEvent<HTMLDivElement>): void => {
    if (gestureRef.current?.pointerId !== e.pointerId) return;
    finishGesture(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Esc 仅在拖拽中回滚；非拖拽态放行默认行为
    if (e.key === "Escape") {
      if (gestureRef.current) {
        e.preventDefault();
        finishGesture(true);
      }
      return;
    }
    const b = boundsRef.current;
    const effective = clampPanelSize(committed, b.min, b.max);
    const delta = step * (e.shiftKey ? 2 : 1);
    let next: number | null = null;
    if (e.key === "Home") next = b.min;
    else if (e.key === "End") next = b.max;
    else if (axis === "x") {
      if (e.key === "ArrowRight") next = effective + delta;
      else if (e.key === "ArrowLeft") next = effective - delta;
    } else {
      if (e.key === "ArrowUp") next = effective + delta;
      else if (e.key === "ArrowDown") next = effective - delta;
    }
    if (next === null) return;
    e.preventDefault();
    const target = clampPanelSize(next, b.min, b.max);
    if (target !== effective) commit(target); // “按了但没动”（已在边界）不重写偏好
  };

  const onDoubleClick = (): void => {
    // 复位前强制取消未完结手势（第二指针不得覆盖复位）
    if (gestureRef.current) finishGesture(true);
    const b = boundsRef.current;
    const target = clampPanelSize(defaultSize, b.min, b.max);
    if (target !== clampPanelSize(committed, b.min, b.max)) commit(target);
  };

  return {
    size: currentSize,
    dragging: preview !== null,
    handleProps: {
      role: "separator",
      tabIndex: 0,
      "aria-orientation": axis === "x" ? "vertical" : "horizontal",
      "aria-label": ariaLabel,
      "aria-valuemin": bounds.min,
      "aria-valuemax": bounds.max,
      "aria-valuenow": Math.round(currentSize),
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture,
      onKeyDown,
      onDoubleClick,
    },
  };
}

/** 窗口视口尺寸（resize 监听）；面板边界视口联动的数据源 */
export function useViewportSize(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const onResize = (): void => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/** 输入框高度控制器（#85）：会话 Composer 与草稿 DraftPane 共用（同一持久化 key → 两态联动为预期行为）；上拖增高（sign=-1），上限随视口高联动 */
export function useComposerPanelHeight(): PanelSizeController {
  const viewport = useViewportSize();
  return usePanelSize({
    storageKey: PANEL_SIZE_KEYS.composerHeight,
    axis: "y",
    sign: -1,
    bounds: composerHeightBounds(viewport.height),
    defaultSize: COMPOSER_DEFAULT_HEIGHT,
    ariaLabel: "拖拽调整输入框高度",
  });
}
