// 用途：useInlineRename 密封测试（arch D11）——竞态矩阵一处直测：Enter-后-blur/Esc-后-blur 不重复提交、空白/未变跳过、外部值变更同步（toggle 上升沿 / persistent 持续）、失败错误槽与回滚、会话边界哨兵重置（替代三处组件测试各覆盖一遍）
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useInlineRename, type InlineRenameSession } from "./use-inline-rename";

/** toggle 模式挂载（Sidebar/RequirementCard 形态）：props 驱动 active/title 变化 */
function mountToggle(initial: { active?: boolean; title?: string; result?: string | null } = {}) {
  const onCommit = vi.fn(() => Promise.resolve(initial.result ?? null));
  const onSettle = vi.fn();
  const hook = renderHook(
    ({ active, title }: { active: boolean; title: string }) =>
      useInlineRename({ title, onCommit, onSettle, session: { kind: "toggle", active } satisfies InlineRenameSession }),
    { initialProps: { active: initial.active ?? false, title: initial.title ?? "原标题" } },
  );
  return { onCommit, onSettle, ...hook };
}

/** persistent 模式挂载（DetailPanel 形态）：常驻输入，无 onSettle（无编辑态可清） */
function mountPersistent(initial: { title?: string; result?: string | null } = {}) {
  const onCommit = vi.fn(() => Promise.resolve(initial.result ?? null));
  const hook = renderHook(
    ({ title }: { title: string }) => useInlineRename({ title, onCommit, session: { kind: "persistent" } satisfies InlineRenameSession }),
    { initialProps: { title: initial.title ?? "原标题" } },
  );
  return { onCommit, ...hook };
}

/** 触发 onFocus（selectOnFocus 缺省不全选，stub 掉 target 即可） */
function fireFocus(result: { current: ReturnType<typeof useInlineRename> }): void {
  act(() => {
    result.current.onFocus({ target: { select: () => undefined } } as unknown as Parameters<typeof result.current.onFocus>[0]);
  });
}

afterEach(cleanup);

describe("useInlineRename toggle 模式（Sidebar / RequirementCard）", () => {
  it("active 上升沿开新会话：草稿同步外部值，哨兵重置可再次提交", async () => {
    const t = mountToggle();
    act(() => t.rerender({ active: true, title: "原标题" }));
    act(() => t.result.current.onChange("第一次"));
    act(() => t.result.current.commit());
    await waitFor(() => expect(t.onCommit).toHaveBeenCalledTimes(1));
    // settle 后同会话内残余 blur 不重复提交
    act(() => t.result.current.commit());
    expect(t.onCommit).toHaveBeenCalledTimes(1);
    // 下降沿再上升沿 = 新编辑会话：草稿重新同步外部值，可再次提交
    act(() => t.rerender({ active: false, title: "外部已改名" }));
    act(() => t.rerender({ active: true, title: "外部已改名" }));
    expect(t.result.current.draft).toBe("外部已改名");
    act(() => t.result.current.onChange("第二次"));
    act(() => t.result.current.commit());
    await waitFor(() => expect(t.onCommit).toHaveBeenCalledTimes(2));
    expect(t.onCommit).toHaveBeenLastCalledWith("第二次");
  });

  it("Enter 后残余 blur 不重复提交（提交进行中再输入也不重新受理）", async () => {
    const t = mountToggle({ active: true });
    act(() => t.result.current.onChange("  新标题  "));
    act(() => t.result.current.commit());
    expect(t.onCommit).toHaveBeenCalledWith("新标题"); // trim 后提交
    act(() => t.result.current.onChange("提交中又输入"));
    act(() => t.result.current.commit()); // 残余 blur
    await waitFor(() => expect(t.onSettle).toHaveBeenCalledTimes(1)); // settle 只在回调落定后一次
    expect(t.onCommit).toHaveBeenCalledTimes(1);
  });

  it("Esc 还原：草稿回外部值 + settle 收尾，其后 blur 只收尾不提交", () => {
    const t = mountToggle({ active: true });
    act(() => t.result.current.onChange("被放弃的草稿"));
    act(() => t.result.current.cancel());
    expect(t.onCommit).not.toHaveBeenCalled();
    expect(t.result.current.draft).toBe("原标题");
    expect(t.onSettle).toHaveBeenCalledTimes(1);
    act(() => t.result.current.commit()); // Esc 后残余 blur
    expect(t.onCommit).not.toHaveBeenCalled();
    expect(t.onSettle).toHaveBeenCalledTimes(1);
  });

  it("空白/未变跳过：不提交、恢复外部值显示并 settle", () => {
    const t = mountToggle({ active: true });
    act(() => t.result.current.onChange("   "));
    act(() => t.result.current.commit());
    expect(t.onCommit).not.toHaveBeenCalled();
    expect(t.result.current.draft).toBe("原标题");
    expect(t.onSettle).toHaveBeenCalledTimes(1);
    // 未变同型：新会话不改内容直接 blur
    act(() => t.rerender({ active: false, title: "原标题" }));
    act(() => t.rerender({ active: true, title: "原标题" }));
    act(() => t.result.current.onChange("原标题"));
    act(() => t.result.current.commit());
    expect(t.onCommit).not.toHaveBeenCalled();
  });

  it("提交失败：错误槽保持 + 草稿回滚外部值 + 残余 blur 不再提交；重开会话清错误", async () => {
    const t = mountToggle({ active: true, result: "需求不存在：REQ-001" });
    act(() => t.result.current.onChange("注定失败"));
    act(() => t.result.current.commit());
    await waitFor(() => expect(t.result.current.error).toBe("需求不存在：REQ-001"));
    expect(t.result.current.draft).toBe("原标题"); // store 未变，回滚外部值
    act(() => t.result.current.commit()); // 失败后残余 blur 不重复提交
    expect(t.onCommit).toHaveBeenCalledTimes(1);
    // 重开编辑会话：错误清除，提交成功后仍为空
    const ok = mountToggle({ active: true });
    act(() => ok.result.current.onChange("成功"));
    act(() => ok.result.current.commit());
    await waitFor(() => expect(ok.result.current.error).toBeNull());
  });

  it("挂载即编辑（建卡即命名）：初值经 useState 等价成立，Esc 直接还原", () => {
    const t = mountToggle({ active: true, title: "待命名需求" });
    expect(t.result.current.draft).toBe("待命名需求");
    act(() => t.result.current.cancel());
    expect(t.onSettle).toHaveBeenCalledTimes(1);
    expect(t.result.current.draft).toBe("待命名需求");
  });

  it("selectOnFocus：聚焦全选（输入即覆盖缺省标题）", () => {
    const select = vi.fn();
    const { result } = renderHook(() =>
      useInlineRename({
        title: "待命名需求",
        onCommit: () => Promise.resolve(null),
        session: { kind: "toggle", active: true },
        selectOnFocus: true,
      }),
    );
    act(() => {
      result.current.onFocus({ target: { select } } as unknown as Parameters<typeof result.current.onFocus>[0]);
    });
    expect(select).toHaveBeenCalledTimes(1);
  });
});

describe("useInlineRename persistent 模式（DetailPanel 常驻输入）", () => {
  it("外部标题变化持续同步草稿（rename 回流/再水化，不等待会话边界）", () => {
    const t = mountPersistent();
    act(() => t.result.current.onChange("编辑中的草稿"));
    act(() => t.rerender({ title: "外部新标题" }));
    expect(t.result.current.draft).toBe("外部新标题");
  });

  it("Esc 还原后残余 blur 不提交；聚焦开启新会话，未变仍不提交", () => {
    const t = mountPersistent();
    act(() => t.result.current.onChange("被放弃的草稿"));
    act(() => t.result.current.cancel());
    expect(t.result.current.draft).toBe("原标题");
    act(() => t.result.current.commit()); // Esc 后残余 blur
    expect(t.onCommit).not.toHaveBeenCalled();
    // 重新聚焦 = 新编辑会话；未改内容 blur 走跳过路径
    fireFocus(t.result);
    act(() => t.result.current.commit());
    expect(t.onCommit).not.toHaveBeenCalled();
    expect(t.result.current.draft).toBe("原标题");
  });

  it("新输入即新意图：失败 settle 后再输入可再次提交，成功清错误", async () => {
    let fail = true;
    const onCommit = vi.fn((next: string) => Promise.resolve(fail && next === "注定失败" ? "需求不存在：REQ-009" : null));
    const { result } = renderHook(({ title }) => useInlineRename({ title, onCommit, session: { kind: "persistent" } }), {
      initialProps: { title: "原标题" },
    });
    act(() => result.current.onChange("注定失败"));
    act(() => result.current.commit());
    await waitFor(() => expect(result.current.error).toBe("需求不存在：REQ-009"));
    expect(result.current.draft).toBe("原标题");
    act(() => result.current.commit()); // settle 后残余 blur 不重复提交
    expect(onCommit).toHaveBeenCalledTimes(1);
    // 新输入解除哨兵 → 再次提交成功 → 错误清除（等待 .then 落定，不与微任务竞速）
    fail = false;
    act(() => result.current.onChange("成功的新标题"));
    act(() => result.current.commit());
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.error).toBeNull());
  });
});
