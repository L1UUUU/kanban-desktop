// 用途：PermChip 密封测试（A 类，issue #83 / spec #82）—— 可关闭浮层接入后行为：点击 chip 开菜单 / 再次点击 chip toggle 关闭 / 外部点击关闭 / Esc 关闭 / 选档关闭并回调
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermChip } from "./ComposerControls";

afterEach(cleanup);

/** 打开菜单（点击 chip；默认值 auto 与草稿/会话默认一致） */
function openMenu(): void {
  fireEvent.click(screen.getByRole("button", { name: "⚡ 权限：自动 ▾" }));
  expect(screen.getByText("🔓 完全访问")).toBeTruthy(); // 菜单已展开（full 档项可见）
}

describe("PermChip 可关闭浮层交互（issue #83）", () => {
  it("点击 chip 打开菜单，再次点击 chip toggle 关闭", () => {
    render(<PermChip value="auto" onChange={() => undefined} />);
    const chip = screen.getByRole("button", { name: "⚡ 权限：自动 ▾" });
    fireEvent.click(chip);
    expect(screen.getByText("所有工具调用前弹出审批卡片")).toBeTruthy(); // 菜单已展开（含三档说明）
    fireEvent.click(chip);
    expect(screen.queryByText("所有工具调用前弹出审批卡片")).toBeNull(); // toggle 关闭
  });

  it("菜单展开时点击外部任意区域关闭", () => {
    render(<PermChip value="auto" onChange={() => undefined} />);
    openMenu();
    fireEvent.mouseDown(document.body); // chip 与菜单之外的任意区域
    expect(screen.queryByText("所有工具调用前弹出审批卡片")).toBeNull();
  });

  it("菜单展开时按 Esc 关闭", () => {
    render(<PermChip value="auto" onChange={() => undefined} />);
    openMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("所有工具调用前弹出审批卡片")).toBeNull();
  });

  it("容器内交互不误关：菜单项上按下不触发外部关闭，点选档位回调 onChange 并关闭", () => {
    const onChange = vi.fn();
    render(<PermChip value="auto" onChange={onChange} />);
    openMenu();
    const fullItem = screen.getByText("🔓 完全访问", { exact: false });
    fireEvent.mouseDown(fullItem); // 容器内按下：保持展开
    expect(screen.getByText("所有工具调用前弹出审批卡片")).toBeTruthy();
    fireEvent.click(fullItem);
    expect(onChange).toHaveBeenCalledWith("full");
    expect(screen.queryByText("所有工具调用前弹出审批卡片")).toBeNull(); // 选档即关
  });

  it("关闭后菜单外按下不再影响（状态稳定，可重新打开）", () => {
    render(<PermChip value="ask" onChange={() => undefined} />);
    const chip = screen.getByRole("button", { name: "🔒 权限：请求 ▾" });
    fireEvent.click(chip);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(document.body); // 已关闭状态下的外部按下不报错不复活
    expect(screen.queryByText("所有工具调用前弹出审批卡片")).toBeNull();
    fireEvent.click(chip);
    expect(screen.getByText("所有工具调用前弹出审批卡片")).toBeTruthy(); // 可重新展开
  });
});
