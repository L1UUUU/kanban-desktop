// 用途：可关闭浮层交互 hook（issue #83 / spec #82）—— 自持 open 状态 + 容器 ref，展开期间统一挂 document 关闭监听（外部按下 + Escape）；权限档位菜单（PermChip）与模型下拉（ModelCombobox）共享同一关闭逻辑，避免两套并行实现
import { useEffect, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";

export interface ClosableOverlay {
  /** 浮层是否展开（组件自持；选档/点触发键等业务关闭方直接 setOpen(false)） */
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  /** 浮层容器 ref：挂在包裹触发键与浮层的根元素上，容器内按下不视为外部点击 */
  rootRef: RefObject<HTMLElement | null>;
}

/**
 * 可关闭浮层：open=true 期间监听 document mousedown（按下目标不在容器内即关闭）与 keydown Escape。
 * onExternalClose 仅在外部点击/Esc 这两条关闭路径回调（如 ModelCombobox 放弃未确认的过滤输入）；业务自身 setOpen(false) 不触发。
 */
export function useClosableOverlay<T extends HTMLElement = HTMLElement>(onExternalClose?: () => void): ClosableOverlay {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<T | null>(null);
  // 最新回调 ref：调用方内联回调不引发监听重复挂卸（渲染期不写 ref，提交后 effect 内更新）
  const onExternalCloseRef = useRef(onExternalClose);
  useEffect(() => {
    onExternalCloseRef.current = onExternalClose;
  });

  useEffect(() => {
    if (!open) return;
    const close = (): void => {
      setOpen(false);
      onExternalCloseRef.current?.();
    };
    const onDocMouseDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onDocKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onDocKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onDocKeyDown);
    };
  }, [open]);

  return { open, setOpen, rootRef };
}
