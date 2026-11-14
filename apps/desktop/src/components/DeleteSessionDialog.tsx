// 用途：删除会话二次确认弹窗（#62 spec #57 / 原型 stage5 演示②）—— 说明影响与不可撤销；侧栏与设置面板已归档列表（#63）复用同款；arch D12 起遮罩/容器骨架走共享 Modal（fixed 变体，遮罩不响应点击，仅经取消/删除按钮关闭）
import { Modal } from "./Modal";

export function DeleteSessionDialog({ title, onConfirm, onCancel }: { title: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Modal
      variant="fixed"
      closeOnOverlay={false}
      onClose={onCancel}
      maskTestId="delete-session-overlay"
      dialogTestId="delete-session-dialog"
      dialogClassName="w-[min(420px,88%)]"
    >
      <div className="border-b border-border px-4 py-3 text-sm font-semibold">删除会话</div>
      <div className="px-4 py-3">
        <p className="text-[13px]">确定删除『{title}』吗？</p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          将终止该会话的 CLI 进程、移除本地会话记录与看板关联，并切换当前激活会话。CLI 原生历史文件不删除。此操作不可撤销。
        </p>
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
          onClick={onCancel}
        >
          取消
        </button>
        <button
          type="button"
          data-testid="delete-session-confirm"
          className="rounded-md bg-destructive px-3 py-1 text-xs text-white hover:opacity-90"
          onClick={onConfirm}
        >
          删除
        </button>
      </div>
    </Modal>
  );
}
