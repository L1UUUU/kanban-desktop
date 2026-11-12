// 用途：模型目录真实拉取冒烟（KANBAN_E2E=1 才跑，issue #76/#78 / spec #75 B 类）—— codex 常驻 app-server 发 model/list（零推理成本）+ opencode acquire server → GET /config/providers 摊平（零推理成本）+ release 引用归零 + claude spawn 临时进程 initialize 握手读 models 数组（零推理成本，握手不产生模型调用）；环境探测清单（CLI 版本/凭据）见 docs/testing.md
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "../../src/claude-adapter";
import { CodexAdapter } from "../../src/codex-adapter";
import { OpenCodeAdapter } from "../../src/opencode-adapter";
import { OpenCodeServerHost } from "../../src/opencode/server-host";
import type { ModelEntry } from "@kanban/ipc-schema";

const E2E = process.env.KANBAN_E2E === "1";

// server 拉起/进程退出秒级：放宽到分钟兜底
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

// fixture 顶层同步初始化（非 E2E 不建目录，describe skip 后无泄漏）
const root = E2E ? mkdtempSync(path.join(tmpdir(), "kb-models-e2e-")) : "";

/** 尽力清理（Windows 句柄延迟重试；残留 %TEMP% 不判失败） */
function rmBestEffort(target: string): void {
  for (let i = 0; i < 10; i += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      /* 重试 */
    }
  }
}

/** 目录条目通用形状断言（四字段齐全；id 非空） */
function expectEntryShape(models: ModelEntry[]): void {
  expect(models.length).toBeGreaterThan(0);
  for (const m of models) {
    expect(m.id.length).toBeGreaterThan(0);
    expect(typeof m.displayName).toBe("string");
    expect(typeof m.description).toBe("string");
    expect(typeof m.isDefault).toBe("boolean");
  }
}

describe.skipIf(!E2E)("models:list 真实拉取冒烟（env-gated，零推理成本）", () => {
  afterAll(() => {
    rmBestEffort(root);
  });

  it("codex：model/list 经常驻 app-server 返回目录（零 turn；hidden 项不在场）", async () => {
    const adapter = new CodexAdapter({
      effort: "low",
      log: (k, d) => process.env.KANBAN_E2E_DEBUG && console.error(`[codex:${k}] ${d}`),
    });
    try {
      const models = await adapter.listModels({ cwd: root });
      expectEntryShape(models);
      // 目录≠可用性（poc-1 发现 2：本账号仅白名单模型可 turn）——冒烟只验证拉取与映射，不做可用性断言
      const ids = models.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length); // id 去重（分页拼接无重复）
    } finally {
      await adapter.dispose(); // 停 app-server（等进程退出后再清理 root）
    }
  });

  it("opencode：acquire server → GET /config/providers 摊平（id 为 providerID/modelID 完整串）→ release 引用归零", async () => {
    if (E2E) mkdirSync(path.join(root, "work"), { recursive: true });
    const host = new OpenCodeServerHost({
      registryPath: path.join(root, "servers.json"),
      log: (k, d) => process.env.KANBAN_E2E_DEBUG && console.error(`[oc:${k}] ${d}`),
    });
    const adapter = new OpenCodeAdapter({ host });
    const models = await adapter.listModels({ cwd: path.join(root, "work") });
    expectEntryShape(models);
    expect(models.some((m) => m.id.includes("/"))).toBe(true); // 完整串摊平（provider 前缀）
    expect(models.filter((m) => m.isDefault).length).toBeLessThanOrEqual(1); // 与 /config 默认串比对：至多一条默认
    expect(await host.listChildPids()).toEqual([]); // release 后 server 已停（引用计数不泄漏）
  });

  it("claude：spawn 临时进程 initialize 握手读 models 数组（零推理成本）；default 占位被过滤；重复调用走缓存；临时进程不残留", async () => {
    const adapter = new ClaudeAdapter({
      log: (k, d) => process.env.KANBAN_E2E_DEBUG && console.error(`[claude:${k}] ${d}`),
    });
    const models = await adapter.listModels({ cwd: root });
    expectEntryShape(models);
    expect(models.some((m) => m.id === "default")).toBe(false); // default 占位项过滤
    expect(models.some((m) => m.displayName === "Default (recommended)")).toBe(false);
    const again = await adapter.listModels({ cwd: root });
    expect(again).toBe(models); // adapter 内缓存：同实例不再握手
    expect(await adapter.listChildPids()).toEqual([]); // 临时进程不落会话表、已退出
  });
});
