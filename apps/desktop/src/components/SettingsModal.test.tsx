// 用途：SettingsModal 密封测试（#61 spec #57 / 原型 stage5 演示③）—— 三分区骨架、autoArchive 读写经 config:ipc、天数非法拒绝回落、保存失败明确报错且新值不生效、扫描反馈占位不误导、无桥降级
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsModal } from "./SettingsModal";

afterEach(() => {
  cleanup();
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

/** config:set 应答：成功（生效值）或失败（写盘错误 message） */
type SetReply = { ok: true; autoArchive: { enabled: boolean; days: number } } | { ok: false; message: string };

/** fake 桥：invokeConfig 按 get 初始值 / setResults 队列应答，并记录全部请求（用例可随时向队列 push 追加应答） */
function stubConfigApi(opts: { initial?: { enabled: boolean; days: number }; setResults?: SetReply[] } = {}): {
  requests: unknown[];
  setResults: SetReply[];
} {
  const requests: unknown[] = [];
  const setResults = opts.setResults ?? [];
  window.api = {
    invokeConfig: async (req: unknown) => {
      requests.push(req);
      const channel = (req as { channel: string }).channel;
      if (channel === "config:get") {
        return { ok: true, autoArchive: opts.initial ?? { enabled: false, days: 30 } };
      }
      const r = setResults.shift();
      if (!r) throw new Error("未预置的 config:set 应答");
      return r.ok ? { ok: true, autoArchive: r.autoArchive } : { ok: false, error: { code: "E_INTERNAL", message: r.message } };
    },
  } as unknown as typeof window.api;
  return { requests, setResults };
}

/** 打开面板并等 config:get 初始值渲染完成（返回句柄供用例追加 set 应答） */
async function openAndReady(initial?: { enabled: boolean; days: number }) {
  const handle = stubConfigApi({ initial });
  render(<SettingsModal onClose={() => undefined} />);
  await waitFor(() => expect(handle.requests).toEqual([{ channel: "config:get" }]));
  await waitFor(() => expect((screen.getByTestId("auto-archive-days") as HTMLInputElement).value).toBe(String(initial?.days ?? 30)));
  return handle;
}

describe("SettingsModal 三分区骨架（#61）", () => {
  it("渲染「日志」「会话自动归档」「已归档会话」三分区；日志区含且仅含两项动作（密封：不新增其它日志入口）", async () => {
    await openAndReady();
    const logSection = screen.getByTestId("settings-log-section");
    expect(logSection.querySelectorAll("button").length).toBe(2);
    expect(screen.getByRole("button", { name: "打开日志文件" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制日志文件路径" })).toBeTruthy();
    expect(screen.getByText("会话自动归档")).toBeTruthy();
    expect(screen.getByText("已归档会话（按项目分组）")).toBeTruthy();
  });

  it("已归档分区为 #63 占位骨架：不渲染任何会话条目/假数据，占位说明不误导", async () => {
    await openAndReady();
    const section = screen.getByTestId("archived-section");
    expect(section.querySelectorAll("[data-testid='archived-item']").length).toBe(0);
    expect(screen.getByTestId("archived-placeholder").textContent).toContain("尚未开放");
  });
});

describe("autoArchive 读初始值", () => {
  it("开关按 config:get 结果渲染（enabled=true 时 aria-checked=true、天数输入显示 days）", async () => {
    await openAndReady({ enabled: true, days: 14 });
    expect(screen.getByTestId("auto-archive-switch").getAttribute("aria-checked")).toBe("true");
    expect((screen.getByTestId("auto-archive-days") as HTMLInputElement).value).toBe("14");
  });

  it("无 window.api（jsdom）：配置区降级提示、无开关/天数控件、不崩", async () => {
    render(<SettingsModal onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("settings-unavailable")).toBeTruthy());
    expect(screen.queryByTestId("auto-archive-switch")).toBeNull();
    expect(screen.queryByTestId("auto-archive-days")).toBeNull();
  });
});

describe("autoArchive 写（config:set）", () => {
  it("点击开关 → config:set 携带翻转后的 enabled 与当前生效 days；成功后 UI 生效态更新", async () => {
    const { requests, setResults } = await openAndReady({ enabled: false, days: 30 });
    setResults.push({ ok: true, autoArchive: { enabled: true, days: 30 } });
    fireEvent.click(screen.getByTestId("auto-archive-switch"));
    await waitFor(() =>
      expect(requests).toContainEqual({ channel: "config:set", autoArchive: { enabled: true, days: 30 } }),
    );
    await waitFor(() => expect(screen.getByTestId("auto-archive-switch").getAttribute("aria-checked")).toBe("true"));
  });

  it("天数合法修改（blur 提交）→ config:set 新 days；非法值（空/0/400/1.5）被拒绝：不发送、显示错误、输入回落当前生效值", async () => {
    const { requests, setResults } = await openAndReady({ enabled: true, days: 30 });
    setResults.push({ ok: true, autoArchive: { enabled: true, days: 45 } });
    // 合法：30 → 45
    fireEvent.change(screen.getByTestId("auto-archive-days"), { target: { value: "45" } });
    fireEvent.blur(screen.getByTestId("auto-archive-days"));
    await waitFor(() => expect(requests).toContainEqual({ channel: "config:set", autoArchive: { enabled: true, days: 45 } }));
    // 非法：45 → 0 / 400 / 1.5 / 空（均不发送、回落 45）
    for (const bad of ["0", "400", "1.5", ""]) {
      fireEvent.change(screen.getByTestId("auto-archive-days"), { target: { value: bad } });
      fireEvent.blur(screen.getByTestId("auto-archive-days"));
      expect(screen.getByTestId("settings-error").textContent).toContain("1–365");
      expect((screen.getByTestId("auto-archive-days") as HTMLInputElement).value).toBe("45");
    }
    expect(requests.filter((r) => (r as { channel: string }).channel === "config:set").length).toBe(1);
  });

  it("保存失败（写盘失败）→ 明确报错显示、开关/天数回落生效值（新值不生效不留分叉）", async () => {
    const { setResults } = await openAndReady({ enabled: false, days: 30 });
    setResults.push({ ok: false, message: "配置保存失败，新值未生效：EACCES: permission denied" });
    fireEvent.click(screen.getByTestId("auto-archive-switch"));
    await waitFor(() => expect(screen.getByTestId("settings-error").textContent).toContain("EACCES"));
    // 开关回落：生效值仍为关
    expect(screen.getByTestId("auto-archive-switch").getAttribute("aria-checked")).toBe("false");
  });

  it("扫描反馈位：开关开启后显示占位说明（如实声明引擎未接入、暂不执行扫描——不误导）", async () => {
    const { setResults } = await openAndReady({ enabled: false, days: 30 });
    expect(screen.queryByTestId("auto-archive-feedback")).toBeNull(); // 关闭时不显示
    setResults.push({ ok: true, autoArchive: { enabled: true, days: 30 } });
    fireEvent.click(screen.getByTestId("auto-archive-switch"));
    await waitFor(() => expect(screen.getByTestId("auto-archive-feedback")).toBeTruthy());
    expect(screen.getByTestId("auto-archive-feedback").textContent).toContain("尚未接入");
  });
});

describe("日志两项动作（自旧浮层平移，动作后面板保持打开）", () => {
  it("打开日志文件 → openLogDir；复制日志文件路径 → getLogPath + clipboard.writeText", async () => {
    const writes = stubClipboard();
    const calls = { openLogDirCalls: 0, getLogPathCalls: 0 };
    window.api = {
      invokeConfig: async () => ({ ok: true, autoArchive: { enabled: false, days: 30 } }),
      openLogDir: async () => {
        calls.openLogDirCalls++;
      },
      getLogPath: async () => {
        calls.getLogPathCalls++;
        return "C:\\userData\\logs\\20260102-030405-4242.jsonl";
      },
    } as unknown as typeof window.api;
    render(<SettingsModal onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "打开日志文件" }));
    await waitFor(() => expect(calls.openLogDirCalls).toBe(1));
    expect(screen.getByRole("button", { name: "打开日志文件" })).toBeTruthy(); // 面板不收起
    fireEvent.click(screen.getByRole("button", { name: "复制日志文件路径" }));
    await waitFor(() => {
      expect(calls.getLogPathCalls).toBe(1);
      expect(writes).toEqual(["C:\\userData\\logs\\20260102-030405-4242.jsonl"]);
    });
  });
});
