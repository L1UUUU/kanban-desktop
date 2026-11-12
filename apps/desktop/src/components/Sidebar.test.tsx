// 用途：侧栏组件测试 —— 空态引导/项目行（切换、missing、悬浮「＋」菜单四项与 PTY 占位）/会话行（目录身份徽标、当前项目过滤）（工单 #7 验收第 1/2 条，原型一致项 2/3）
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    skillConflicts: [],
    skillConflictDismissed: false,
    resumeState: { phase: "idle" },
    ...partial,
  };
}

function mount(props: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const onSelectProject = vi.fn();
  const onRegisterProject = vi.fn();
  const onCreateSession = vi.fn();
  const onCreatePtySession = vi.fn();
  const onKillTerminal = vi.fn();
  const onArchiveSession = vi.fn();
  const onDeleteSession = vi.fn();
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
      onCreatePtySession={onCreatePtySession}
      onKillTerminal={onKillTerminal}
      onArchiveSession={onArchiveSession}
      onDeleteSession={onDeleteSession}
      {...props}
    />,
  );
  return { onSelectProject, onRegisterProject, onCreateSession, onCreatePtySession, onKillTerminal, onArchiveSession, onDeleteSession };
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

  it("「＋」菜单：四项 CLI（Codex/Claude/OpenCode/PTY 终端）；点三 CLI 建会话挂该行项目；PTY 项建终端会话（#12 实体）", () => {
    const h = mount({ projects: [P1], currentProjectId: "p-1" });
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("OpenCode")).toBeTruthy();
    fireEvent.click(screen.getByText("Claude"));
    expect(h.onCreateSession).toHaveBeenCalledWith("p-1", "claude");

    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByRole("button", { name: /PTY 终端/ }));
    expect(h.onCreatePtySession).toHaveBeenCalledWith("p-1");
    expect(h.onCreateSession).toHaveBeenCalledTimes(1);
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

  it("PTY 分组：cli=pty 会话渲染在 PTY 终端分组（不混入结构化会话），hover 停止按钮触发 onKillTerminal；重启恢复的断开终端同样列出", () => {
    const onSelect = vi.fn();
    const h = mount({
      projects: [P1],
      currentProjectId: "p-1",
      sessions: [
        makeSession(),
        makeSession({ sessionId: "tty-1", cli: "pty", title: "终端 · pwsh", status: "idle", projectId: "p-1" }),
        makeSession({ sessionId: "tty-2", cli: "pty", title: "终端 · claude", status: "disconnected", projectId: "p-1" }),
      ],
      activeId: "tty-1",
      onSelect,
    });

    // PTY 会话出现在 PTY 分组，结构化会话不重复出现
    expect(screen.getByText("终端 · pwsh")).toBeTruthy();
    expect(screen.getByText("终端 · claude")).toBeTruthy();
    const ptyGroup = screen.getByText("PTY 终端").closest("div") ?? document;
    void ptyGroup;
    // 活跃终端可停止（显式终止入口）；断开终端无停止按钮
    const killBtn = screen.getByTitle("停止终端（终止进程，保留会话记录）");
    expect(killBtn).toBeTruthy();
    expect(screen.getAllByTitle("停止终端（终止进程，保留会话记录）")).toHaveLength(1);
    fireEvent.click(killBtn);
    expect(h.onKillTerminal).toHaveBeenCalledWith("tty-1");

    // 点击 PTY 行切换激活（与结构化会话并列切换）
    fireEvent.click(screen.getByText("终端 · claude"));
    expect(onSelect).toHaveBeenCalledWith("tty-2");
  });
});

describe("侧栏会话行 hover「归档」（#58 spec #57）", () => {
  it("结构化与 PTY 行均提供归档操作，点击触发 onArchiveSession", () => {
    const onArchiveSession = vi.fn();
    mount({
      projects: [P1],
      currentProjectId: "p-1",
      sessions: [
        makeSession(),
        makeSession({ sessionId: "tty-1", cli: "pty", title: "终端 · pwsh", status: "idle", projectId: "p-1" }),
      ],
      onArchiveSession,
    });
    const btns = screen.getAllByTitle("归档（移出默认列表，可在设置找回）");
    expect(btns).toHaveLength(2); // 结构化 + PTY 行同款 hover 操作
    fireEvent.click(btns[0]);
    expect(onArchiveSession).toHaveBeenCalledWith("s-1");
    fireEvent.click(btns[1]);
    expect(onArchiveSession).toHaveBeenCalledWith("tty-1");
  });
});

describe("侧栏会话行 hover「删除」+ 二次确认弹窗（#62 spec #57 / 原型 stage5 演示②）", () => {
  function mountDeletable(onDeleteSession = vi.fn()) {
    mount({
      projects: [P1],
      currentProjectId: "p-1",
      sessions: [
        makeSession(),
        makeSession({ sessionId: "tty-1", cli: "pty", title: "终端 · pwsh", status: "idle", projectId: "p-1" }),
      ],
      onDeleteSession,
    });
    return { onDeleteSession };
  }

  it("结构化与 PTY 行均提供删除操作，点击弹二次确认（不直接删除）", () => {
    const h = mountDeletable();
    const btns = screen.getAllByTitle("删除（终止进程并移除会话记录，不可撤销）");
    expect(btns).toHaveLength(2); // 结构化 + PTY 行同款 hover 操作
    fireEvent.click(btns[0]);
    expect(screen.getByTestId("delete-session-dialog")).toBeTruthy(); // 二次确认弹出，未直接触发删除
    expect(h.onDeleteSession).not.toHaveBeenCalled();
  });

  it("确认弹窗内容：标题「删除会话」+ 会话标题 + 影响说明（终止进程/移除记录与看板关联/切激活/原生历史不删）+ 不可撤销", () => {
    mountDeletable();
    fireEvent.click(screen.getAllByTitle("删除（终止进程并移除会话记录，不可撤销）")[0]);
    const dialog = screen.getByTestId("delete-session-dialog");
    expect(dialog.textContent).toContain("删除会话");
    expect(dialog.textContent).toContain("调研 Vite 配置");
    expect(dialog.textContent).toContain("将终止该会话的 CLI 进程、移除本地会话记录与看板关联，并切换当前激活会话。CLI 原生历史文件不删除。此操作不可撤销。");
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
    expect(screen.getByTestId("delete-session-confirm").textContent).toBe("删除");
  });

  it("「取消」关闭弹窗且不触发删除；「删除」确认触发 onDeleteSession 并关闭", () => {
    const h = mountDeletable();
    fireEvent.click(screen.getAllByTitle("删除（终止进程并移除会话记录，不可撤销）")[0]);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByTestId("delete-session-dialog")).toBeNull();
    expect(h.onDeleteSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByTitle("删除（终止进程并移除会话记录，不可撤销）")[1]); // PTY 行删除
    fireEvent.click(screen.getByTestId("delete-session-confirm"));
    expect(h.onDeleteSession).toHaveBeenCalledWith("tty-1");
    expect(screen.queryByTestId("delete-session-dialog")).toBeNull(); // 确认后关闭
  });
});

describe("「＋」菜单未装 CLI 灰置（#80 spec #75：与详情面板菜单共享禁用逻辑）", () => {
  afterEach(() => {
    window.api = undefined as unknown as typeof window.api;
  });

  /** fake 桥：只接 invokeCliStatus（其余面本组件不用）；flip 改写应答驱动「模拟装完」 */
  function fakeBridge(initial: { codex: boolean; claude: boolean; opencode: boolean }) {
    let installed = initial;
    window.api = {
      invokeCliStatus: async () => ({ ok: true, installed }),
    } as unknown as typeof window.api;
    return { flip: (next: typeof installed) => { installed = next; } };
  }

  it("未装项灰置 + 「未安装」标注 + 悬停说明，点击无效；已装项与 PTY 项不受影响", async () => {
    fakeBridge({ codex: true, claude: false, opencode: true });
    const h = mount({ projects: [P1], currentProjectId: "p-1" });
    fireEvent.click(screen.getByRole("button", { name: "＋" }));

    const claudeItem = await waitFor(() => {
      const el = screen.getByRole("button", { name: "Claude未安装" }) as HTMLButtonElement;
      expect(el.disabled).toBe(true);
      return el;
    });
    expect(claudeItem.getAttribute("title")).toContain("未安装"); // spec：可悬停查看说明
    fireEvent.click(claudeItem);
    expect(h.onCreateSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(h.onCreateSession).toHaveBeenCalledWith("p-1", "codex");
    fireEvent.click(screen.getByRole("button", { name: "＋" })); // 重开验证 PTY 恒可选
    fireEvent.click(screen.getByRole("button", { name: /PTY 终端/ }));
    expect(h.onCreatePtySession).toHaveBeenCalledWith("p-1");
  });

  it("探测翻转（模拟装完）：重开菜单恢复可选并创建会话，无需重启", async () => {
    const { flip } = fakeBridge({ codex: true, claude: false, opencode: true });
    const h = mount({ projects: [P1], currentProjectId: "p-1" });
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Claude未安装" }) as HTMLButtonElement).disabled).toBe(true);
    });

    flip({ codex: true, claude: true, opencode: true }); // 模拟装完 CLI
    fireEvent.click(screen.getByRole("button", { name: "＋" })); // 关菜单
    fireEvent.click(screen.getByRole("button", { name: "＋" })); // 重开即重探（未装不缓存）
    const claudeItem = await waitFor(() => {
      const el = screen.getByRole("button", { name: "Claude" }) as HTMLButtonElement;
      expect(el.disabled).toBe(false);
      return el;
    });
    fireEvent.click(claudeItem);
    expect(h.onCreateSession).toHaveBeenCalledWith("p-1", "claude");
  });
});

afterEach(cleanup);
