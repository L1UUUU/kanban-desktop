// 用途：useClosableOverlay 密封测试（A 类，issue #83 / spec #82）—— 可关闭浮层三分支：外部点击关闭 / Esc 关闭 / 容器内交互不触发外部关闭（业务关闭走 setOpen）
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useClosableOverlay } from "./use-closable-overlay";

/** 宿主组件：最小浮层形态（触发键 toggle + 条件渲染面板），只经 hook 公开面驱动 */
function Harness({ onExternalClose }: { onExternalClose?: () => void }) {
  const { open, setOpen, rootRef } = useClosableOverlay<HTMLSpanElement>(onExternalClose);
  return (
    <div>
      <span data-testid="outside">外部区域</span>
      <span ref={rootRef}>
        <button type="button" onClick={() => setOpen((v) => !v)}>
          触发
        </button>
        {open ? <span data-testid="panel">面板</span> : null}
      </span>
    </div>
  );
}

afterEach(cleanup);

describe("useClosableOverlay（外部点击 / Esc / 内部交互三分支）", () => {
  it("外部点击：展开时按下容器外元素即关闭，并回调 onExternalClose", () => {
    const onExternalClose = vi.fn();
    render(<Harness onExternalClose={onExternalClose} />);
    fireEvent.click(screen.getByRole("button", { name: "触发" }));
    expect(screen.getByTestId("panel")).toBeTruthy();

    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByTestId("panel")).toBeNull();
    expect(onExternalClose).toHaveBeenCalledTimes(1);
  });

  it("Esc：展开时按 Escape 即关闭，并回调 onExternalClose", () => {
    const onExternalClose = vi.fn();
    render(<Harness onExternalClose={onExternalClose} />);
    fireEvent.click(screen.getByRole("button", { name: "触发" }));
    expect(screen.getByTestId("panel")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("panel")).toBeNull();
    expect(onExternalClose).toHaveBeenCalledTimes(1);
  });

  it("内部交互：容器内按下不视为外部点击（保持展开）；触发键再点经业务 setOpen 关闭且不回调 onExternalClose", () => {
    const onExternalClose = vi.fn();
    render(<Harness onExternalClose={onExternalClose} />);
    const trigger = screen.getByRole("button", { name: "触发" });
    fireEvent.click(trigger);
    expect(screen.getByTestId("panel")).toBeTruthy();

    // 容器内 mousedown（面板/触发键上）：不触发外部关闭
    fireEvent.mouseDown(screen.getByTestId("panel"));
    fireEvent.mouseDown(trigger);
    expect(screen.getByTestId("panel")).toBeTruthy();
    expect(onExternalClose).not.toHaveBeenCalled();

    // 再次点击触发键：toggle 关闭（业务关闭路径，不走 onExternalClose）
    fireEvent.click(trigger);
    expect(screen.queryByTestId("panel")).toBeNull();
    expect(onExternalClose).not.toHaveBeenCalled();
  });
});
