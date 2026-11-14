// 用途：desktop 工厂密封测试（arch D5）—— 注册表完备性钉住：CLI_REGISTRY 每个 cli 在工厂均有真实实现（名单漂移——注册表多出的 cli 落 Fake 兜底——即败）；Fake 回切开关名单与可见行为对齐（开关名取自注册表 disableEnv，快照于工厂创建时）
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../claude-adapter";
import { CodexAdapter } from "../codex-adapter";
import { FakeAdapter } from "../fake-adapter";
import { OpenCodeAdapter } from "../opencode-adapter";
import { CLI_REGISTRY } from "../exe-registry";
import { createDesktopAdapterFactory } from "./desktop-adapters";

// 本用例动过的环境开关统一还原（避免泄漏给同进程其它密封测试）
const touched: string[] = [];
afterEach(() => {
  for (const key of touched.splice(0)) delete process.env[key];
});

describe("createDesktopAdapterFactory 注册表完备性（arch D5）", () => {
  it("CLI_REGISTRY 每个 cli 均构造真实 adapter（adapter 构造惰性，不触本机 npm/PATH）", () => {
    const factory = createDesktopAdapterFactory();
    // 测试内钉住映射：注册表新增 cli 而工厂未接分支时，该 cli 落 Fake 兜底、instanceof 即败
    const expected = { codex: CodexAdapter, claude: ClaudeAdapter, opencode: OpenCodeAdapter };
    for (const [cli, entry] of Object.entries(CLI_REGISTRY)) {
      expect(entry.chain.cli).toBe(cli); // 注册表自洽前提
      expect(factory(cli)).toBeInstanceOf(expected[cli as keyof typeof expected]);
    }
  });

  it("KANBAN_DISABLE_*=1（开关名取自注册表 disableEnv）时该 CLI 回落 Fake，其余 CLI 不受影响", () => {
    const key = CLI_REGISTRY.codex.disableEnv;
    process.env[key] = "1";
    touched.push(key);
    const factory = createDesktopAdapterFactory();
    expect(factory("codex")).toBeInstanceOf(FakeAdapter);
    expect(factory("claude")).toBeInstanceOf(ClaudeAdapter); // 开关逐 CLI 独立
    expect(factory("opencode")).toBeInstanceOf(OpenCodeAdapter);
  });
});
