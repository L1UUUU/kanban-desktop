// 用途：ModelCombobox 密封测试（A 类，issue #77 / spec #75）—— 四状态（就绪含默认角标/过滤/加载中/错误含原因行）、手输列表外 id 兜底、就绪后默认选中、会话模式派生显示不回调
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelEntry, ModelsResult } from "@kanban/ipc-schema";
import { useState } from "react";
import { ModelCatalog } from "../model-catalog";
import { ModelCombobox } from "./ModelCombobox";

// 测试目录（对齐原型示例形态：默认项 + 多候选，供过滤/角标断言）
const MODELS: ModelEntry[] = [
  { id: "gpt-5.6-luna", displayName: "GPT-5.6", description: "", isDefault: true },
  { id: "gpt-6-luna", displayName: "GPT-6", description: "", isDefault: false },
  { id: "gpt-6.1-terra", displayName: "GPT-6.1 Terra", description: "", isDefault: false },
];

const OK: ModelsResult = { ok: true, models: MODELS };

/** 受控 Harness：真实回写 value（组件是受控控件， onChange → state → 重渲染闭环） */
function Harness(props: { catalog: ModelCatalog; initial?: string; autoSelectDefault?: boolean; onChange?: (m: string) => void }) {
  const [value, setValue] = useState<string | undefined>(props.initial);
  return (
    <ModelCombobox
      cli="codex"
      cwd="C:\\repo"
      catalog={props.catalog}
      value={value}
      autoSelectDefault={props.autoSelectDefault}
      onChange={(m) => {
        props.onChange?.(m);
        setValue(m);
      }}
    />
  );
}

/** 装配：挂起 fetcher 的目录 + 受控组件（resolve 前处于加载态，测试逐拍释放） */
function setup(opts?: { initial?: string; autoSelectDefault?: boolean }) {
  const onChange = vi.fn();
  let reply!: (r: ModelsResult) => void;
  const catalog = new ModelCatalog(
    () =>
      new Promise<ModelsResult>((res) => {
        reply = res;
      }),
  );
  render(<Harness catalog={catalog} initial={opts?.initial} autoSelectDefault={opts?.autoSelectDefault} onChange={onChange} />);
  const input = () => screen.getByRole("combobox") as HTMLInputElement;
  return { onChange, catalog, input, resolve: (r: ModelsResult) => reply(r) };
}

afterEach(cleanup);

describe("ModelCombobox（四状态与交互，原型一致项）", () => {
  it("加载中：输入框显示加载提示且只读", () => {
    const t = setup();
    expect(t.input().value).toBe("模型列表加载中…");
    expect(t.input().readOnly).toBe(true);
  });

  it("就绪：默认选中 isDefault 项（autoSelectDefault 回调）+ 菜单「默认」角标与 id 副行", async () => {
    const t = setup({ autoSelectDefault: true });
    t.resolve(OK);
    await waitFor(() => expect(t.input().value).toBe("GPT-5.6"));
    expect(t.onChange).toHaveBeenCalledWith("gpt-5.6-luna"); // 就绪即默认选中（所见即所发的数据源）
    expect(t.input().readOnly).toBe(false);
    // 打开菜单：默认项带角标；候选带完整 id 副行；尾行手输提示
    fireEvent.focus(t.input());
    expect(screen.getByText("默认")).toBeTruthy();
    expect(screen.getByText("GPT-6.1 Terra")).toBeTruthy();
    expect(screen.getAllByText("gpt-6-luna").length).toBeGreaterThanOrEqual(1); // id 副行
    expect(screen.getByText("未在列表中？直接输入模型 id")).toBeTruthy();
  });

  it("过滤：输入即过滤 displayName / id，不分大小写", async () => {
    const t = setup();
    t.resolve(OK);
    await waitFor(() => expect(t.input().value).toBe("GPT-5.6"));
    fireEvent.focus(t.input());
    fireEvent.change(t.input(), { target: { value: "TERRA" } });
    expect(screen.getByText("GPT-6.1 Terra")).toBeTruthy();
    expect(screen.queryByText("GPT-6", { exact: true })).toBeNull(); // 非匹配项隐藏
    expect(screen.getByText("匹配 1 项 · 回车使用输入内容")).toBeTruthy();
    fireEvent.change(t.input(), { target: { value: "LUNA" } }); // 按 id 过滤同样不分大小写（命中含 luna 的 id，不含 terra）
    expect(screen.getByText("GPT-6", { exact: true })).toBeTruthy();
    expect(screen.queryByText("GPT-6.1 Terra")).toBeNull();
    expect(screen.getByText("匹配 2 项 · 回车使用输入内容")).toBeTruthy();
  });

  it("手输列表外 id：回车直接使用输入内容（下发原样）", async () => {
    const t = setup();
    t.resolve(OK);
    await waitFor(() => expect(t.input().value).toBe("GPT-5.6"));
    fireEvent.change(t.input(), { target: { value: "my-custom-model" } });
    fireEvent.keyDown(t.input(), { key: "Enter" });
    expect(t.onChange).toHaveBeenCalledWith("my-custom-model");
    expect(t.input().value).toBe("my-custom-model"); // 展示原始 id
  });

  it("点选候选：回填 displayName 并收起菜单", async () => {
    const t = setup();
    t.resolve(OK);
    await waitFor(() => expect(t.input().value).toBe("GPT-5.6"));
    fireEvent.focus(t.input());
    fireEvent.click(screen.getByText("GPT-6.1 Terra"));
    expect(t.onChange).toHaveBeenCalledWith("gpt-6.1-terra");
    await waitFor(() => expect(t.input().value).toBe("GPT-6.1 Terra"));
    expect(screen.queryByText("未在列表中？直接输入模型 id")).toBeNull(); // 菜单已收起
  });

  it("拉取失败：原因行 + 手输提示；手输 id 后仍可使用", async () => {
    const t = setup();
    t.resolve({ ok: false, error: { code: "E_SPAWN_NOT_FOUND", message: "未找到 codex 可执行文件" } });
    await waitFor(() => expect(t.input().readOnly).toBe(false));
    fireEvent.focus(t.input());
    expect(screen.getByText("模型列表获取失败：未找到 codex 可执行文件")).toBeTruthy();
    expect(screen.getByText("手动输入模型 id 后回车")).toBeTruthy();
    // 手输兜底：错误态不提供「默认/自选」逃生项，列表外 id 直接可用
    expect(screen.queryByText("未在列表中？直接输入模型 id")).toBeNull();
    fireEvent.change(t.input(), { target: { value: "gpt-6-luna" } });
    fireEvent.keyDown(t.input(), { key: "Enter" });
    expect(t.onChange).toHaveBeenCalledWith("gpt-6-luna");
  });

  it("会话模式（不自动选中）：模型为空时派生显示默认名，不回调 onChange（不写 store）", async () => {
    const t = setup(); // autoSelectDefault 缺省 false（已建会话 composer 语义）
    t.resolve(OK);
    await waitFor(() => expect(t.input().value).toBe("GPT-5.6"));
    expect(t.onChange).not.toHaveBeenCalled();
  });

  it("选中值不在列表（手输历史）：显示原始 id", async () => {
    const t = setup({ initial: "custom-old" });
    t.resolve(OK);
    await waitFor(() => expect(t.input().value).toBe("custom-old"));
  });

  it("列表就绪但零默认项（claude 实测边界，#78 实证）：不自动选中不死循环，用户自选/手输可用", async () => {
    const t = setup({ autoSelectDefault: true });
    t.resolve({ ok: true, models: MODELS.map((m) => ({ ...m, isDefault: false })) });
    // 无 isDefault 命中：保持未选中（不回调、不循环重试），输入框空白可编辑
    await waitFor(() => expect(t.input().readOnly).toBe(false));
    expect(t.onChange).not.toHaveBeenCalled();
    expect(t.input().value).toBe("");
    // 手动选择/手输仍可用
    fireEvent.change(t.input(), { target: { value: "gpt-6-luna" } });
    fireEvent.keyDown(t.input(), { key: "Enter" });
    expect(t.onChange).toHaveBeenCalledWith("gpt-6-luna");
  });
});
