// 用途：Fake 摘要标题固定值（#95 / ADR 0003 决策 3）—— 与 packages/cli-host 的 FAKE_SUMMARIZED_TITLE 同值的 e2e 断言锚点；首轮 turn 结束（idle）后侧栏标题由首条派生翻转为该值（session:event 推送驱动）
export const FAKE_SUMMARY_TITLE = "演示会话 · 首轮摘要";
