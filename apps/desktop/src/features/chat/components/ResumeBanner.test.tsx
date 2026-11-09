// 用途：恢复引导条三态密封测试（#42 / spec I 一致项 3）—— 待恢复（会话名+说明+主按钮）/ 恢复中（不可中断、无取消）/ 失败（IPC 错误+重试+复制详情）
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResumeBanner } from "./ResumeBanner";

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

describe("ResumeBanner 待恢复（#42 三态之一）", () => {
  it("显示会话名与「缓存不替代原生历史」说明 + 主按钮「读取原生历史并恢复」；点击触发 onResume", () => {
    const onResume = vi.fn();
    render(<ResumeBanner title="设计评审" resumeState={{ phase: "idle" }} onResume={onResume} />);
    const banner = screen.getByTestId("resume-banner");
    expect(banner.textContent).toContain("设计评审");
    expect(banner.textContent).toContain("来自上次运行（CLI 已退出）");
    expect(banner.textContent).toContain("缓存消息不替代原生历史");
    fireEvent.click(screen.getByRole("button", { name: "读取原生历史并恢复" }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});

describe("ResumeBanner 恢复中（#42 三态之二；D1 不可中断）", () => {
  it("显示进行中状态与「不可中断」说明；无取消按钮、无恢复按钮（resume 发出后不可撤回）", () => {
    render(<ResumeBanner title="设计评审" resumeState={{ phase: "resuming" }} onResume={() => undefined} />);
    const banner = screen.getByTestId("resume-banner");
    expect(banner.textContent).toContain("正在读取原生历史并恢复上下文");
    expect(banner.textContent).toContain("不可中断");
    expect(screen.queryByRole("button", { name: /取消/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "读取原生历史并恢复" })).toBeNull();
  });
});

describe("ResumeBanner 失败（#42 三态之三）", () => {
  it("显示 IPC 错误原因与错误码 + 「重试」（点击即同一 onResume 动作）+「复制错误详情」写入剪贴板", async () => {
    const writes = stubClipboard();
    const onResume = vi.fn();
    render(
      <ResumeBanner
        title="设计评审"
        resumeState={{ phase: "failed", code: "E_SESSION_NOT_FOUND", message: "原生历史文件不可读" }}
        onResume={onResume}
      />,
    );
    const banner = screen.getByTestId("resume-banner");
    expect(banner.textContent).toContain("恢复失败");
    expect(banner.textContent).toContain("原生历史文件不可读");
    expect(banner.textContent).toContain("E_SESSION_NOT_FOUND");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onResume).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "复制错误详情" }));
    await waitFor(() => expect(writes).toEqual(["E_SESSION_NOT_FOUND：原生历史文件不可读"]));
  });
});
