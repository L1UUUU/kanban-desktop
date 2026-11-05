// 用途：终端面板宿主（自旧 Kanban TerminalPanel.tsx 演进，PoC 6 实证 0 diff 基础）—— 按 terminalId 把 manager 的持久 xterm 元素搬入容器；卸载仅 detach 不销毁（切换/关标签不停止 CLI）；ResizeObserver/窗口 resize → fit；cancelled 守卫沿用旧版 rAF 竞态修复
import { useEffect, useRef } from "react";
import type { TerminalManager } from "./TerminalManager";

export function TerminalPanel({ terminalId, manager }: { terminalId: string; manager: TerminalManager }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // 挂载后迟到的 resize 回调不落入已卸载状态（旧 Kanban StrictMode 双挂载竞态守卫；属性翻转而非变量重赋值）
    const state = { cancelled: false };

    manager.attach(terminalId, container);

    const resize = () => {
      if (!state.cancelled) manager.fit(terminalId);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    window.addEventListener("resize", resize);
    // 初始尺寸同步（best-effort）
    queueMicrotask(resize);

    return () => {
      state.cancelled = true;
      window.removeEventListener("resize", resize);
      ro.disconnect();
      manager.detach(terminalId);
    };
  }, [terminalId, manager]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        minHeight: 320,
        background: "#0b0d12",
        padding: 10,
        boxSizing: "border-box",
      }}
    />
  );
}
