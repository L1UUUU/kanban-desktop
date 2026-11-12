// 用途：面板尺寸约束纯函数密封测试（#85）—— 侧栏宽度/输入框高度边界（含视口联动）与持久化读取回落的规格基线
import { describe, expect, it } from "vitest";
import {
  CHAT_MIN_WIDTH,
  COMPOSER_DEFAULT_HEIGHT,
  COMPOSER_MAX_VIEWPORT_RATIO,
  COMPOSER_MIN_HEIGHT,
  PANEL_SIZE_KEYS,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampPanelSize,
  composerHeightBounds,
  loadPanelSize,
  sidebarWidthBounds,
} from "./panel-resize";

/** 内存 storage 桩（仅 getItem 契约） */
function storageWith(entries: Record<string, string>) {
  return {
    getItem: (key: string) => (key in entries ? entries[key] : null),
  };
}

describe("clampPanelSize 单侧夹取", () => {
  it("区间内原样返回；越界夹到边界", () => {
    expect(clampPanelSize(200, 180, 480)).toBe(200);
    expect(clampPanelSize(100, 180, 480)).toBe(180);
    expect(clampPanelSize(9999, 180, 480)).toBe(480);
  });

  it("非有限数值回落到下界（防御持久化脏数据路径）", () => {
    expect(clampPanelSize(Number.NaN, 180, 480)).toBe(180);
  });
});

describe("sidebarWidthBounds 侧栏宽度边界（视口联动）", () => {
  it("宽视口下上限 = 固定上限 480（中央区最小宽不受挤压）", () => {
    const b = sidebarWidthBounds(1920);
    expect(b.max).toBe(SIDEBAR_MAX_WIDTH);
    expect(b.min).toBe(SIDEBAR_MIN_WIDTH);
    expect(1920 - b.max).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
  });

  it("窄视口下上限 = 视口宽 − 中央区最小宽（中央区保留最小宽）", () => {
    // 主窗口 minWidth 960：960 − 560 = 400 < 480，视口约束生效
    const b = sidebarWidthBounds(960);
    expect(b.max).toBe(960 - CHAT_MIN_WIDTH);
    expect(b.max).toBeLessThan(SIDEBAR_MAX_WIDTH);
  });

  it("视口窄于 min+中央最小宽时上限不击穿下界（边界不倒置）", () => {
    const b = sidebarWidthBounds(400);
    expect(b.max).toBe(SIDEBAR_MIN_WIDTH);
    expect(b.min).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("默认宽 240 与既有布局锚点一致", () => {
    expect(SIDEBAR_DEFAULT_WIDTH).toBe(240);
  });
});

describe("composerHeightBounds 输入框高度边界", () => {
  it("上限 = 视口高的百分比（默认 50%）向下取整", () => {
    const b = composerHeightBounds(800);
    expect(b.max).toBe(Math.floor(800 * COMPOSER_MAX_VIEWPORT_RATIO));
    expect(b.min).toBe(COMPOSER_MIN_HEIGHT);
  });

  it("极矮视口下上限不低于最小值（边界不倒置）", () => {
    const b = composerHeightBounds(60);
    expect(b.max).toBe(COMPOSER_MIN_HEIGHT);
  });

  it("默认高度与最小值均在边界内", () => {
    const b = composerHeightBounds(800);
    expect(COMPOSER_DEFAULT_HEIGHT).toBeGreaterThanOrEqual(b.min);
    expect(COMPOSER_DEFAULT_HEIGHT).toBeLessThanOrEqual(b.max);
  });
});

describe("loadPanelSize 持久化读取回落", () => {
  const bounds = sidebarWidthBounds(1920);
  const fallback = SIDEBAR_DEFAULT_WIDTH;

  it("合法存储值原样读取；越界值夹到边界", () => {
    expect(loadPanelSize(storageWith({ [PANEL_SIZE_KEYS.sidebarWidth]: "320" }), PANEL_SIZE_KEYS.sidebarWidth, bounds, fallback)).toBe(320);
    expect(loadPanelSize(storageWith({ [PANEL_SIZE_KEYS.sidebarWidth]: "9999" }), PANEL_SIZE_KEYS.sidebarWidth, bounds, fallback)).toBe(bounds.max);
    expect(loadPanelSize(storageWith({ [PANEL_SIZE_KEYS.sidebarWidth]: "10" }), PANEL_SIZE_KEYS.sidebarWidth, bounds, fallback)).toBe(bounds.min);
  });

  it("缺失 / 非数字 / 部分数字脏数据回落默认值", () => {
    expect(loadPanelSize(storageWith({}), PANEL_SIZE_KEYS.sidebarWidth, bounds, fallback)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(loadPanelSize(storageWith({ [PANEL_SIZE_KEYS.sidebarWidth]: "abc" }), PANEL_SIZE_KEYS.sidebarWidth, bounds, fallback)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(loadPanelSize(storageWith({ [PANEL_SIZE_KEYS.sidebarWidth]: "24abc" }), PANEL_SIZE_KEYS.sidebarWidth, bounds, fallback)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("storage 不可用（null）回落默认值", () => {
    expect(loadPanelSize(null, PANEL_SIZE_KEYS.sidebarWidth, bounds, fallback)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});
