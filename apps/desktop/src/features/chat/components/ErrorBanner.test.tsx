// 用途：ErrorBanner 五卡信息结构密封测试（#46 验收 2 / spec I 一致项 2）—— 四类 + 未知兜底，按原型 d2：标题头/原因区（含原始信息）/指引命令块（认证）/动作按钮
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBanner } from "./ErrorBanner";

afterEach(() => {
  cleanup();
  // clipboard 桩还原（jsdom 无真实剪贴板）
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
});

/** clipboard 桩：记录全部 writeText 入参 */
function stubClipboard(): string[] {
  const writes: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async (text: string) => void writes.push(text) },
    configurable: true,
  });
  return writes;
}

/** 全动作桩（渲染任一卡都可用） */
function actions() {
  return {
    onResume: vi.fn(),
    onRetry: vi.fn(),
    onOpenPtyTerminal: vi.fn(),
    onDismiss: vi.fn(),
  };
}

describe("卡 1：CLI 进程异常退出（源② E_SESSION_EXIT / 源① CLI_EXIT）", () => {
  it("标题 + 会话不受影响说明 + 不会自动重放 + 原始信息保留；动作「读取原生历史并恢复」触发 onResume（D4 同一恢复动作）+「知道了」onDismiss", () => {
    const a = actions();
    render(
      <ErrorBanner
        code="E_SESSION_EXIT"
        message="CLI 进程已退出（exit 1：crash），会话已断开"
        cli="claude"
        title="修复启动崩溃"
        canRetry
        {...a}
      />,
    );
    const card = screen.getByTestId("error-card");
    expect(card.textContent).toContain("CLI 进程异常退出");
    expect(card.textContent).toContain("已产生的对话与文件修改不受影响");
    expect(card.textContent).toContain("不会自动重放");
    expect(card.textContent).toContain("CLI 进程已退出（exit 1：crash）");
    fireEvent.click(screen.getByRole("button", { name: "读取原生历史并恢复" }));
    expect(a.onResume).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(a.onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("卡 2：认证失效（AUTH_EXPIRED，US 10）", () => {
  it("按 CLI 显示具体指引命令块（claude 两步）+「重试」+「打开 PTY 终端」；原始信息保留", () => {
    const a = actions();
    render(
      <ErrorBanner
        code="AUTH_EXPIRED"
        message="Failed to authenticate. API Error: 401"
        cli="claude"
        title="修复启动崩溃"
        canRetry
        canOpenPtyTerminal
        {...a}
      />,
    );
    const card = screen.getByTestId("error-card");
    expect(card.textContent).toContain("登录已失效（Claude）");
    // 指引命令块（等宽底色块内容）：claude 两步命令
    expect(screen.getByTestId("auth-cmd").textContent).toContain("claude");
    expect(screen.getByTestId("auth-cmd").textContent).toContain("/login");
    expect(card.textContent).toContain("Failed to authenticate. API Error: 401");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(a.onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "打开 PTY 终端" }));
    expect(a.onOpenPtyTerminal).toHaveBeenCalledTimes(1);
  });

  it("codex 会话显示 codex login 单命令", () => {
    render(
      <ErrorBanner
        code="AUTH_EXPIRED"
        message="401 Unauthorized"
        cli="codex"
        title="t"
        canRetry
        canOpenPtyTerminal
        {...actions()}
      />,
    );
    expect(screen.getByTestId("auth-cmd").textContent).toContain("codex login");
  });

  it("无 PTY 可开（会话无 cwd）时不渲染「打开 PTY 终端」", () => {
    render(
      <ErrorBanner code="AUTH_EXPIRED" message="m" cli="codex" title="t" canRetry canOpenPtyTerminal={false} {...actions()} />
    );
    expect(screen.queryByRole("button", { name: "打开 PTY 终端" })).toBeNull();
  });
});

describe("卡 3：找不到 CLI 程序（SPAWN_NOT_FOUND，US 11）", () => {
  it("标题带 CLI 名 + 安装/PATH/配置文件指引 + 配置路径 +「重试」+「复制配置路径」", async () => {
    const writes = stubClipboard();
    const a = actions();
    render(
      <ErrorBanner
        code="SPAWN_NOT_FOUND"
        message="未找到 opencode 可执行文件（已尝试：npm 全局；where）"
        cli="opencode"
        title="t"
        canRetry
        configPath={"C:\\UserData\\config.json"}
        {...a}
      />,
    );
    const card = screen.getByTestId("error-card");
    expect(card.textContent).toContain("找不到 CLI 程序（OpenCode）");
    expect(card.textContent).toContain("确认已安装并在 PATH 中");
    expect(card.textContent).toContain("C:\\UserData\\config.json");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(a.onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "复制配置路径" }));
    await waitFor(() => expect(writes).toEqual(["C:\\UserData\\config.json"]));
  });

  it("configPath 不可用（null）时不渲染「复制配置路径」", () => {
    render(<ErrorBanner code="SPAWN_NOT_FOUND" message="m" cli="codex" title="t" canRetry {...actions()} />);
    expect(screen.queryByRole("button", { name: "复制配置路径" })).toBeNull();
  });
});

describe("卡 4：协议断连（PROTOCOL_DISCONNECT，US 12）", () => {
  it("标题带 CLI 名 + 原因说明（server 退出/端口占用/网络抖动）+ 按需重新拉起 server +「恢复会话」onResume +「知道了」", () => {
    const a = actions();
    render(
      <ErrorBanner code="PROTOCOL_DISCONNECT" message="opencode server 请求失败：fetch failed" cli="opencode" title="t" {...a} />
    );
    const card = screen.getByTestId("error-card");
    expect(card.textContent).toContain("连接中断（OpenCode）");
    expect(card.textContent).toContain("server 进程退出、端口被占用或网络抖动");
    expect(card.textContent).toContain("恢复时将按需重新拉起 server");
    fireEvent.click(screen.getByRole("button", { name: "恢复会话" }));
    expect(a.onResume).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(a.onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("卡 5：未知错误（unknown 兜底，US 13 不吞错）", () => {
  it("原始 code 与 message 原文展示 + 不编造说明 +「重试」+「复制错误详情」写入剪贴板", async () => {
    const writes = stubClipboard();
    const a = actions();
    render(<ErrorBanner code="E_PROJECT_NOT_FOUND" message="项目不存在或已失效" cli="fake" title="t" canRetry {...a} />);
    const card = screen.getByTestId("error-card");
    expect(card.textContent).toContain("未知错误");
    expect(card.textContent).toContain("E_PROJECT_NOT_FOUND");
    expect(card.textContent).toContain("项目不存在或已失效");
    expect(card.textContent).toContain("不吞错");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(a.onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "复制错误详情" }));
    await waitFor(() => expect(writes).toEqual(["E_PROJECT_NOT_FOUND：项目不存在或已失效"]));
  });

  it("canRetry=false（无可重发消息）时不渲染「重试」", () => {
    render(<ErrorBanner code="E_INTERNAL" message="m" cli="fake" title="t" canRetry={false} {...actions()} />);
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });
});
