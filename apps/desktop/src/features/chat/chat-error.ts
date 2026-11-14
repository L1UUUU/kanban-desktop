// 用途：会话域统一错误回流（arch C7）—— renderer 侧 invoke 失败（ok:false 的 error 或抛出的异常）单轨归一为
// ChatActionError {code,message}，经同一出口落到对应错误槽（会话错误槽 store.setError=ErrorBanner /
// 草稿错误槽 store.setDraftSubmitError=CreateErrorCard）；行内提示（重命名）复用同一错误表示，仅展示位置不同。
// 归档行不在 ChatStore，use-archived-sessions 自持错误面是合理设计，仅对齐错误表示、不经此出口写 store。
import type { IpcResult } from "@kanban/ipc-schema";
import type { ChatStore } from "./chat-store";
import type { ChatActionError } from "./session-view";

/** transport 缺席兜底（arch C7：use-chat 内三处同款字面量归一）：统一 E_INTERNAL「transport 不可用」（code 为字面量类型，可直接满足各 IpcResult 错误形态） */
export function transportUnavailable(): { code: "E_INTERNAL"; message: string } {
  return { code: "E_INTERNAL", message: "transport 不可用" };
}

/** 失败归一：形如 {code,message} 的 IPC 错误载荷（含派发 blocked 动作）取原值；其余（invoke 抛出的异常等）兜底 E_INTERNAL + message 原文（不静默） */
export function toActionError(failure: unknown): ChatActionError {
  if (
    typeof failure === "object" &&
    failure !== null &&
    typeof (failure as { code?: unknown }).code === "string" &&
    typeof (failure as { message?: unknown }).message === "string"
  ) {
    return { code: (failure as { code: string }).code, message: (failure as { message: string }).message };
  }
  return { code: "E_INTERNAL", message: failure instanceof Error ? failure.message : String(failure) };
}

/** 会话错误槽出口：归一失败 → store.setError（ErrorBanner 数据源；结构化守卫在 store 内）；返回归一错误供调用方留痕 */
export function exitSessionError(store: ChatStore, sessionId: string, failure: unknown): ChatActionError {
  const error = toActionError(failure);
  store.setError(sessionId, error);
  return error;
}

/** 草稿错误槽出口：归一失败 → store.setDraftSubmitError（CreateErrorCard 数据源；草稿与输入保留可重试）；返回归一错误供留痕 */
export function exitDraftError(store: ChatStore, failure: unknown): ChatActionError {
  const error = toActionError(failure);
  store.setDraftSubmitError(error);
  return error;
}

/** fire-and-forget 会话 invoke 失败回流（中断/审批决议等无返回值动作）：!ok 或异常统一落会话错误槽（成功静默） */
export function settleSessionInvoke(store: ChatStore, sessionId: string, invoke: Promise<IpcResult>): void {
  void invoke
    .then((r) => {
      if (!r.ok) exitSessionError(store, sessionId, r.error);
    })
    .catch((err: unknown) => exitSessionError(store, sessionId, err));
}
