// 用途：deriveTitle 纯函数密封测试（#94 / ADR 0003：截断 fallback 派生标题）—— 去首尾空白、压连续空白、按 Unicode 码点截 24 加省略号（增补平面字符不截半）
import { describe, expect, it } from "vitest";
import { deriveTitle, TITLE_MAX_CODE_POINTS } from "./title-derive";

describe("deriveTitle（截断 fallback 派生标题）", () => {
  it("短文本原样保留（不截断不加省略号）", () => {
    expect(deriveTitle("把 ipc-schema 拆成独立文件")).toBe("把 ipc-schema 拆成独立文件");
  });

  it("去首尾空白", () => {
    expect(deriveTitle("  首条消息（建立会话）\n")).toBe("首条消息（建立会话）");
  });

  it("压连续空白为单个空格（空格/换行/制表/全角空格一致处理）", () => {
    expect(deriveTitle("调研\t\tVite\n\n配置\u3000与\u3000构建")).toBe("调研 Vite 配置 与 构建");
  });

  it("恰 24 码点不加省略号", () => {
    const text = "一二三四五六七八九十一二三四五六七八九十一二三四"; // 24 个码点
    expect(Array.from(text)).toHaveLength(TITLE_MAX_CODE_POINTS);
    expect(deriveTitle(text)).toBe(text);
  });

  it("超 24 码点截 24 加省略号（BMP 中文）", () => {
    const text = "一".repeat(25);
    expect(deriveTitle(text)).toBe(`${"一".repeat(24)}…`);
  });

  it("按码点截断：增补平面 emoji 不被截成孤立代理对", () => {
    const text = "😀".repeat(25); // 25 码点、UTF-16 长度 50（每 emoji 一个代理对）
    const derived = deriveTitle(text);
    // 24 个完整 emoji + 省略号：不含半个代理对（Array.from 重组保证）
    expect(derived).toBe(`${"😀".repeat(24)}…`);
    expect(Array.from(derived)).toHaveLength(25);
  });

  it("混合文本：中文 + emoji + 英文按码点计数截断", () => {
    // 25 码点：中文(2) + emoji(1) + 英文(22)
    const text = "你好😀abcdefghijklmnopqrstuv";
    expect(Array.from(text)).toHaveLength(25);
    const derived = deriveTitle(text);
    expect(Array.from(derived)).toEqual([...Array.from("你好😀abcdefghijklmnopqrstu"), "…"]);
  });

  it("纯空白输入返回空串（调用方自行回退默认标题）", () => {
    expect(deriveTitle("   \n\t ")).toBe("");
  });
});
