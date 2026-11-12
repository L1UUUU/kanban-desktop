// 用途：面板尺寸约束纯函数与常量（#85）—— 侧栏宽度/输入框高度的边界计算（视口联动）与 localStorage 持久化读取；零 React 依赖，供手势 hook 与组件接线消费
/** 尺寸边界对（min ≤ max 恒成立） */
export interface PanelBounds {
  min: number;
  max: number;
}

// ---- 侧栏宽度（grid 首列） ----
/** 侧栏最小宽：行内容预算（px-3.5 内边距 + 色点/标题/徽标）可完整呈现的下限 */
export const SIDEBAR_MIN_WIDTH = 180;
/** 侧栏默认宽（既有布局锚点 240px 的唯一承接常量） */
export const SIDEBAR_DEFAULT_WIDTH = 240;
/** 侧栏固定上限（宽视口下不再加宽，避免中央区被过度挤压） */
export const SIDEBAR_MAX_WIDTH = 480;
/** 中央区（聊天/看板/记忆/Diff）保留最小宽：窄窗口下侧栏让位 */
export const CHAT_MIN_WIDTH = 560;

// ---- 输入框高度（composer textarea） ----
/** 输入框最小高（与既有 min-h-[46px] 一致：两行文字实际渲染高） */
export const COMPOSER_MIN_HEIGHT = 46;
/** 输入框默认高（与既有 rows=2 视觉一致，双击复位目标） */
export const COMPOSER_DEFAULT_HEIGHT = 46;
/** 输入框上限 = 视口高 × 比例 */
export const COMPOSER_MAX_VIEWPORT_RATIO = 0.5;

// ---- 持久化 key（renderer localStorage；会话/草稿两态输入框共享同一高度偏好） ----
export const PANEL_SIZE_KEYS = {
  sidebarWidth: "kanban.panel.sidebarWidth",
  composerHeight: "kanban.panel.composerHeight",
} as const;

/** 单侧夹取：非有限数值回落下界（防御持久化脏数据，NaN 参与比较恒 false） */
export function clampPanelSize(size: number, min: number, max: number): number {
  if (!Number.isFinite(size)) return min;
  return Math.min(max, Math.max(min, size));
}

/** 侧栏宽度边界：上限 = min(固定上限, 视口宽 − 中央区最小宽)，视口极窄时上限不低于下限（边界不倒置） */
export function sidebarWidthBounds(viewportWidth: number): PanelBounds {
  const max = clampPanelSize(
    Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - CHAT_MIN_WIDTH),
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_MAX_WIDTH,
  );
  return { min: SIDEBAR_MIN_WIDTH, max };
}

/** 输入框高度边界：上限 = 视口高 × 比例向下取整，极矮视口下不低于最小值 */
export function composerHeightBounds(viewportHeight: number): PanelBounds {
  const max = Math.max(COMPOSER_MIN_HEIGHT, Math.floor(viewportHeight * COMPOSER_MAX_VIEWPORT_RATIO));
  return { min: COMPOSER_MIN_HEIGHT, max };
}

/**
 * 读取持久化尺寸：合法数字按当前边界夹取返回；缺失/非数字/部分数字回落默认值。
 * 只读不写（写入由手势 hook 在提交时进行）；storage 不可用（null）同样回落默认。
 */
export function loadPanelSize(
  storage: Pick<Storage, "getItem"> | null,
  key: string,
  bounds: PanelBounds,
  fallback: number,
): number {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(key) ?? null;
  } catch {
    return fallback; // 读失败按缺失处理
  }
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || raw.trim() === "") return fallback;
  return clampPanelSize(parsed, bounds.min, bounds.max);
}
