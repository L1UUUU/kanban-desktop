// 用途：顶栏设置入口密封测试（#55 spec #52 H 节）—— 浮层含且仅含两项、一致项 className、桥缺失降级不崩、两项动作经 openLogDir/getLogPath+copyText
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TopBar } from "./TopBar";

afterEach(() => {
  cleanup();
  // clipboard 桩还原（jsdom 无真实剪贴板）
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  window.api = undefined;
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

/** fake 桥：记录 openLogDir/getLogPath 调用 */
function stubApi(opts: { logPath: string }): { openLogDirCalls: number; getLogPathCalls: number } {
  const calls = { openLogDirCalls: 0, getLogPathCalls: 0 };
  window.api = {
    openLogDir: async () => {
      calls.openLogDirCalls++;
    },
    getLogPath: async () => {
      calls.getLogPathCalls++;
      return opts.logPath;
    },
  } as unknown as typeof window.api;
  return calls;
}

describe("TopBar 设置入口（#55 spec #52 H 节）", () => {
  it("「设置」按钮可见；一致项：header bg-card+下边框、按钮 ml-auto text-xs text-muted-foreground 且无 cursor-default", () => {
    render(<TopBar currentProject={null} />);
    const header = document.querySelector("header");
    expect(header?.className).toContain("bg-card");
    expect(header?.className).toContain("border-b");
    const btn = screen.getByText("设置");
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.className).toContain("ml-auto");
    expect(btn.className).toContain("text-xs");
    expect(btn.className).toContain("text-muted-foreground");
    expect(btn.className).not.toContain("cursor-default");
  });

  it("点击「设置」展开浮层，含且仅含「打开日志文件」「复制日志文件路径」两项；再点收起", () => {
    render(<TopBar currentProject={null} />);
    fireEvent.click(screen.getByText("设置"));
    const openItem = screen.getByText("打开日志文件");
    const copyItem = screen.getByText("复制日志文件路径");
    expect(openItem.tagName).toBe("BUTTON");
    expect(copyItem.tagName).toBe("BUTTON");
    // 浮层内除两项外无其他按钮（「设置」自身在 header 直属，不在浮层内）
    const popup = openItem.parentElement;
    expect(popup?.querySelectorAll("button").length).toBe(2);
    fireEvent.click(screen.getByText("设置"));
    expect(screen.queryByText("打开日志文件")).toBeNull();
    expect(screen.queryByText("复制日志文件路径")).toBeNull();
  });

  it("window.api 缺失（jsdom）：点击两项不崩、每次动作后浮层收起（可选链降级）", () => {
    window.api = undefined;
    render(<TopBar currentProject={null} />);
    fireEvent.click(screen.getByText("设置"));
    expect(() => fireEvent.click(screen.getByText("打开日志文件"))).not.toThrow();
    expect(screen.queryByText("打开日志文件")).toBeNull(); // 动作后收起
    fireEvent.click(screen.getByText("设置")); // 重新展开点第二项
    expect(() => fireEvent.click(screen.getByText("复制日志文件路径"))).not.toThrow();
    expect(screen.queryByText("复制日志文件路径")).toBeNull();
  });

  it("有桥接：「打开日志文件」→ openLogDir；「复制日志文件路径」→ getLogPath + clipboard.writeText(主文件路径)", async () => {
    const writes = stubClipboard();
    const calls = stubApi({ logPath: "C:\\userData\\logs\\20260102-030405-4242.jsonl" });
    render(<TopBar currentProject={null} />);
    fireEvent.click(screen.getByText("设置"));
    fireEvent.click(screen.getByText("打开日志文件"));
    await waitFor(() => expect(calls.openLogDirCalls).toBe(1));
    fireEvent.click(screen.getByText("设置"));
    fireEvent.click(screen.getByText("复制日志文件路径"));
    await waitFor(() => {
      expect(calls.getLogPathCalls).toBe(1);
      expect(writes).toEqual(["C:\\userData\\logs\\20260102-030405-4242.jsonl"]);
    });
  });
});
