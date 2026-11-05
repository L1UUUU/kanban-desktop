// 用途：三区布局组件冒烟 —— 顶栏/侧栏三分组/聊天区占位在 jsdom 中可见（无 window.api 时降级不崩溃）
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App 三区布局骨架（原型一致项 1）", () => {
  it("顶栏：应用名、项目名徽标与设置入口可见", () => {
    render(<App />);
    expect(screen.getByText("Kanban Desktop")).toBeTruthy();
    // 项目名出现在顶栏徽标与侧栏项目行两处（原型一致项 1）
    expect(screen.getAllByText("kanban-desktop").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("设置")).toBeTruthy();
  });

  it("侧栏：项目 / 结构化会话 / PTY 终端三分组可见", () => {
    render(<App />);
    expect(screen.getByText("项目")).toBeTruthy();
    expect(screen.getByText("结构化会话")).toBeTruthy();
    expect(screen.getByText("PTY 终端")).toBeTruthy();
  });

  it("聊天区：占位说明与 composer 占位可见，IPC 不可用时降级", () => {
    render(<App />);
    expect(screen.getByText(/聊天区占位/)).toBeTruthy();
    expect(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…")).toBeTruthy();
    expect(screen.getAllByText(/运行信息不可用|运行信息：/).length).toBeGreaterThan(0);
  });
});
