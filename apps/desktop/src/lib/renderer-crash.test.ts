// 用途：Renderer 全局错误兜底密封单测（#55 spec #52 F 节）—— window.onerror/unhandledrejection 经 log:write 记 error；window.api 缺失（jsdom）可选链降级不崩
import { afterEach, describe, expect, it } from "vitest";
import { registerRendererCrashHandlers } from "./renderer-crash";

/** 记录 log 调用的 fake 桥 */
function fakeApi(): { calls: Array<{ level: string; scope: string; message: string; ctx?: Record<string, string | number | boolean | null> }> } {
  const calls: { level: string; scope: string; message: string; ctx?: Record<string, string | number | boolean | null> }[] = [];
  return {
    calls,
    log: (level: string, scope: string, message: string, ctx?: Record<string, string | number | boolean | null>) => calls.push({ level, scope, message, ctx }),
  } as unknown as ReturnType<typeof fakeApi>;
}

// 注册注销器：jsdom 同文件共享 window，逐用例撤销注册防监听器累积
let dispose: (() => void) | null = null;

afterEach(() => {
  dispose?.();
  dispose = null;
  window.api = undefined;
});

describe("registerRendererCrashHandlers（React 挂载入口注册）", () => {
  it("window.api 缺失（jsdom 形态）：触发两类全局错误不崩、无异常逃逸", () => {
    window.api = undefined;
    expect(() => (dispose = registerRendererCrashHandlers(window))).not.toThrow();
    expect(() => window.onerror?.("boom", "app.tsx", 1, 2, new Error("boom"))).not.toThrow();
    const ev = new Event("unhandledrejection");
    (ev as unknown as { reason: unknown }).reason = new Error("late");
    expect(() => window.dispatchEvent(ev)).not.toThrow();
  });

  it("有桥接：未捕获错误经 log 记 error/crash（含位置与堆栈），onerror 返回 false 保持默认控制台行为", () => {
    const api = fakeApi();
    window.api = api as unknown as typeof window.api;
    dispose = registerRendererCrashHandlers(window);
    const ret = window.onerror?.("boom", "app.tsx", 7, 42, new Error("boom"));
    expect(ret).toBe(false);
    expect(api.calls.length).toBe(1);
    expect(api.calls[0]?.level).toBe("error");
    expect(api.calls[0]?.scope).toBe("crash");
    expect(api.calls[0]?.message).toContain("未捕获渲染错误");
    expect(api.calls[0]?.message).toContain("@7:42");
    expect(api.calls[0]?.ctx?.stack).toBeTruthy();
  });

  it("有桥接：unhandledrejection 经 log 记 error/crash（Error 取 message，裸值 String 化）", () => {
    const api = fakeApi();
    window.api = api as unknown as typeof window.api;
    dispose = registerRendererCrashHandlers(window);
    const ev = new Event("unhandledrejection");
    (ev as unknown as { reason: unknown }).reason = new Error("late");
    window.dispatchEvent(ev);
    expect(api.calls.length).toBe(1);
    expect(api.calls[0]?.message).toContain("未处理 Promise rejection");
    expect(api.calls[0]?.message).toContain("late");
    const ev2 = new Event("unhandledrejection");
    (ev2 as unknown as { reason: unknown }).reason = 42;
    window.dispatchEvent(ev2);
    expect(api.calls.length).toBe(2);
    expect(api.calls[1]?.message).toContain("42");
  });
});
