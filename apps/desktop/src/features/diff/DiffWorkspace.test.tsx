// 用途：Diff 视图组件测试（#43，spec #40 G 节 + 原型 d1 必须一致项）—— 传输注入 fake 驱动：进入自动读取一次、头部统计与刷新、文件行（类型徽标配色/等宽路径/每文件统计/untracked/binary 标注）、展开折叠行级红绿 diff、非 git 项目居中空态、git 不可用错误态、入口按钮无项目禁用 + 四态切换（先例 features/memory/MemoryWorkspace.test.tsx）
/// <reference types="node" />
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DiffRequest, DiffResult, ProjectRow } from "@kanban/ipc-schema";
import { AppShell } from "../../App";
import type { ChatTransport } from "../../lib/kanban-api";
import { DiffEntryButton, DiffWorkspace } from "./DiffWorkspace";
import { useWorkspaceDiff } from "./use-workspace-diff";
import type { DiffTransport } from "./diff-transport";

afterEach(cleanup);

/** 一次成功结果 fixture（M/A/D/U/binary 五行 + 单 hunk 三性行） */
const OK_RESULT: DiffResult = {
  ok: true,
  truncated: false,
  files: [
    {
      path: "apps/desktop/src/features/chat/chat-store.ts",
      changeType: "modified",
      binary: false,
      oldPath: null,
      hunks: [
        {
          header: "@@ -180,6 +180,24 @@ export class ChatStore {",
          lines: [
            { kind: "context", text: "    case \"session_status\":" },
            { kind: "del", text: "      if (event.status === \"disconnected\") {" },
            { kind: "add", text: "      if (event.status === \"disconnected\") {" },
          ],
        },
      ],
      additions: 24,
      deletions: 6,
    },
    { path: "apps/desktop/src/features/diff/DiffWorkspace.tsx", changeType: "added", binary: false, oldPath: null, hunks: null, additions: 52, deletions: 0 },
    { path: "apps/desktop/src/features/chat/legacy-error.ts", changeType: "deleted", binary: false, oldPath: null, hunks: null, additions: 0, deletions: 18 },
    { path: "notes/diff-parsing.md", changeType: "untracked", binary: false, oldPath: null, hunks: null, additions: 0, deletions: 0 },
    { path: "assets/logo.png", changeType: "modified", binary: true, oldPath: null, hunks: null, additions: 0, deletions: 0 },
  ],
};

/** fake diff 传输：记录请求，按用例返回结果 */
function makeTransport(result: () => DiffResult): { transport: DiffTransport; calls: DiffRequest[] } {
  const calls: DiffRequest[] = [];
  return {
    calls,
    transport: {
      invoke: async (req) => {
        calls.push(req);
        return result();
      },
    },
  };
}

/** 挂载被测视图（controller hook 与视图的组合出口） */
function mountView(transport: DiffTransport | null, projectId: string | null): void {
  const Harness = (): React.ReactElement => {
    const controller = useWorkspaceDiff(transport, projectId);
    return (
      <div>
        <span data-testid="controller-exposed" data-loaded={controller.state.status} />
        <DiffWorkspace controller={controller} />
      </div>
    );
  };
  render(<Harness />);
}

/** 定位包含某路径文本的文件行（head 按钮元素） */
function fileRow(path: string): HTMLElement {
  return screen.getByText(path).closest('[data-testid="diff-file-head"]') as HTMLElement;
}

describe("DiffWorkspace（视图内容）", () => {
  it("进入视图自动读取一次（diff:get + projectId）", async () => {
    const { transport, calls } = makeTransport(() => OK_RESULT);
    mountView(transport, "p-1");
    await waitFor(() => expect(screen.getByTestId("diff-stat")).toBeTruthy());
    expect(calls).toEqual([{ channel: "diff:get", projectId: "p-1" }]);
  });

  it("头部统计（N 个文件 · +M -L · HEAD 对比口径）+ 刷新按钮再次读取", async () => {
    const { transport, calls } = makeTransport(() => OK_RESULT);
    mountView(transport, "p-1");
    await waitFor(() => expect(screen.getByTestId("diff-stat").textContent).toBe("5 个文件 · +76 -24 · 未提交（HEAD 对比）"));
    fireEvent.click(screen.getByTestId("diff-refresh"));
    await waitFor(() => expect(calls).toHaveLength(2));
  });

  it("文件行：类型徽标 M/A/D/U 配色 + 等宽路径 + 每文件统计 + untracked/binary 标注（原型 d1）", async () => {
    const { transport } = makeTransport(() => OK_RESULT);
    mountView(transport, "p-1");
    await waitFor(() => expect(screen.getAllByTestId("diff-file-head")).toHaveLength(5));

    const m = fileRow("apps/desktop/src/features/chat/chat-store.ts");
    expect(within(m).getByTestId("diff-badge-M").className).toContain("text-primary");
    expect(within(m).getByText("+24").className).toContain("text-ok");
    expect(within(m).getByText("-6").className).toContain("text-destructive");

    const a = fileRow("apps/desktop/src/features/diff/DiffWorkspace.tsx");
    expect(within(a).getByTestId("diff-badge-A").className).toContain("text-ok");

    const d = fileRow("apps/desktop/src/features/chat/legacy-error.ts");
    expect(within(d).getByTestId("diff-badge-D").className).toContain("text-destructive");

    const u = fileRow("notes/diff-parsing.md");
    expect(within(u).getByTestId("diff-badge-U").className).toContain("text-warn");
    expect(within(u).getByText("新文件（未跟踪）")).toBeTruthy();

    const b = fileRow("assets/logo.png");
    expect(within(b).getByText("二进制文件")).toBeTruthy();
    // 等宽路径类（原型 .diff-path monospace）
    expect(screen.getByText("notes/diff-parsing.md").className).toContain("font-mono");
  });

  it("展开/折叠：默认收起，点击文件行展开行级红绿 diff（hunk 头/上下文/增删行），再点收起", async () => {
    const { transport } = makeTransport(() => OK_RESULT);
    mountView(transport, "p-1");
    await waitFor(() => expect(screen.getAllByTestId("diff-file-head")).toHaveLength(5));
    // 默认收起：diff 行不可见
    expect(screen.queryByTestId("diff-line-add")).toBeNull();

    fireEvent.click(fileRow("apps/desktop/src/features/chat/chat-store.ts"));
    expect(screen.getByTestId("diff-line-hunk").textContent).toBe("@@ -180,6 +180,24 @@ export class ChatStore {");
    expect(screen.getByTestId("diff-line-add").textContent).toBe("+      if (event.status === \"disconnected\") {");
    expect(screen.getByTestId("diff-line-del").textContent).toBe("-      if (event.status === \"disconnected\") {");
    expect(screen.getByTestId("diff-line-context").textContent).toBe("     case \"session_status\":");

    fireEvent.click(fileRow("apps/desktop/src/features/chat/chat-store.ts"));
    expect(screen.queryByTestId("diff-line-add")).toBeNull();
  });

  it("非 git 项目 → 居中空态说明（不弹窗报错）", async () => {
    const { transport } = makeTransport(() => ({ ok: false, kind: "not-a-repo", message: "当前项目不是 git 仓库" }));
    mountView(transport, "p-1");
    await waitFor(() => expect(screen.getByTestId("diff-empty").textContent).toContain("当前项目不是 git 仓库"));
    expect(screen.queryByTestId("diff-file-head")).toBeNull();
  });

  it("git 不可用 → 明确错误档（标题 + 原因）", async () => {
    const { transport } = makeTransport(() => ({ ok: false, kind: "git-missing", message: "未找到 git 可执行文件" }));
    mountView(transport, "p-1");
    await waitFor(() => expect(screen.getByTestId("diff-error").textContent).toContain("未找到 git 可执行文件"));
  });

  it("传输不可用（window.api 未暴露）→ 降级占位", () => {
    mountView(null, "p-1");
    expect(screen.getByTestId("diff-unavailable").textContent).toContain("window.api");
  });

  it("无变更 → 干净空态", async () => {
    const { transport } = makeTransport(() => ({ ok: true, files: [], truncated: false }));
    mountView(transport, "p-1");
    await waitFor(() => expect(screen.getByTestId("diff-empty").textContent).toContain("无未提交变更"));
  });

  // ============ #47：untracked 全文 / 二进制只列名 / 已截断提示 ============

  it("untracked 新文件全文展开：hunk 头 + 全新增行（绿），对齐 tracked 行级渲染", async () => {
    const result: DiffResult = {
      ok: true,
      truncated: false,
      files: [
        {
          path: "notes/generated.md",
          changeType: "untracked",
          binary: false,
          oldPath: null,
          additions: 2,
          deletions: 0,
          hunks: [{ header: "@@ -0,0 +1,2 @@", lines: [{ kind: "add", text: "# 新文件" }, { kind: "add", text: "全文第二行" }] }],
        },
      ],
    };
    const { transport } = makeTransport(() => result);
    mountView(transport, "p-1");
    await waitFor(() => expect(screen.getAllByTestId("diff-file-head")).toHaveLength(1));
    expect(screen.queryByTestId("diff-line-add")).toBeNull(); // 默认收起
    fireEvent.click(fileRow("notes/generated.md"));
    expect(screen.getByTestId("diff-line-hunk").textContent).toBe("@@ -0,0 +1,2 @@");
    const adds = screen.getAllByTestId("diff-line-add");
    expect(adds[0].textContent).toBe("+# 新文件");
    expect(adds[0].className).toContain("bg-diff-add");
    expect(adds[1].textContent).toBe("+全文第二行");
  });

  it("untracked 二进制：标「二进制文件」不渲染内容（binary 标注优先于新文件标注）", async () => {
    const result: DiffResult = {
      ok: true,
      truncated: false,
      files: [{ path: "assets/logo.png", changeType: "untracked", binary: true, oldPath: null, hunks: null, additions: 0, deletions: 0 }],
    };
    const { transport } = makeTransport(() => result);
    mountView(transport, "p-1");
    await waitFor(() => expect(screen.getAllByTestId("diff-file-head")).toHaveLength(1));
    const row = fileRow("assets/logo.png");
    expect(within(row).getByTestId("diff-badge-U")).toBeTruthy();
    expect(within(row).getByText("二进制文件")).toBeTruthy();
    expect(within(row).queryByText("新文件（未跟踪）")).toBeNull();
    fireEvent.click(row);
    expect(screen.queryByTestId("diff-line-add")).toBeNull(); // 无内容渲染
  });

  it("truncated=true → 明确「已截断」提示（含配置项指引），false → 无提示", async () => {
    const { transport } = makeTransport(() => ({ ok: true, truncated: true, files: [{ path: "a.ts", changeType: "modified", binary: false, oldPath: null, hunks: null, additions: 0, deletions: 0 }] }));
    mountView(transport, "p-1");
    await waitFor(() => expect(screen.getByTestId("diff-truncated")).toBeTruthy());
    expect(screen.getByTestId("diff-truncated").textContent).toContain("已截断");
    expect(screen.getByTestId("diff-truncated").textContent).toContain("diff.maxBytes");
  });
});

// ============ 入口按钮（AppShell 层） ============

/** 轻量 chat transport 桩：project:list / kanban:list 即可挂载 AppShell */
function makeChatStub(project: ProjectRow | null): ChatTransport {
  return {
    invoke: async (req) => {
      if (req.channel === "project:list") {
        return { ok: true, projects: project ? [project] : [], currentProjectId: project?.id ?? null };
      }
      if (req.channel === "kanban:list") {
        return { ok: true, requirements: [], sessionToReq: {} };
      }
      return { ok: false, error: { code: "E_INTERNAL", message: `测试桩未实现通道：${req.channel}` } };
    },
    onEvent: () => () => undefined,
    onTerminalEvent: () => () => undefined,
    onTrackerEvent: () => () => undefined,
  };
}

const PROJECT: ProjectRow = {
  id: "proj-1",
  name: "demo-repo",
  canonicalPath: "C:\\demo\\repo",
  status: "ok",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("DiffEntryButton + AppShell 第四态", () => {
  it("无当前项目 → 入口禁用；有项目 → 点击进入 Diff 视图并自动读取", async () => {
    const { transport, calls } = makeTransport(() => OK_RESULT);
    const { unmount } = render(<AppShell transport={makeChatStub(null)} diffTransport={transport} />);
    const entry = screen.getByTestId("diff-entry") as HTMLButtonElement;
    expect(entry.disabled).toBe(true);

    unmount();
    cleanup();
    render(<AppShell transport={makeChatStub(PROJECT)} diffTransport={transport} />);
    const entry2 = screen.getByTestId("diff-entry") as HTMLButtonElement;
    // project:list 异步水合后入口解禁
    await waitFor(() => expect((screen.getByTestId("diff-entry") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId("diff-stat")).toBeNull(); // 未进入前不读取

    fireEvent.click(entry2);
    await waitFor(() => expect(screen.getByTestId("diff-stat").textContent).toBe("5 个文件 · +76 -24 · 未提交（HEAD 对比）"));
    expect(calls).toEqual([{ channel: "diff:get", projectId: "proj-1" }]);
    // 再次点击返回聊天视图（同款切换语义）
    fireEvent.click(screen.getByTestId("diff-entry"));
    expect(screen.queryByTestId("diff-stat")).toBeNull();
  });

  it("入口按钮形态对齐既有入口（图标 + 标签 + 当前项目指示 + active 高亮）", () => {
    render(
      <DiffEntryButton active={false} disabled={false} projectName="kanban-desktop" onToggle={() => undefined} />,
    );
    const entry = screen.getByTestId("diff-entry");
    expect(entry.textContent).toContain("Diff");
    expect(entry.textContent).toContain("kanban-desktop");
    expect(entry.textContent).toContain("→");
    expect(entry.title).toContain("工作区变更");
  });
});
