// 用途：三区布局组件冒烟 —— 顶栏/侧栏三分组/聊天区占位在 jsdom 中可见（无 window.api 时降级不崩溃）
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App 三区布局骨架（原型一致项 1）", () => {
  it("顶栏：应用名、项目名徽标（无项目引导态）与设置入口可见", () => {
    render(<App />);
    expect(screen.getByText("Kanban Desktop")).toBeTruthy();
    expect(screen.getByText("未注册项目")).toBeTruthy();
    expect(screen.getByText("设置")).toBeTruthy();
  });

  it("侧栏：项目 / 结构化会话 / PTY 终端三分组可见；无项目时显示注册引导", () => {
    render(<App />);
    expect(screen.getByText("项目")).toBeTruthy();
    expect(screen.getByText("结构化会话")).toBeTruthy();
    expect(screen.getByText("PTY 终端")).toBeTruthy();
    expect(screen.getByText("尚无项目")).toBeTruthy();
    expect(screen.getByRole("button", { name: "＋ 注册本地目录…" })).toBeTruthy();
  });

  it("侧栏底部「看板」入口可见（#18 原型一致项 1；无项目时指示回落「当前项目」）", () => {
    render(<App />);
    const entry = screen.getByTestId("kanban-entry");
    expect(entry.textContent).toContain("看板");
    expect(entry.textContent).toContain("当前项目");
  });

  it("聊天区：占位说明与 composer 占位可见，IPC 不可用时降级", () => {
    render(<App />);
    expect(screen.getByText(/聊天区占位/)).toBeTruthy();
    expect(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…")).toBeTruthy();
    expect(screen.getAllByText(/运行信息不可用|运行信息：/).length).toBeGreaterThan(0);
  });
});
