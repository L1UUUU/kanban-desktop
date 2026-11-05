// 用途：侧栏组件测试 —— 空态引导/项目行（切换、missing、悬浮「＋」菜单四项与 PTY 占位）/会话行（目录身份徽标、当前项目过滤）（工单 #7 验收第 1/2 条，原型一致项 2/3）
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectRow } from "@kanban/ipc-schema";
import type { SessionView } from "../features/chat/chat-store";
import { Sidebar } from "./Sidebar";

const P1: ProjectRow = { id: "p-1", name: "alpha", canonicalPath: "C:\\alpha", status: "ok", createdAt: "2026-11-05T00:00:00.000Z" };
const P2: ProjectRow = { id: "p-2", name: "beta", canonicalPath: "C:\\beta", status: "missing", createdAt: "2026-11-05T01:00:00.000Z" };

function makeSession(partial: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: "s-1",
    cli: "codex",
    title: "调研 Vite 配置",
    status: "idle",
    permMode: "auto",
    model: "默认模型",
    projectId: "p-1",
    cwd: "C:\\alpha",
    dirIdentity: "main",
    worktreeName: null,
    items: [],
    pendingApproval: null,
    lastTurnInterrupted: false,
    lastError: null,
    ...partial,
  };
}

function mount(props: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const onSelectProject = vi.fn();
  const onRegisterProject = vi.fn();
  const onCreateSession = vi.fn();
  render(
    <Sidebar
      projects={[]}
      currentProjectId={null}
      sessions={[]}
      activeId={null}
      onSelect={() => undefined}
      onSelectProject={onSelectProject}
      onRegisterProject={onRegisterProject}
      onCreateSession={onCreateSession}
      {...props}
    />,
  );
  return { onSelectProject, onRegisterProject, onCreateSession };
}

describe("侧栏项目区（原型一致项 2）", () => {
  it("空态：无项目时显示注册引导按钮，点击触发注册", () => {
    const h = mount();
    expect(screen.getByText("尚无项目")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "＋ 注册本地目录…" }));
    expect(h.onRegisterProject).toHaveBeenCalledTimes(1);
  });

  it("项目行：渲染全部项目；missing 标记可见；点击行切换当前项目", () => {
    const h = mount({ projects: [P1, P2], currentProjectId: "p-1" });
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("beta")).toBeTruthy();
    expect(screen.getByText("目录缺失")).toBeTruthy();
    fireEvent.click(screen.getByText("beta"));
    expect(h.onSelectProject).toHaveBeenCalledWith("p-2");
  });

  it("有项目时常驻注册入口：分组标题旁「＋ 注册」按钮触发注册（多项目并存，用户故事 1）", () => {
    const h = mount({ projects: [P1], currentProjectId: "p-1" });
    fireEvent.click(screen.getByRole("button", { name: "＋ 注册" }));
    expect(h.onRegisterProject).toHaveBeenCalledTimes(1);
  });

  it("「＋」菜单：四项 CLI（Codex/Claude/OpenCode/PTY 终端）；点三 CLI 建会话挂该行项目；PTY 占位提示后续版本", () => {
    const h = mount({ projects: [P1], currentProjectId: "p-1" });
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("OpenCode")).toBeTruthy();
    expect(screen.getByRole("button", { name: /PTY 终端/ })).toBeTruthy();
    fireEvent.click(screen.getByText("Claude"));
    expect(h.onCreateSession).toHaveBeenCalledWith("p-1", "claude");
    // PTY：不建会话，提示后续版本
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByRole("button", { name: /PTY 终端/ }));
    expect(h.onCreateSession).toHaveBeenCalledTimes(1);
    expect(screen.getByText("PTY 终端会话将在后续版本提供")).toBeTruthy();
  });
});

describe("侧栏会话区（原型一致项 3）", () => {
  it("会话行：CLI 色点 + 标题 + 目录身份徽标（主仓库/worktree: xxx）+ 状态徽标；点击选中", () => {
    const onSelect = vi.fn();
    mount({
      projects: [P1],
      currentProjectId: "p-1",
      sessions: [
        makeSession(),
        makeSession({
          sessionId: "s-2",
          cli: "claude",
          title: "写实现方案",
          status: "waiting",
          dirIdentity: "worktree",
          worktreeName: "poc7",
          cwd: "C:\\wt\\poc7",
        }),
      ],
      activeId: "s-1",
      onSelect,
    });
    expect(screen.getByText("调研 Vite 配置")).toBeTruthy();
    expect(screen.getByTitle("工作在主仓库（C:\\alpha）").textContent).toContain("主仓库");
    expect(screen.getByTitle("工作在独立 worktree（C:\\wt\\poc7），与其他会话文件隔离").textContent).toContain("worktree: poc7");
    expect(screen.getByText("空闲")).toBeTruthy();
    expect(screen.getByText("等待审批")).toBeTruthy();
    fireEvent.click(screen.getByText("写实现方案"));
    expect(onSelect).toHaveBeenCalledWith("s-2");
  });

  it("当前项目过滤：仅显示当前项目会话；无当前项目时显示无项目会话（演示链路）", () => {
    mount({
      projects: [P1, P2],
      currentProjectId: "p-2",
      sessions: [
        makeSession({ sessionId: "in-p2", projectId: "p-2", title: "项目二会话" }),
        makeSession({ sessionId: "in-p1", projectId: "p-1", title: "项目一会话" }),
        makeSession({ sessionId: "no-proj", projectId: null, title: "演示会话 · Fake" }),
      ],
    });
    expect(screen.getByText("项目二会话")).toBeTruthy();
    expect(screen.queryByText("项目一会话")).toBeNull();
    expect(screen.queryByText("演示会话 · Fake")).toBeNull();
  });

  it("无当前项目：显示无项目会话（boot 演示会话可见），空会话组显示占位", () => {
    mount({ sessions: [makeSession({ projectId: null, title: "演示会话 · Fake" })] });
    expect(screen.getByText("演示会话 · Fake")).toBeTruthy();
    cleanup();
    mount();
    expect(screen.getByText("暂无会话")).toBeTruthy();
    expect(screen.getByText("暂无终端会话")).toBeTruthy();
  });
});

afterEach(cleanup);
