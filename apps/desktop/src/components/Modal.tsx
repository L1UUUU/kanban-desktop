// 用途：共享模态弹层骨架（arch D12）—— 全仓「遮罩 + dialog 容器 + 点击穿透隔离 + aria-modal」的单一实现，关闭语义经参数显式声明：closeOnOverlay（遮罩点击是否允许关）+ busy（忙态暂禁遮罩关闭，防误触丢草稿）；定位两变体：absolute（挂看板/记忆区 relative 容器，z-30、遮罩 black/60、容器 rounded-xl p-4）与 fixed（全局遮罩 z-50、black/55、容器 rounded-[14px]、内边距归内容分区自带）；现行各弹层均无 Esc 关闭，本组件不引入（如需统一属新增可观察行为，另行决策）
import type { ReactNode } from "react";

export interface ModalProps {
  /** 定位变体：absolute=挂载于 relative 父容器（看板/记忆区内弹层现行形态）；fixed=全局遮罩（删除会话确认/设置面板现行形态） */
  variant: "absolute" | "fixed";
  /** 遮罩点击是否允许关闭：true=点击即关（busy=true 时暂禁）；false=遮罩完全不响应，仅经内容按钮关闭 */
  closeOnOverlay: boolean;
  /** 关闭回调（遮罩点击在允许且非 busy 时触发；内容内取消/完成按钮由内容自接） */
  onClose(): void;
  /** 忙态（如保存中）：true 时遮罩点击暂不关闭 */
  busy?: boolean;
  /** 遮罩 data-testid（既有组件/e2e 测试定位点随迁移保持） */
  maskTestId: string;
  /** dialog 容器 data-testid */
  dialogTestId: string;
  /** 容器附加类：宽度/高度上限/滚动/布局差异由消费方声明（如 w-[460px] max-w-full、max-h-[80%] overflow-y-auto、flex flex-col） */
  dialogClassName: string;
  /** 弹层内容（标题/表单/动作按钮由消费方组织） */
  children: ReactNode;
}

/** 共享模态弹层骨架：只管遮罩/容器/关闭语义与 aria，不管内容 */
export function Modal({ variant, closeOnOverlay, onClose, busy = false, maskTestId, dialogTestId, dialogClassName, children }: ModalProps) {
  // 两变体差异集于此：定位、遮罩浓度、容器圆角与内边距（fixed 家族容器不带 p-4，内边距由内容分区自带）
  const maskClassName =
    variant === "fixed"
      ? "fixed inset-0 z-50 flex items-center justify-center bg-black/55"
      : "absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-4";
  const dialogBaseClassName =
    variant === "fixed" ? "rounded-[14px] border border-border bg-card shadow-2xl" : "rounded-xl border border-border bg-card p-4 shadow-2xl";
  return (
    <div
      data-testid={maskTestId}
      className={maskClassName}
      // closeOnOverlay=false 不挂 onClick：遮罩完全不响应（与迁移前删除会话确认/设置面板形态一致）
      onClick={closeOnOverlay ? () => (busy ? undefined : onClose()) : undefined}
    >
      <div
        role="dialog"
        aria-modal="true"
        data-testid={dialogTestId}
        className={`${dialogBaseClassName} ${dialogClassName}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
