// 用途：顶栏设置入口密封测试（#55 spec #52 H 节 → #61 升级 modal）—— 设置按钮一致项 className、点击打开设置面板（modal）含三分区、完成/✕ 关闭、桥缺失降级不崩、日志两项动作经 openLogDir/getLogPath+copyText（面板内行为细节见 SettingsModal.test.tsx）
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
    invokeConfig: async () => ({ ok: true, autoArchive: { enabled: false, days: 30 } }),
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

describe("TopBar 设置入口（#61 modal 形态）", () => {
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

  it("点击「设置」打开设置面板 modal（含日志/会话自动归档/已归档会话三分区）；点「完成」关闭", async () => {
    window.api = { invokeConfig: async () => ({ ok: true, autoArchive: { enabled: false, days: 30 } }) } as unknown as typeof window.api;
    render(<TopBar currentProject={null} />);
    fireEvent.click(screen.getByText("设置"));
    const modal = await waitFor(() => screen.getByTestId("settings-modal"));
    expect(modal).toBeTruthy();
    expect(screen.getByText("会话自动归档")).toBeTruthy();
    expect(screen.getByText("已归档会话（按项目分组）")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(screen.queryByTestId("settings-modal")).toBeNull();
  });

  it("「✕」同样关闭面板", async () => {
    window.api = { invokeConfig: async () => ({ ok: true, autoArchive: { enabled: false, days: 30 } }) } as unknown as typeof window.api;
    render(<TopBar currentProject={null} />);
    fireEvent.click(screen.getByText("设置"));
    await waitFor(() => screen.getByTestId("settings-modal"));
    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
    expect(screen.queryByTestId("settings-modal")).toBeNull();
  });

  it("window.api 缺失（jsdom）：面板打开、点击日志两项不崩、配置区显示降级（可选链降级）", async () => {
    window.api = undefined;
    render(<TopBar currentProject={null} />);
    fireEvent.click(screen.getByText("设置"));
    await waitFor(() => screen.getByTestId("settings-modal"));
    expect(() => fireEvent.click(screen.getByText("打开日志文件"))).not.toThrow();
    expect(() => fireEvent.click(screen.getByText("复制日志文件路径"))).not.toThrow();
    await waitFor(() => expect(screen.getByTestId("settings-unavailable")).toBeTruthy());
  });

  it("有桥接：「打开日志文件」→ openLogDir；「复制日志文件路径」→ getLogPath + clipboard.writeText(主文件路径)", async () => {
    const writes = stubClipboard();
    const calls = stubApi({ logPath: "C:\\userData\\logs\\20260102-030405-4242.jsonl" });
    render(<TopBar currentProject={null} />);
    fireEvent.click(screen.getByText("设置"));
    fireEvent.click(await screen.findByRole("button", { name: "打开日志文件" }));
    await waitFor(() => expect(calls.openLogDirCalls).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "复制日志文件路径" }));
    await waitFor(() => {
      expect(calls.getLogPathCalls).toBe(1);
      expect(writes).toEqual(["C:\\userData\\logs\\20260102-030405-4242.jsonl"]);
    });
  });
});
