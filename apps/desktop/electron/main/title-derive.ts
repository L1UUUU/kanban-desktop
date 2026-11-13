// 用途：会话标题截断 fallback 派生纯函数（#94 / ADR 0003 决策 2）—— 去首尾空白、压连续空白、按 Unicode 码点截 24 加省略号（Array.from 迭代码点，增补平面 emoji 不截半）
/** 派生标题最大码点数（ADR 0003：按 Unicode 码点截 24） */
export const TITLE_MAX_CODE_POINTS = 24;

/** 首条 user 消息文本 → 派生标题（纯函数；纯空白输入返回空串，由调用方回退默认标题） */
export function deriveTitle(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  const chars = Array.from(collapsed);
  if (chars.length <= TITLE_MAX_CODE_POINTS) return collapsed;
  return `${chars.slice(0, TITLE_MAX_CODE_POINTS).join("")}…`;
}
