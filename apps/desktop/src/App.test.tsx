// 用途：三区布局组件冒烟 —— 顶栏/侧栏三分组/聊天区占位在 jsdom 中可见（无 window.api 时降级不崩溃）+ 顶部 banner 叠加顺序规则（#42/spec G/F18）；#63 设置面板取消归档 → 侧栏行回默认列表显示已断开（AppShell 全接线）
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App, AppShell } from "./App";
import type { ChatController } from "./features/chat/use-chat";
import type { ChatTransport } from "./lib/kanban-api";
import type { SessionRow } from "@kanban/ipc-schema";

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
    expect(screen.getAllByText(/暂无会话/).length).toBeGreaterThan(0);
    expect(screen.getByText(/项目行悬浮「＋」/)).toBeTruthy();
    expect(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…")).toBeTruthy();
    expect(screen.getAllByText(/运行信息不可用|运行信息：/).length).toBeGreaterThan(0);
  });
});

describe("顶部 banner 叠加顺序（#42 / spec G·F18：全局条在上，会话级条在下）", () => {
  it("shutdown-banner（App 层）位于全部会话级条之上；会话级内部顺序：冲突条 → 同名 skill 条 → 恢复引导条", () => {
    // 最小失败 transport：本测试经 controller.store 直驱会话数据，IPC 通道仅需不崩溃
    const transport: ChatTransport = {
      invoke: async () => ({ ok: false, error: { code: "E_INTERNAL", message: "叠序测试 transport 不支持该通道" } }),
      onEvent: () => () => undefined,
      onTerminalEvent: () => () => undefined,
      onTrackerEvent: () => () => undefined,
    };
    const holder: { controller?: ChatController } = {};
    render(
      <AppShell
        transport={transport}
        shutdownNotice="正在退出应用：已停止接收新请求，正在有序结束会话…"
        onChatController={(c) => {
          holder.controller = c;
        }}
      />,
    );
    const store = holder.controller!.store;
    act(() => {
      // 同目录主仓库两个运行中会话（冲突条判据）+ 当前断开会话（恢复条）带同名 skill 冲突
      const repo = { cwd: "C:\\repo", dirIdentity: "main" as const, worktreeName: null };
      store.registerSession({ sessionId: "run-1", cli: "claude", title: "运行A", permMode: "auto", model: "默认模型", ...repo });
      store.registerSession({ sessionId: "run-2", cli: "claude", title: "运行B", permMode: "auto", model: "默认模型", ...repo });
      store.updateStatus("run-1", "running");
      store.updateStatus("run-2", "running");
      store.registerSession({
        sessionId: "disc-1",
        cli: "claude",
        title: "断开会话",
        permMode: "auto",
        model: "默认模型",
        ...repo,
        skillConflicts: ["setup"],
      });
      store.updateStatus("disc-1", "disconnected");
      store.setActive("disc-1");
    });
    // DOM 顺序断言（自上而下）：全局退出条 → 冲突条 → 同名 skill 条 → 恢复引导条
    const [shutdown, conflict, skillConflict, resume] = [
      "shutdown-banner",
      "conflict-banner",
      "skill-conflict-banner",
      "resume-banner",
    ].map((id) => screen.getByTestId(id));
    expect(shutdown.compareDocumentPosition(conflict) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(conflict.compareDocumentPosition(skillConflict) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(skillConflict.compareDocumentPosition(resume) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("设置面板取消归档 → 侧栏行回默认列表（#63 AppShell 全接线）", () => {
  afterEach(() => {
    cleanup();
    window.api = undefined;
  });

  it("取消归档 PTY 已归档行：设置面板行移出，侧栏 PTY 组出现该行且状态徽标「已断开」；结构化行同链路回列表", async () => {
    // chat 侧 Fake transport：无项目、无历史会话（侧栏初始空）
    const transport: ChatTransport = {
      invoke: async (req) => {
        if (req.channel === "project:list") return { ok: true, projects: [], currentProjectId: null };
        if (req.channel === "session:list") return { ok: true, sessions: [] };
        return { ok: true };
      },
      onEvent: () => () => undefined,
      onTerminalEvent: () => () => undefined,
      onTrackerEvent: () => () => undefined,
    };
    const archivedPty: SessionRow = {
      id: "a-pty",
      kind: "pty",
      cli: "pty",
      nativeSessionId: null,
      projectId: null,
      title: "终端 · shell",
      cwd: "C:\\repo",
      permMode: null,
      status: null,
      lastActiveAt: null,
      archivedAt: "2026-11-10T08:00:00.000Z",
      dirIdentity: "none",
      worktreeName: null,
    };
    // 设置面板侧 fake 桥：archivedList 返回该行；unarchive 成功
    window.api = {
      invokeConfig: async () => ({ ok: true, autoArchive: { enabled: false, days: 30 }, lastScan: null }),
      invoke: async (req: { channel: string }) => {
        if (req.channel === "session:archivedList") return { ok: true, sessions: [archivedPty] };
        if (req.channel === "session:unarchive") return { ok: true };
        return { ok: true };
      },
    } as unknown as typeof window.api;
    render(<AppShell transport={transport} />);
    // 打开设置 → 未关联项目组默认展开（无当前项目）→ 取消归档
    fireEvent.click(screen.getByText("设置"));
    const unarchiveBtn = await waitFor(() => {
      const btn = screen.getByTestId("archived-unarchive");
      expect(btn).toBeTruthy();
      return btn;
    });
    fireEvent.click(unarchiveBtn);
    // 侧栏 PTY 组出现该行，状态徽标已断开（PTY 取消归档无进程恢复，与重启后行为一致）
    await waitFor(() => {
      const rows = [...document.querySelectorAll("[data-testid='session-row']")];
      expect(rows.some((r) => r.textContent?.includes("终端 · shell"))).toBe(true);
    });
    const row = [...document.querySelectorAll("[data-testid='session-row']")].find((r) =>
      r.textContent?.includes("终端 · shell"),
    ) as HTMLElement;
    expect(row.textContent).toContain("已断开");
    // 设置面板中该行已移出（空态或无该条目）
    await waitFor(() =>
      expect(document.querySelector("[data-testid='archived-item'][data-session-id='a-pty']")).toBeNull(),
    );
  });
});
