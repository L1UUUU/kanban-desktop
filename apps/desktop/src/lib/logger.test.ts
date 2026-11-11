// 用途：lib/logger 密封单测（issue #69 P1）—— sink 注入 (level,scope,message,ctx) 精确断言、默认 windowSink 无桥降级不崩、还原函数生效
import { afterEach, describe, expect, it } from "vitest";
import { createScopedLogger, setLogSinkForTest } from "./logger";

/** 注入 sink 收集的条目形状 */
interface Entry {
  level: string;
  scope: string;
  message: string;
  ctx?: Record<string, string | number | boolean>;
}

// sink 还原器：逐用例还原，防注入泄漏到后续用例
let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
  window.api = undefined;
});

describe("createScopedLogger（渲染端日志唯一出口）", () => {
  it("注入 sink：四级别经子记录器发出，level/scope/message/ctx 精确透传（scope 固定免传）", () => {
    const entries: Entry[] = [];
    restore = setLogSinkForTest((level, scope, message, ctx) => entries.push({ level, scope, message, ctx }));
    const log = createScopedLogger("chat");
    log.error("提交失败", { code: "E_INTERNAL" });
    log.warn("慢查询");
    log.info("完成");
    log.debug("细节");
    expect(entries).toEqual([
      { level: "error", scope: "chat", message: "提交失败", ctx: { code: "E_INTERNAL" } },
      { level: "warn", scope: "chat", message: "慢查询" },
      { level: "info", scope: "chat", message: "完成" },
      { level: "debug", scope: "chat", message: "细节" },
    ]);
  });

  it("默认 sink：window.api 缺失（jsdom 形态）不崩；有桥时经 window.api.log 透传", () => {
    window.api = undefined;
    const log = createScopedLogger("chat");
    expect(() => log.error("无桥降级")).not.toThrow();
    const calls: Entry[] = [];
    window.api = {
      log: (level: string, scope: string, message: string, ctx?: Record<string, string | number | boolean>) =>
        calls.push({ level, scope, message, ctx }),
    } as unknown as typeof window.api;
    log.error("有桥", { sessionId: "s1" });
    expect(calls).toEqual([{ level: "error", scope: "chat", message: "有桥", ctx: { sessionId: "s1" } }]);
  });

  it("还原函数生效：还原后条目回落默认 windowSink（不再进注入 sink，既有 logger 实例同受影响）", () => {
    const entries: Entry[] = [];
    const r = setLogSinkForTest((level, scope, message) => entries.push({ level, scope, message }));
    const log = createScopedLogger("chat");
    log.info("注入期");
    r();
    window.api = undefined; // 默认 sink 无桥 = no-op
    log.info("还原后");
    expect(entries).toEqual([{ level: "info", scope: "chat", message: "注入期" }]);
  });
});
