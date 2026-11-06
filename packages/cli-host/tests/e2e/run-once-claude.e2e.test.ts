// 用途：run-once 真实 claude headless 冒烟（#29 验收：认证 env 沿用既有策略、真实 exe 直连可用；KANBAN_E2E=1 门控，claude 不可解析时动态跳过）—— poc-5 提取形态：-p + 全新 --session-id + 独立临时 cwd + prompt 经 stdin，最小 prompt 一次模型调用
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveClaudeExe } from "../../src/claude/exe";
import { RunOnceRunner } from "../../src/host/run-once";

const E2E = process.env.KANBAN_E2E === "1";

describe.skipIf(!E2E)("run-once 真实 claude headless 冒烟（KANBAN_E2E=1）", () => {
  let cwd = "";
  let claudeReady = false;

  beforeAll(() => {
    try {
      resolveClaudeExe(); // 环境缺 claude 不是失败：动态跳过（conpty e2e 同款口径）
      claudeReady = true;
    } catch {
      claudeReady = false;
    }
    cwd = mkdtempSync(path.join(tmpdir(), "kb-runonce-claude-"));
  });

  afterAll(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it("最小 prompt 经 stdin → completed + 非空 stdout（认证 env 生效；失败则 status=failed 且 stderr 可定位）", { timeout: 300_000 }, async () => {
    if (!claudeReady) return; // claude 不可用：跳过（不计失败）
    const runner = new RunOnceRunner();
    const r = await runner.run({
      runId: `smoke-${randomUUID().slice(0, 8)}`,
      cli: "claude",
      // poc-5 提取形态：-p headless + 全新 session id（隔离）+ 独立临时 cwd；prompt 经 stdin（不进命令行）
      args: ["-p", "--output-format", "text", "--session-id", randomUUID()],
      cwd,
      stdin: "只回复两个字符：OK",
    });
    // 认证/env/网络任一断链都会落到非零退出；completed 即全链路（含用户级认证 env 透传）生效
    expect(r).toMatchObject({ status: "completed", exitCode: 0 });
    expect(r.stdout.trim().length).toBeGreaterThan(0);
    if (r.status !== "completed") {
      throw new Error(`claude headless 冒烟失败：${r.stderr.slice(0, 300)}`);
    }
  });
});
