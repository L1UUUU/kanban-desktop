// 用途：use-workspace-diff 控制器密封测试（#47，spec #40 E 节/F13）—— 并发刷新 latest-wins：连续两次 refresh 的交错响应，旧响应被丢弃只渲染最新一次；切项目后旧项目在途响应同样丢弃（不乱序覆盖）
import { cleanup, render, screen, act } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DiffRequest, DiffResult } from "@kanban/ipc-schema";
import type { DiffTransport } from "./diff-transport";
import { useWorkspaceDiff } from "./use-workspace-diff";

afterEach(cleanup);

/** 延迟应答 transport：按调用序挂起，测试手动控制释放顺序模拟乱序返回 */
interface DeferredCall {
  req: DiffRequest;
  resolve: (r: DiffResult) => void;
}

function makeDeferredTransport(): { transport: DiffTransport; calls: DeferredCall[] } {
  const calls: DeferredCall[] = [];
  return {
    calls,
    transport: {
      invoke: (req) =>
        new Promise<DiffResult>((resolve) => {
          calls.push({ req, resolve });
        }),
    },
  };
}

/** 成功结果造器（文件名区分新旧响应） */
function okFiles(paths: string[]): DiffResult {
  return {
    ok: true,
    truncated: false,
    files: paths.map((path) => ({ path, changeType: "modified", binary: false, oldPath: null, hunks: null, additions: 1, deletions: 0 })),
  };
}

/** 挂载控制器 harness：暴露 refresh 按钮与状态渲染（ok 态渲染文件路径） */
function mountHarness(transport: DiffTransport | null, projectId: string | null): { rerender(next: string | null): void } {
  const Harness = (props: { projectId: string | null }): React.ReactElement => {
    const controller = useWorkspaceDiff(transport, props.projectId);
    return (
      <div>
        <button data-testid="do-refresh" type="button" onClick={() => void controller.refresh()} />
        <span data-testid="state">{controller.state.status}</span>
        {controller.state.status === "ok" ? controller.state.files.map((f) => <span key={f.path}>{f.path}</span>) : null}
      </div>
    );
  };
  const view = render(<Harness projectId={projectId} />);
  return { rerender: (next) => view.rerender(<Harness projectId={next} />) };
}

describe("useWorkspaceDiff latest-wins（#47 并发/连续刷新丢弃过期响应）", () => {
  it("两次 refresh 交错返回：旧响应（后到）被丢弃，只渲染最新一次结果", async () => {
    const { transport, calls } = makeDeferredTransport();
    mountHarness(transport, "p-1");
    // 挂载自动读取 → 调用 #1；再手动刷新 → 调用 #2
    await act(async () => {
      fireEventRefresh();
    });
    expect(calls).toHaveLength(2);

    // 调用 #1（旧）先带旧结果返回：必须被丢弃（仍是 loading）
    await act(async () => {
      calls[0].resolve(okFiles(["old.ts"]));
    });
    expect(screen.getByTestId("state").textContent).toBe("loading");
    expect(screen.queryByText("old.ts")).toBeNull();

    // 调用 #2（新）返回：渲染新结果
    await act(async () => {
      calls[1].resolve(okFiles(["new.ts"]));
    });
    expect(screen.getByTestId("state").textContent).toBe("ok");
    expect(screen.getByText("new.ts")).toBeTruthy();
    expect(screen.queryByText("old.ts")).toBeNull();
  });

  it("切项目后旧项目在途响应被丢弃，渲染新项目结果", async () => {
    const { transport, calls } = makeDeferredTransport();
    const h = mountHarness(transport, "p-1");
    // p-1 自动读取在途时切到 p-2 → 触发 p-2 自动读取
    h.rerender("p-2");
    await act(async () => {});
    expect(calls).toHaveLength(2);
    expect(calls[1].req).toMatchObject({ projectId: "p-2" });

    await act(async () => {
      calls[0].resolve(okFiles(["from-p1.ts"])); // 旧项目响应迟到 → 丢弃
    });
    expect(screen.getByTestId("state").textContent).toBe("loading");
    expect(screen.queryByText("from-p1.ts")).toBeNull();

    await act(async () => {
      calls[1].resolve(okFiles(["from-p2.ts"]));
    });
    expect(screen.getByText("from-p2.ts")).toBeTruthy();
  });

  it("卸载视图后迟到响应不产生状态写入（不抛错）", async () => {
    const { transport, calls } = makeDeferredTransport();
    const h = mountHarness(transport, "p-1");
    h.rerender(null); // projectId 变 null：effect 重跑但不再发起读取
    await act(async () => {
      calls[0].resolve(okFiles(["late.ts"]));
    });
    expect(screen.getByTestId("state").textContent).toBe("loading");
  });
});

// 触发 harness 内的手动刷新按钮（fireEvent 在 act 内包裹）
function fireEventRefresh(): void {
  const btn = screen.getByTestId("do-refresh") as HTMLButtonElement;
  btn.click();
}
