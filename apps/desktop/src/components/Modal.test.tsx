// 用途：Modal 弹层骨架密封测试（arch D12）—— 关闭语义三态（无条件关 / busy 暂禁 / closeOnOverlay=false 遮罩不响应）+ 内容点击不穿透（stopPropagation）+ role/aria-modal 与遮罩/容器 testid 透传
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal, type ModalProps } from "./Modal";

/** 挂载弹层骨架（absolute + 无条件关缺省口径；props 覆盖），返回 onClose spy */
function mountModal(props: Partial<ModalProps> = {}) {
  const onClose = vi.fn();
  render(
    <Modal
      variant="absolute"
      closeOnOverlay
      onClose={onClose}
      maskTestId="test-mask"
      dialogTestId="test-dialog"
      dialogClassName="w-[460px] max-w-full"
      {...props}
    >
      <p>弹层内容</p>
    </Modal>,
  );
  return { onClose };
}

afterEach(cleanup);

describe("Modal（arch D12：弹层骨架与关闭语义单源）", () => {
  it("无条件关：点遮罩即 onClose；内容点击不穿透；role=dialog + aria-modal + testid 透传", () => {
    const { onClose } = mountModal();
    const dialog = screen.getByTestId("test-dialog");
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByTestId("test-mask")).not.toBeNull();
    expect(screen.getByText("弹层内容")).not.toBeNull();
    // 内容点击被容器拦截（stopPropagation），不触发关闭
    fireEvent.click(screen.getByText("弹层内容"));
    expect(onClose).not.toHaveBeenCalled();
    // 遮罩点击关闭
    fireEvent.click(screen.getByTestId("test-mask"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("busy 暂禁：busy=true 时点遮罩不关闭（保存中防误触，知识/总结编辑弹层口径）", () => {
    const { onClose } = mountModal({ busy: true });
    fireEvent.click(screen.getByTestId("test-mask"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closeOnOverlay=false：遮罩完全不响应（删除会话确认/设置面板口径）", () => {
    const { onClose } = mountModal({ closeOnOverlay: false });
    fireEvent.click(screen.getByTestId("test-mask"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
