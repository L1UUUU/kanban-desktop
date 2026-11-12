// 用途：usePanelSize 拖拽手势密封测试（#85）—— 指针序列（捕获/锚定/帧合并/提交）、Esc/pointercancel/lostpointercapture 回滚、双击复位、键盘步进与 Home/End、持久化往返、边界视口联动
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelBounds } from "./panel-resize";
import { PANEL_SIZE_KEYS } from "./panel-resize";
import { usePanelSize } from "./use-panel-size";

/** rAF 帧队列（手动冲刷，确定性驱动帧合并） */
let frames: FrameRequestCallback[] = [];
function flushFrame(): void {
  const cb = frames.shift();
  if (cb) act(() => cb(0));
}

/** 受控 harness：bounds 可热改（模拟视口变化） */
function Harness(props: { storageKey?: string; bounds?: PanelBounds; axis?: "x" | "y"; sign?: 1 | -1; defaultSize?: number }) {
  const [bounds, setBounds] = useState<PanelBounds>(props.bounds ?? { min: 180, max: 480 });
  const panel = usePanelSize({
    storageKey: props.storageKey ?? "test.panel",
    axis: props.axis ?? "x",
    sign: props.sign ?? 1,
    bounds,
    defaultSize: props.defaultSize ?? 240,
    ariaLabel: "测试把手",
  });
  return (
    <div>
      <div data-testid="size">{Math.round(panel.size)}</div>
      <div data-testid="dragging">{String(panel.dragging)}</div>
      <button data-testid="shrink" type="button" onClick={() => setBounds({ min: bounds.min, max: 320 })}>
        shrink
      </button>
      <div data-testid="handle" {...panel.handleProps} />
    </div>
  );
}

const sizeText = (): string => screen.getByTestId("size").textContent ?? "";
const draggingText = (): string => screen.getByTestId("dragging").textContent ?? "";

function dragSequence(clientXs: number[], from = 300): void {
  fireEvent.pointerDown(screen.getByTestId("handle"), { button: 0, pointerId: 1, clientX: from });
  for (const x of clientXs) fireEvent.pointerMove(screen.getByTestId("handle"), { pointerId: 1, clientX: x });
}

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    // 与生产语义一致：句柄失效（帧回调的 gesture 守卫兜底）
    void handle;
  });
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("usePanelSize 初始态与 aria", () => {
  it("无存储时取默认值；把手携带 separator 角色全套 aria", () => {
    render(<Harness />);
    expect(sizeText()).toBe("240");
    const handle = screen.getByTestId("handle");
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuemin")).toBe("180");
    expect(handle.getAttribute("aria-valuemax")).toBe("480");
    expect(handle.getAttribute("aria-valuenow")).toBe("240");
    expect(handle.getAttribute("aria-label")).toBe("测试把手");
    expect(handle.tabIndex).toBe(0);
  });

  it("存储已有合法值时初始即恢复（持久化读取）", () => {
    window.localStorage.setItem(PANEL_SIZE_KEYS.sidebarWidth, "320");
    render(<Harness storageKey={PANEL_SIZE_KEYS.sidebarWidth} />);
    expect(sizeText()).toBe("320");
  });
});

describe("usePanelSize 指针拖拽", () => {
  it("拖拽提交：预览随帧合并跟随，pointerUp 提交并持久化", () => {
    render(<Harness storageKey="test.panel" />);
    dragSequence([400]);
    expect(draggingText()).toBe("true");
    flushFrame();
    expect(sizeText()).toBe("340"); // 240 + (400-300)，数学锚定手势起点
    expect(frames.length).toBe(0);
    act(() => {
      fireEvent.pointerUp(screen.getByTestId("handle"), { pointerId: 1, clientX: 400 });
    });
    expect(sizeText()).toBe("340");
    expect(draggingText()).toBe("false");
    expect(window.localStorage.getItem("test.panel")).toBe("340");
  });

  it("帧合并：连续两次 move 只调度一帧，帧载荷取最新值（中间值丢弃）", () => {
    render(<Harness />);
    dragSequence([340, 420]);
    expect(frames.length).toBe(1); // 两 move 一帧
    flushFrame();
    expect(sizeText()).toBe("360"); // 240 + (420-300)，非中间值 280
    expect(frames.length).toBe(0);
  });

  it("拖拽越界夹到边界（max=480）", () => {
    render(<Harness />);
    dragSequence([2000]);
    flushFrame();
    expect(sizeText()).toBe("480");
    act(() => {
      fireEvent.pointerUp(screen.getByTestId("handle"), { pointerId: 1, clientX: 2000 });
    });
    expect(window.localStorage.getItem("test.panel")).toBe("480");
  });

  it("非主键 pointerDown 不进入手势", () => {
    render(<Harness />);
    fireEvent.pointerDown(screen.getByTestId("handle"), { button: 2, pointerId: 1, clientX: 300 });
    expect(draggingText()).toBe("false");
  });

  it("Esc 回滚到拖拽前尺寸且不写存储", () => {
    render(<Harness storageKey="test.panel" />);
    dragSequence([500]);
    flushFrame();
    expect(sizeText()).toBe("440");
    act(() => {
      fireEvent.keyDown(screen.getByTestId("handle"), { key: "Escape" });
    });
    expect(sizeText()).toBe("240");
    expect(draggingText()).toBe("false");
    expect(window.localStorage.getItem("test.panel")).toBeNull();
  });

  it("pointercancel 与 lostpointercapture 同样回滚（丢捕获=取消）", () => {
    render(<Harness storageKey="test.panel" />);
    dragSequence([500]);
    flushFrame();
    act(() => {
      fireEvent.pointerCancel(screen.getByTestId("handle"), { pointerId: 1 });
    });
    expect(sizeText()).toBe("240");
    expect(window.localStorage.getItem("test.panel")).toBeNull();

    // lostpointercapture 分支：浏览器丢捕获（如系统手势接管）
    dragSequence([420]);
    flushFrame();
    expect(sizeText()).toBe("360");
    act(() => {
      // 原生事件名分派（jsdom 无 PointerEvent 构造器）：手工附 pointerId 对齐手势归属
      const ev = new Event("lostpointercapture", { bubbles: true });
      Object.defineProperty(ev, "pointerId", { value: 1 });
      fireEvent(screen.getByTestId("handle"), ev);
    });
    expect(sizeText()).toBe("240");
    expect(window.localStorage.getItem("test.panel")).toBeNull();
  });

  it("双击复位到默认值并持久化", () => {
    render(<Harness storageKey="test.panel" />);
    dragSequence([400]);
    flushFrame();
    act(() => {
      fireEvent.pointerUp(screen.getByTestId("handle"), { pointerId: 1, clientX: 400 });
    });
    expect(sizeText()).toBe("340");
    act(() => {
      fireEvent.dblClick(screen.getByTestId("handle"));
    });
    expect(sizeText()).toBe("240");
    expect(window.localStorage.getItem("test.panel")).toBe("240");
  });
});

describe("usePanelSize 键盘步进", () => {
  it("方向键 ±step、Shift 加倍、Home/End 到边界，逐次持久化", () => {
    render(<Harness storageKey="test.panel" />);
    const handle = screen.getByTestId("handle");
    act(() => {
      fireEvent.keyDown(handle, { key: "ArrowRight" });
    });
    expect(sizeText()).toBe("256"); // +16
    act(() => {
      fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    });
    expect(sizeText()).toBe("288"); // +32
    act(() => {
      fireEvent.keyDown(handle, { key: "End" });
    });
    expect(sizeText()).toBe("480");
    act(() => {
      fireEvent.keyDown(handle, { key: "Home" });
    });
    expect(sizeText()).toBe("180");
    expect(window.localStorage.getItem("test.panel")).toBe("180");
  });

  it("y 轴用上下键：ArrowUp 增大", () => {
    render(<Harness axis="y" sign={-1} defaultSize={46} bounds={{ min: 46, max: 400 }} />);
    const handle = screen.getByTestId("handle");
    expect(screen.getByTestId("handle").getAttribute("aria-orientation")).toBe("horizontal");
    act(() => {
      fireEvent.keyDown(handle, { key: "ArrowUp" });
    });
    expect(sizeText()).toBe("62");
  });
});

describe("usePanelSize 视口联动与持久化往返", () => {
  it("bounds 收缩时已提交尺寸的显示值立即夹取（不改写存储偏好）", () => {
    render(<Harness storageKey="test.panel" bounds={{ min: 180, max: 480 }} />);
    const handle = screen.getByTestId("handle");
    act(() => {
      fireEvent.keyDown(handle, { key: "End" });
    });
    expect(sizeText()).toBe("480");
    expect(window.localStorage.getItem("test.panel")).toBe("480");
    act(() => {
      fireEvent.click(screen.getByTestId("shrink"));
    });
    expect(sizeText()).toBe("320"); // 显示夹取
    expect(window.localStorage.getItem("test.panel")).toBe("480"); // 偏好不被视口变化改写
    // 收缩后的拖拽按新界夹取；无实际位移的拖拽不重写偏好（起点已被夹到 320）
    dragSequence([2000]);
    flushFrame();
    expect(sizeText()).toBe("320");
    act(() => {
      fireEvent.pointerUp(screen.getByTestId("handle"), { pointerId: 1, clientX: 2000 });
    });
    expect(window.localStorage.getItem("test.panel")).toBe("480");
    // 有实际位移（从夹取后的 320 拖窄 80px）才提交并持久化
    dragSequence([220]);
    flushFrame();
    expect(sizeText()).toBe("240");
    act(() => {
      fireEvent.pointerUp(screen.getByTestId("handle"), { pointerId: 1, clientX: 220 });
    });
    expect(window.localStorage.getItem("test.panel")).toBe("240");
  });

  it("持久化往返：提交后新挂载点（同 key）读取同一偏好", () => {
    const { unmount } = render(<Harness storageKey="test.panel" />);
    dragSequence([400]);
    flushFrame();
    act(() => {
      fireEvent.pointerUp(screen.getByTestId("handle"), { pointerId: 1, clientX: 400 });
    });
    unmount();
    render(<Harness storageKey="test.panel" />);
    expect(sizeText()).toBe("340");
  });
});
