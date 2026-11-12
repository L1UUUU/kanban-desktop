// 用途：需求卡片行内编辑密封测试（#84 T2）—— 悬浮编辑按钮进入行内编辑、Enter/blur 提交走 onRename、Esc 还原、失败回滚原值 + 行内错误提示、空/未变不提交（组件级 seam；事件流持久化由 KanbanWorkspace.test 全链覆盖）
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { RequirementCardRow } from "@kanban/ipc-schema";
import { RequirementCard } from "./RequirementCard";

const CARD: RequirementCardRow = {
  id: "REQ-001",
  title: "待命名需求",
  stage: null,
  stageBasis: null,
  uncertain: false,
  projectId: "P1",
  sessions: [],
};

/** 受控闭环 harness（ModelCombobox.test 同模式）：editing 由本 harness 状态驱动，onStartEdit/onEndEdit 翻转 */
function mount(over?: {
  card?: RequirementCardRow;
  initialEditing?: boolean;
  renameResult?: Promise<string | null>;
}) {
  const calls = {
    open: [] as RequirementCardRow[],
    rename: [] as { id: string; title: string }[],
    startEdit: 0,
    endEdit: 0,
  };
  const renameFn = vi.fn((id: string, title: string) => {
    calls.rename.push({ id, title });
    return over?.renameResult ?? Promise.resolve(null);
  });
  function Harness() {
    const [editing, setEditing] = useState(over?.initialEditing ?? false);
    return (
      <RequirementCard
        card={over?.card ?? CARD}
        active={false}
        editing={editing}
        onOpen={(card) => {
          calls.open.push(card);
        }}
        onRename={renameFn}
        onStartEdit={() => {
          calls.startEdit += 1;
          setEditing(true);
        }}
        onEndEdit={() => {
          calls.endEdit += 1;
          setEditing(false);
        }}
      />
    );
  }
  render(<Harness />);
  return { calls, renameFn };
}

afterEach(cleanup);

describe("RequirementCard 行内编辑（#84 T2）", () => {
  it("悬浮编辑按钮：点击进入行内编辑（预填当前标题），Enter 提交走 onRename，成功后退出编辑", async () => {
    const { calls } = mount();
    expect(screen.getByTestId("card-edit-button").getAttribute("title")).toBe("重命名需求");
    fireEvent.click(screen.getByTestId("card-edit-button"));
    expect(calls.startEdit).toBe(1);
    expect(screen.queryByTestId("card-edit-button")).toBeNull(); // 编辑态不再显示编辑按钮
    const input = screen.getByTestId("card-title-input") as HTMLInputElement;
    expect(input.value).toBe("待命名需求"); // 预填当前标题
    fireEvent.change(input, { target: { value: "  调研桌面端打包方案  " } });
    fireEvent.keyDown(input, { key: "Enter" }); // Enter 直接提交（提交哨兵防残余 blur 双发）
    await vi.waitFor(() => expect(calls.rename).toEqual([{ id: "REQ-001", title: "调研桌面端打包方案" }]));
    await vi.waitFor(() => expect(screen.queryByTestId("card-title-input")).toBeNull());
    expect(calls.endEdit).toBe(1);
    expect(screen.queryByTestId("card-rename-error")).toBeNull(); // 成功无错误提示
  });

  it("Esc 还原：放弃草稿不提交 onRename，退出行内编辑保持原标题", () => {
    const { calls } = mount();
    fireEvent.click(screen.getByTestId("card-edit-button"));
    const input = screen.getByTestId("card-title-input");
    fireEvent.change(input, { target: { value: "被放弃的草稿" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(calls.rename).toHaveLength(0);
    expect(screen.queryByTestId("card-title-input")).toBeNull();
    expect(screen.getByText("待命名需求")).toBeTruthy(); // 标题保持原值
    fireEvent.blur(input); // 退出后残余 blur 不重复触发（哨兵）
    expect(calls.rename).toHaveLength(0);
  });

  it("blur 直接提交（不经 Enter）", async () => {
    const { calls } = mount();
    fireEvent.click(screen.getByTestId("card-edit-button"));
    fireEvent.change(screen.getByTestId("card-title-input"), { target: { value: "新标题" } });
    fireEvent.blur(screen.getByTestId("card-title-input"));
    await vi.waitFor(() => expect(calls.rename).toEqual([{ id: "REQ-001", title: "新标题" }]));
  });

  it("空串/纯空白/未变：不提交 onRename，直接退出编辑", async () => {
    const { calls } = mount();
    fireEvent.click(screen.getByTestId("card-edit-button"));
    fireEvent.change(screen.getByTestId("card-title-input"), { target: { value: "   " } });
    fireEvent.blur(screen.getByTestId("card-title-input"));
    await vi.waitFor(() => expect(screen.queryByTestId("card-title-input")).toBeNull());
    expect(calls.rename).toHaveLength(0);
    // 未变同型：再进一次编辑不改内容直接 blur
    fireEvent.click(screen.getByTestId("card-edit-button"));
    fireEvent.blur(screen.getByTestId("card-title-input"));
    expect(calls.rename).toHaveLength(0);
    expect(calls.endEdit).toBe(2);
  });

  it("重命名失败：标题回滚原值 + 行内错误提示（不再静默）；再次进入编辑清提示", async () => {
    mount({ renameResult: Promise.resolve("需求不存在：REQ-001") });
    fireEvent.click(screen.getByTestId("card-edit-button"));
    fireEvent.change(screen.getByTestId("card-title-input"), { target: { value: "注定失败的名字" } });
    fireEvent.blur(screen.getByTestId("card-title-input"));
    await vi.waitFor(() => expect(screen.getByTestId("card-rename-error").textContent).toBe("需求不存在：REQ-001"));
    expect(screen.queryByTestId("card-title-input")).toBeNull();
    expect(screen.getByText("待命名需求")).toBeTruthy(); // 回滚为原值（store 未变）
    // 再次进入编辑 → 错误提示清除
    fireEvent.click(screen.getByTestId("card-edit-button"));
    expect(screen.queryByTestId("card-rename-error")).toBeNull();
    fireEvent.blur(screen.getByTestId("card-title-input")); // 收尾退出
  });

  it("editing 属性驱动（建卡即命名）：挂载即行内编辑态", () => {
    const { calls } = mount({ initialEditing: true });
    expect((screen.getByTestId("card-title-input") as HTMLInputElement).value).toBe("待命名需求");
    expect(screen.getByTestId("requirement-card")).toBeTruthy(); // 卡片根节点仍在
    fireEvent.keyDown(screen.getByTestId("card-title-input"), { key: "Escape" });
    expect(calls.rename).toHaveLength(0);
    expect(calls.endEdit).toBe(1); // Esc 后由父层清 editingId
  });
});
