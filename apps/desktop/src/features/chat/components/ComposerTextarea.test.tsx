// 用途：斜杠补全菜单密封测试（issue #90 / spec #82 E 块；ADR 0004 零内置）—— 键盘协议（↑↓ 循环/Enter/Tab 接受/Esc 同 token 不重开）、mousedown 焦点保持、IME 合成冻结、预热与 TTL 不重复拉取、单组排序与空态文案
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliKind, IpcResult } from "@kanban/ipc-schema";
import { useState } from "react";
import { ComposerCommandSource } from "../composer-command-source";
import { ComposerTextarea } from "./ComposerTextarea";
import type { MenuCommand } from "./slash-trigger";

afterEach(cleanup);

const CWD = "C:/demo";

/** 命令目录应答 fixture（菜单机制测试数据；ADR 0004 后 fake 通道恒空集，条目仅驱动键盘/过滤/分组断言） */
const FAKE_OK: IpcResult = {
  ok: true,
  commands: [
    { name: "fake-plan", description: "演示命令：请求一份轻量计划", argsHint: null, source: "native", cli: "fake", sourcePath: null, userOnly: false },
    { name: "fake-skill", description: "演示 Skill：模拟技能观察信号", argsHint: "$ARGUMENTS", source: "native", cli: "fake", sourcePath: null, userOnly: false },
    { name: "fake-user-only", description: "演示仅用户调用标记", argsHint: null, source: "native", cli: "fake", sourcePath: null, userOnly: true },
  ],
};

/** 受控闭环 Harness：value/onChange 由测试持有（会话 Composer 本地态与草稿 store 态同构） */
function Harness(props: {
  source: ComposerCommandSource;
  initial?: string;
  cli?: CliKind;
  disabled?: boolean;
  onAcceptCommand?: (cmd: MenuCommand) => void;
}) {
  const [value, setValue] = useState(props.initial ?? "");
  return (
    <ComposerTextarea
      value={value}
      onChange={setValue}
      commands={props.source}
      cli={props.cli ?? "fake"}
      cwd={CWD}
      disabled={props.disabled ?? false}
      onAcceptCommand={props.onAcceptCommand}
    />
  );
}

/** 挂载 + 等命令源就绪（预热完成；菜单出现另需触发输入） */
async function mountReady(props: Partial<Parameters<typeof Harness>[0]> = {}): Promise<{ source: ComposerCommandSource }> {
  const fetcher = props.source === undefined ? vi.fn(async () => FAKE_OK) : undefined;
  const source = props.source ?? new ComposerCommandSource(fetcher!);
  render(<Harness source={source} {...props} />);
  await waitFor(() => expect(source.getState("fake", CWD).status).toBe("ready"));
  return { source };
}

/** 输入（显式携带光标位，规避 jsdom 受控赋值不移动光标） */
function type(text: string, selectionStart: number): void {
  fireEvent.change(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…"), { target: { value: text, selectionStart } });
}

/** 模拟 IME 合成中的 input（isComposing init 键随事件下发；光标置尾模拟真实输入） */
function imeInput(text: string): void {
  fireEvent.input(ta(), { target: { value: text, selectionStart: text.length }, isComposing: true });
}

function ta(): HTMLTextAreaElement {
  return screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…") as HTMLTextAreaElement;
}

function menu(): HTMLElement | null {
  return screen.queryByTestId("slash-menu");
}

function items(): HTMLElement[] {
  return screen.queryAllByTestId("slash-menu-item");
}

function highlighted(): HTMLElement | undefined {
  return items().find((el) => el.getAttribute("aria-selected") === "true");
}

describe("斜杠补全菜单（键盘协议）", () => {
  it("输入 / 弹菜单：仅 CLI 命令单组（ADR 0004 零内置），名称+描述展示", async () => {
    await mountReady();
    type("/", 1);
    expect(menu()).not.toBeNull();
    // 单组按名称序（无应用命令组）
    expect(items().map((el) => el.textContent)).toEqual([
      expect.stringContaining("/fake-plan"),
      expect.stringContaining("/fake-skill"),
      expect.stringContaining("/fake-user-only"),
    ]);
    // 分组标题（单组：CLI 命令）
    expect(screen.getAllByTestId("slash-menu-group").map((el) => el.textContent)).toEqual(["CLI 命令"]);
    // 名称 + 描述 + 参数提示展示
    expect(items()[0].textContent).toContain("演示命令：请求一份轻量计划");
    expect(items()[1].textContent).toContain("$ARGUMENTS");
  });

  it("过滤：query 缩小候选（前缀/模糊命中），无命中显示空态引导文案", async () => {
    await mountReady();
    type("/fake-sk", 8);
    expect(items().map((el) => el.textContent)).toEqual([expect.stringContaining("/fake-skill")]);
    type("/zzz", 5);
    expect(items()).toEqual([]);
    expect(menu()?.textContent).toContain("无可用命令");
  });

  it("↑↓ 循环高亮：ArrowDown 逐项下移、越尾回绕 0；ArrowUp 越头回绕到尾", async () => {
    await mountReady();
    type("/", 1);
    expect(highlighted()?.textContent).toContain("/fake-plan"); // 初始高亮第 0 项
    fireEvent.keyDown(ta(), { key: "ArrowDown" });
    expect(highlighted()?.textContent).toContain("/fake-skill");
    fireEvent.keyDown(ta(), { key: "ArrowDown" });
    fireEvent.keyDown(ta(), { key: "ArrowDown" }); // 第 3 次：越尾回绕
    expect(highlighted()?.textContent).toContain("/fake-plan");
    fireEvent.keyDown(ta(), { key: "ArrowUp" }); // 越头回绕到尾
    expect(highlighted()?.textContent).toContain("/fake-user-only");
  });

  it("Enter 接受：命令引用置入输入流（/name 尾随空格），光标落在实参位，菜单关闭", async () => {
    await mountReady();
    type("/", 1);
    fireEvent.keyDown(ta(), { key: "ArrowDown" }); // 高亮 /fake-skill
    fireEvent.keyDown(ta(), { key: "Enter" });
    expect(ta().value).toBe("/fake-skill ");
    expect(ta().selectionStart).toBe(12); // 光标在尾随空格后（实参位）
    expect(menu()).toBeNull(); // 替换后新光标处不再触发，菜单关闭
  });

  it("Tab 接受同 Enter；Shift+Tab 不接受（走默认）", async () => {
    await mountReady();
    type("/", 1);
    fireEvent.keyDown(ta(), { key: "Tab", shiftKey: true });
    expect(ta().value).toBe("/"); // 未接受
    fireEvent.keyDown(ta(), { key: "Tab" });
    expect(ta().value).toBe("/fake-plan ");
  });

  it("Esc 关闭且同一 token 不再弹出；token 改变后重新弹出", async () => {
    await mountReady();
    type("/", 1);
    expect(menu()).not.toBeNull();
    fireEvent.keyDown(ta(), { key: "Escape" });
    expect(menu()).toBeNull();
    // 同 token 内按键：不重开
    fireEvent.keyDown(ta(), { key: "ArrowDown" });
    expect(menu()).toBeNull();
    type("/p", 2); // token 改变（query 追加）
    expect(menu()).not.toBeNull();
  });

  it("菜单项 mousedown 接受且焦点留在输入框（preventDefault 不转移焦点）", async () => {
    await mountReady();
    type("/", 1);
    ta().focus();
    // dispatchEvent 对 preventDefault 过的事件返回 false——即「不转移焦点」机制生效的直接证据
    expect(fireEvent.mouseDown(items()[0])).toBe(false); // /fake-plan
    expect(ta().value).toBe("/fake-plan ");
    expect(document.activeElement).toBe(ta()); // 焦点未离开输入框
  });

  it("鼠标悬停同步高亮（mousemove）", async () => {
    await mountReady();
    type("/", 1);
    fireEvent.mouseMove(items()[1]);
    expect(highlighted()?.textContent).toContain("/fake-skill");
  });

  it("选中回调 onAcceptCommand 携带所选命令（cli 组命令）", async () => {
    const onAccept = vi.fn();
    await mountReady({ onAcceptCommand: onAccept });
    type("/", 1);
    fireEvent.keyDown(ta(), { key: "Enter" });
    expect(onAccept).toHaveBeenCalledWith(expect.objectContaining({ name: "fake-plan", group: "cli" }));
  });
});

describe("斜杠补全菜单（IME 合成冻结）", () => {
  it("合成期菜单冻结不闪动：过滤不重算；compositionend 后用最新值重估", async () => {
    await mountReady();
    type("/", 1);
    expect(items().length).toBe(3);
    fireEvent.compositionStart(ta());
    imeInput("/中"); // 合成中草稿变化：冻结快照仍显示全量（不闪不关）
    expect(menu()).not.toBeNull();
    expect(items().length).toBe(3);
    // 合成期 Enter（keyCode 229）不驱动菜单
    fireEvent.keyDown(ta(), { key: "Enter", keyCode: 229 });
    expect(ta().value).toBe("/中");
    expect(menu()).not.toBeNull();
    fireEvent.compositionEnd(ta());
    // 重估：query=「中」无命中 → 空态引导文案（仍开）
    expect(menu()).not.toBeNull();
    expect(items()).toEqual([]);
    expect(menu()?.textContent).toContain("无可用命令");
  });

  it("isComposing 的 keydown 不驱动菜单（Enter 不接受）", async () => {
    await mountReady();
    type("/", 1);
    fireEvent.keyDown(ta(), { key: "Enter", isComposing: true } as Parameters<typeof fireEvent.keyDown>[1]);
    expect(ta().value).toBe("/"); // 未接受，菜单仍开
    expect(menu()).not.toBeNull();
  });
});

describe("斜杠补全菜单（数据源与禁用）", () => {
  it("挂载即预热（首次输入 / 不等冷启动）；TTL 内输入 / 不重复拉取", async () => {
    const fetcher = vi.fn(async () => FAKE_OK);
    const { source } = await mountReady({ source: new ComposerCommandSource(fetcher) });
    expect(fetcher).toHaveBeenCalledTimes(1); // 挂载预热一次
    type("/", 1);
    expect(menu()).not.toBeNull();
    type("/f", 2);
    type("/fa", 3);
    expect(fetcher).toHaveBeenCalledTimes(1); // TTL 内不重复
    expect(source.getState("fake", CWD).status).toBe("ready");
  });

  it("源未就绪不弹空菜单：就绪后才出现", async () => {
    let release!: (r: IpcResult) => void;
    const source = new ComposerCommandSource(
      () =>
        new Promise<IpcResult>((res) => {
          release = res;
        }),
    );
    render(<Harness source={source} />);
    type("/", 1);
    expect(menu()).toBeNull(); // loading：不闪空菜单
    release(FAKE_OK);
    await waitFor(() => expect(menu()).not.toBeNull());
  });

  it("disabled（会话 running / 草稿提交中）不弹菜单；解除后恢复", async () => {
    await mountReady({ disabled: true });
    type("/", 1);
    expect(menu()).toBeNull();
  });

  it("非 slash 草稿不弹；非首 token 的 slash 不弹", async () => {
    await mountReady();
    type("普通消息", 4);
    expect(menu()).toBeNull();
    type("bar /fa", 7);
    expect(menu()).toBeNull();
  });
});
