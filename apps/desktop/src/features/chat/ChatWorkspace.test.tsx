// 用途：聊天区组件测试（spec Testing seam 4）—— FakeAdapter 事件流直连驱动真实组件：流式/工具卡/审批三键/取消/权限切换/切会话不中断（对照原型一致项 5/6/7）
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AdapterEvent, IpcRequest, IpcResult } from "@kanban/ipc-schema";
import { FakeAdapter, VirtualClock } from "@kanban/cli-host";
import { handleIpc } from "../../../electron/main/ipc";
import { ChatWorkspace } from "./ChatWorkspace";
import type { ChatController } from "./use-chat";
import type { ChatTransport } from "../../lib/kanban-api";

/** FakeAdapter 直连 transport：复用 Main 路由（handleIpc）做请求侧，adapter.subscribe 做事件侧 —— 组件测试即全栈（除 Electron IPC） */
function makeTransport(adapter: FakeAdapter): ChatTransport {
  return {
    invoke: (req: IpcRequest) => handleIpc(adapter, req),
    onEvent: (h: (e: AdapterEvent) => void) => adapter.subscribe(h),
  };
}

/** 挂载工作区并暴露 controller（供测试直接驱动动作） */
function mount(transport?: ChatTransport) {
  const clock = new VirtualClock();
  const adapter = new FakeAdapter({ clock });
  const tr = transport ?? makeTransport(adapter);
  const holder: { controller?: ChatController } = {};
  const onController = (c: ChatController): void => {
    holder.controller = c;
  };
  render(<ChatWorkspace transport={tr} onController={onController} />);
  const ctl = (): ChatController => {
    if (!holder.controller) throw new Error("controller 未就绪");
    return holder.controller;
  };
  return {
    clock,
    ctl,
    advance: () =>
      act(() => {
        clock.runToIdle();
      }),
    /** 冲刷微任务链（invoke → adapter → store → 重渲染） */
    flush: async () =>
      act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      }),
  };
}

/** 输入并发送一条消息 */
function send(text: string): void {
  const box = screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…");
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "发送 ➤" }));
}

describe("聊天区（原型一致项 5/6/7）", () => {
  it("启动自动创建首个会话：侧栏会话行 + composer 可用", async () => {
    const t = mount();
    await t.flush();
    expect(screen.getByText("演示会话 · Fake")).toBeTruthy();
    expect(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "发送 ➤" })).toBeTruthy();
    expect(screen.getByText("空闲")).toBeTruthy();
  });

  it("默认演示：用户回显 + 助手全文 + 工具卡完成（名称/参数/时长/输出）", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("把 ipc-schema 的类型拆成独立文件");
    });
    t.advance();
    expect(screen.getByText("把 ipc-schema 的类型拆成独立文件")).toBeTruthy();
    expect(screen.getByText("好的，我先跑一遍现有测试确认基线，然后开始拆分。")).toBeTruthy();
    expect(
      screen.getByText("基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。"),
    ).toBeTruthy();
    // 工具卡：工具名 + 参数摘要 + 终态时长 + 输出
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getAllByText(/pnpm vitest run --filter ipc-schema/).length).toBeGreaterThanOrEqual(2); // 卡头参数 + 输出行
    expect(screen.getByText("完成 · 3.6s")).toBeTruthy();
    expect(screen.getByText(/Tests\s+13 passed/)).toBeTruthy();
  });

  it("流式中：光标可见、输入禁用、发送钮替换为「⏹ 停止输出」；完成后恢复", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("默认演示");
    });
    act(() => {
      t.clock.advance(700); // 过 600ms 等待后进入流式
    });
    expect(screen.getByText("▍")).toBeTruthy();
    expect(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "⏹ 停止输出" })).toBeTruthy();
    t.advance();
    expect(screen.queryByText("▍")).toBeNull();
    expect(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…")).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "发送 ➤" })).toBeTruthy();
    expect(screen.getByText("空闲")).toBeTruthy();
  });

  it("取消：停止后显示「本轮已取消」提示 + 状态已中断；可继续发消息（一致项 7）", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("默认演示");
    });
    act(() => {
      t.clock.advance(700);
    });
    fireEvent.click(screen.getByRole("button", { name: "⏹ 停止输出" }));
    expect(await screen.findByText("— 本轮已取消，会话保留，可继续发消息 —")).toBeTruthy();
    expect(screen.getByText("已中断")).toBeTruthy();
    // 会话保留：可继续发消息
    await act(async () => {
      send("再来一轮");
    });
    t.advance();
    expect(screen.getByText("空闲")).toBeTruthy();
    expect(screen.getByText("再来一轮")).toBeTruthy();
  });

  it("审批卡：命令 + suggestions 文案 + 三键；拒绝 → 工具已拒绝 + 道歉文本 + 回到空闲", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("审批演示");
    });
    t.advance();
    expect(screen.getByText(/⚙ 需要审批：Edit packages\/ipc-schema\/src\/index\.ts/)).toBeTruthy();
    expect(screen.getByText("允许规则")).toBeTruthy();
    expect(screen.getByText(/Edit\(src\/\*\*\) 后续免询问/)).toBeTruthy();
    expect(screen.getByText(/packages\/ipc-schema\/\*\* 整目录/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "允许一次" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "总是允许" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeTruthy();
    expect(screen.getByText("等待审批")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    t.advance();
    expect(screen.getByText("已拒绝")).toBeTruthy();
    expect(screen.getByText("好的，我不改这个文件。需要我先列出计划再逐条确认吗？")).toBeTruthy();
    expect(screen.getByText("空闲")).toBeTruthy();
  });

  it("审批：允许一次 → 「仅本次允许」且第二个审批仍会询问；再允许后完成", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("审批演示");
    });
    t.advance();
    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    t.advance();
    expect(screen.getByText(/仅本次允许/)).toBeTruthy();
    // 第二次审批再次出现（once 不记住规则）—— 决定即时改变后续输出（一致项 7）
    expect(screen.getByText(/⚙ 需要审批：Edit packages\/ipc-schema\/src\/session\/create\.ts/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "总是允许" }));
    t.advance();
    expect(screen.getByText("拆分完成，index.ts 的导出面保持不变，测试仍然全绿。")).toBeTruthy();
  });

  it("审批：总是允许 → 「记住规则」且第二个审批直接跳过", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("审批演示");
    });
    t.advance();
    fireEvent.click(screen.getByRole("button", { name: "总是允许" }));
    t.advance();
    expect(screen.getAllByText(/记住规则，后续同类不再询问/).length).toBeGreaterThanOrEqual(2); // 首个决定 + 第二个自动放行
    // 第二个审批不再询问：直接出现终文
    expect(screen.getByText("拆分完成，index.ts 的导出面保持不变，测试仍然全绿。")).toBeTruthy();
  });

  it("审批过期：5s 内展示审批卡，过期后卡片消失 + 过期文案（服务端终态演示）", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("过期演示");
    });
    act(() => {
      t.clock.advance(3000); // 到审批等待、未过期
    });
    expect(screen.getByText("rm -rf node_modules")).toBeTruthy(); // 工具卡参数（审批卡命令含 Bash 前缀）
    expect(screen.getByRole("button", { name: "允许一次" })).toBeTruthy();
    t.advance(); // 5000ms 过期触发
    expect(screen.queryByRole("button", { name: "允许一次" })).toBeNull();
    expect(screen.getByText(/审批已过期/)).toBeTruthy();
    expect(screen.getByText("已拒绝")).toBeTruthy();
  });

  it("错误演示：⚠ 错误提示可见、不崩溃、可继续", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("错误演示");
    });
    t.advance();
    expect(screen.getByText(/Fake CLI 进程意外退出/)).toBeTruthy();
    expect(screen.getByText("空闲")).toBeTruthy();
  });

  it("composer（一致项 6）：权限 chip 三档切换（菜单含说明文案）+ 模型选择", async () => {
    const t = mount();
    await t.flush();
    expect(screen.getByText("⚡ 权限：自动 ▾")).toBeTruthy();
    fireEvent.click(screen.getByText("⚡ 权限：自动 ▾"));
    // 三档菜单 + 说明（原型文案硬约束）
    expect(screen.getByText("🔒 请求")).toBeTruthy();
    expect(screen.getByText("所有工具调用前弹出审批卡片")).toBeTruthy();
    expect(screen.getByText("⚡ 自动（推荐）")).toBeTruthy();
    expect(screen.getByText("安全操作放行，风险操作（写文件/命令）弹审批")).toBeTruthy();
    expect(screen.getByText("🔓 完全访问")).toBeTruthy();
    expect(screen.getByText("全部自动放行，不弹任何审批")).toBeTruthy();
    fireEvent.click(screen.getByText("🔒 请求"));
    expect(screen.getByText("🔒 权限：请求 ▾")).toBeTruthy();
    fireEvent.click(screen.getByText("🔒 权限：请求 ▾"));
    fireEvent.click(screen.getByText("🔓 完全访问"));
    expect(screen.getByText("🔓 权限：完全访问 ▾")).toBeTruthy();
    // 模型选择
    const model = screen.getByRole("combobox");
    expect((model as HTMLSelectElement).value).toBe("默认模型");
    fireEvent.change(model, { target: { value: "gpt-5.6-luna" } });
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("gpt-5.6-luna");
  });

  it("切会话不中断（一致项 7）：会话 A 流式中切到 B，A 持续推进，切回 A 全文在", async () => {
    const t = mount();
    await t.flush();
    await act(async () => {
      send("默认演示"); // A 开始流式
    });
    // A 流式中新建并切到 B
    await act(async () => {
      await t.ctl().createSession();
    });
    const activeId = t.ctl().activeId;
    expect(activeId).toBeTruthy();
    expect(screen.getByText("新会话 · Fake")).toBeTruthy();
    t.advance(); // A 在后台完成
    expect(screen.queryByText(/基线全绿/)).toBeNull(); // 当前视图是 B，不显示 A 内容
    // 切回 A：全文在（流式未被切换打断）
    fireEvent.click(screen.getByText("演示会话 · Fake"));
    expect(
      screen.getByText("基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。"),
    ).toBeTruthy();
  });

  it("新建会话：侧栏「＋」菜单（一致项 2 的 Fake 入口）新增会话行并激活", async () => {
    const t = mount();
    await t.flush();
    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    fireEvent.click(screen.getByText("新建 Fake 会话"));
    await t.flush();
    expect(screen.getByText("新会话 · Fake")).toBeTruthy();
    expect(screen.getAllByText("新会话 · Fake").length).toBeGreaterThanOrEqual(1);
  });

  it("IPC 错误结果展示：发送失败（错误码）在聊天区显示错误提示", async () => {
    // 桩 transport：session:create 成功、send 返回错误（模拟 Main 校验拒绝/会话失效）
    let seq = 0;
    const stub: ChatTransport = {
      invoke: async (req: IpcRequest): Promise<IpcResult> => {
        if (req.channel === "session:create") {
          seq += 1;
          return { ok: true, sessionId: `s-${seq}`, cli: "fake", title: "演示会话 · Fake" };
        }
        return { ok: false, error: { code: "E_SESSION_NOT_FOUND", message: "会话不存在：s-1" } };
      },
      onEvent: () => () => undefined,
    };
    const t = mount(stub);
    await t.flush();
    await act(async () => {
      send("任何消息");
    });
    expect(await screen.findByText(/会话不存在/)).toBeTruthy();
  });
});
