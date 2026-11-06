// 用途：memory B 类 e2e —— 真实 Claude headless 提取预演（spec #27 Testing 验收票 #37 前的最小真跑，KANBAN_E2E=1 门控；claude exe 不可解析时跳过并如实标注——不视为失败）；fake/预置数据驱动的无门控用例已迁 ../memory-ipc.test.ts（.e2e 后缀语义=默认 skipped，ADR 0002）
import { afterEach, describe, expect, it } from "vitest";
import { resolveClaudeExe, RunOnceRunner } from "@kanban/cli-host";
import type { MemoryEventWire } from "@kanban/ipc-schema";
import { assemble, cleanupTmpRoot, makeApp, seedRequirement, waitBatchTerminal } from "../memory-fixture";

afterEach(cleanupTmpRoot);

const E2E = process.env.KANBAN_E2E === "1";
let claudeExeOk = false;
if (E2E) {
  try {
    resolveClaudeExe();
    claudeExeOk = true;
  } catch {
    claudeExeOk = false;
  }
}

describe.skipIf(!E2E || !claudeExeOk)("真实 claude headless 提取（KANBAN_E2E=1 门控，模型调用预算 1 次）", () => {
  it("最小历史真实提取一次：completed、总结与候选落盘、modelCallCount 如实", async () => {
    const events: MemoryEventWire[] = [];
    const app = makeApp();
    const { requirementId } = await seedRequirement(app);
    const runner = new RunOnceRunner();
    const app2 = assemble(app.dbPath, app.dataRoot, app.projectDir, {
      events,
      readTranscript: async () => [
        { role: "user", text: "真实提取预演：请基于这句历史输出小结与一条候选。" },
        { role: "assistant", text: "好的，已收到最小历史。" },
      ],
      runOnce: (input) => runner.run(input),
    });
    app.db.close();
    const started = await app2.handleMemory({ channel: "memory:extract", requirementId });
    expect(started).toMatchObject({ ok: true, started: true });
    if (!started.ok || !started.batchId) return;
    const batch = await waitBatchTerminal(app2, started.batchId, 350_000); // 真实模型调用耗时放宽
    expect(batch.status).toBe("completed");
    expect(batch.modelCallCount).toBeGreaterThanOrEqual(1);
    const detail = await app2.handleMemory({ channel: "memory:requirementMemory", requirementId });
    if (detail.ok) {
      expect(detail.summary?.content).toBeTruthy();
      expect(detail.summary?.mdPath).toContain("summary.md");
    }
    app2.db.close();
  }, 360_000);
});
