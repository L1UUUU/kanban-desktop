// 用途：memory 审核域业务拒绝类型化错误（arch D7）—— 审核流转规则的唯一拒绝载体：store/summary 层规则不满足时抛出（reason 码 + detail 文案单源），service 层据此映射 wire 方言，业务拒绝不再以未类型化异常漏出
/** 审核域业务拒绝码（与 memory:ipc wire reason 逐字对齐；store/summary 新增守卫时同步补码） */
export type MemoryRejectionReason =
  | "candidate-not-found"
  | "candidate-final"
  | "edit-empty"
  | "candidate-not-editable"
  | "no-proposed"
  | "no-summary";

/** 类型化业务拒绝（Error 子类）：reason 即 wire reason 码，message 即 wire detail 文案 */
export class MemoryRejectionError extends Error {
  constructor(readonly reason: MemoryRejectionReason, detail: string) {
    super(detail);
    this.name = "MemoryRejectionError";
  }
}
