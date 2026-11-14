// 用途：transport 缺席/桥接调用失败的统一错误载体（arch D10，自 chat 域 transportUnavailable 泛化）——
// 各域控制器「无 transport / invoke 抛出」的用户可见兜底共用同一 {code,message} 形（code 恒 E_INTERNAL，
// 可满足 IpcResult.error / ChatActionError 等既有错误形态）；message 由各域传入，服务名差异合法（统一载体，不统一文案）
export function transportUnavailableError(message: string): { code: "E_INTERNAL"; message: string } {
  return { code: "E_INTERNAL", message };
}
