// 用途：cli:status 契约测试（issue #80）—— 请求单通道联合（cli:status 无载荷；未知通道拒绝）+ 结果三真实 CLI 布尔安装表（缺键/非布尔拒绝；fake/pty 不在结果面）+ IPC 错误信封
import { describe, expect, it } from "vitest";
import { cliInstalledMapSchema, cliStatusRequestSchema, cliStatusResultSchema, realCliKindSchema } from "./cli-status";

describe("cliStatusRequestSchema（cli:status 单请求联合）", () => {
  it("cli:status 无载荷合法", () => {
    expect(cliStatusRequestSchema.parse({ channel: "cli:status" })).toEqual({ channel: "cli:status" });
  });

  it("未知通道/缺 channel 被拒绝", () => {
    expect(() => cliStatusRequestSchema.parse({ channel: "cli:nuke" })).toThrow();
    expect(() => cliStatusRequestSchema.parse({})).toThrow();
  });
});

describe("cliInstalledMapSchema（三真实 CLI 安装表）", () => {
  it("三键布尔对象合法（装/未装两态）", () => {
    expect(cliInstalledMapSchema.parse({ codex: true, claude: false, opencode: true })).toEqual({
      codex: true,
      claude: false,
      opencode: true,
    });
  });

  it("缺键/非布尔值被拒绝（fake/pty 恒可用不经探测，不出现在结果面——无第四键可混入）", () => {
    expect(() => cliInstalledMapSchema.parse({ codex: true, claude: false })).toThrow();
    expect(() => cliInstalledMapSchema.parse({ codex: "yes", claude: false, opencode: true })).toThrow();
    expect(realCliKindSchema.options).toEqual(["codex", "claude", "opencode"]);
  });
});

describe("cliStatusResultSchema（成功 ∪ IPC 错误信封）", () => {
  it("成功形态：ok:true + installed 安装表", () => {
    expect(cliStatusResultSchema.parse({ ok: true, installed: { codex: true, claude: false, opencode: false } })).toEqual({
      ok: true,
      installed: { codex: true, claude: false, opencode: false },
    });
  });

  it("失败形态：ok:false + error（code/message）；缺 installed 的成功形态被拒绝", () => {
    expect(cliStatusResultSchema.parse({ ok: false, error: { code: "E_INTERNAL", message: "探测异常" } }).ok).toBe(false);
    expect(() => cliStatusResultSchema.parse({ ok: true })).toThrow();
  });
});
