// 用途：三 CLI 生命周期真实集成（KANBAN_E2E=1，#13）—— 退出 dispose（进程终止）→ 新实例 adoptSession（main 重开恢复编排的 adapter 侧）→ readHistory 原生历史在场（不重放）→ resume 上下文延续（暗号复现）；codex 为本工单新增能力，claude 补跨实例真 transcript 链路，opencode 由 opencode-adapter.e2e「跨实例收养」用例覆盖（引用不重跑控成本）
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdapterEvent, ChatEvent } from "@kanban/ipc-schema";
import { ClaudeAdapter } from "../../src/claude-adapter";
import { CodexAdapter } from "../../src/codex-adapter";

const E2E = process.env.KANBAN_E2E === "1";

// 真实模型 turn 十秒级：测试与钩子都放宽
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const root = E2E ? mkdtempSync(path.join(tmpdir(), "kb-life-e2e-")) : "";
const codexDir = E2E ? path.join(root, "codex") : "";
const claudeDir = E2E ? path.join(root, "claude") : "";
const claudeHookDir = E2E ? path.join(root, "claude-hooks") : "";

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

const debug = (k: string, d: string): void => {
  if (process.env.KANBAN_E2E_DEBUG) console.error(`[life:${k}] ${d}`);
};

/** 轮询推进到空闲（running 消失且稳定 800ms；waiting=审批等待用户视为稳定） */
async function driveIdle(events: AdapterEvent[], sessionId: string, timeoutMs = 240_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let stableSince = 0;
  for (;;) {
    if (Date.now() > deadline) throw new Error("driveIdle 超时");
    let status = "idle";
    for (const e of events) {
      if ("type" in e && e.type === "session_status" && e.sessionId === sessionId) status = e.status;
    }
    if (status !== "running") {
      if (stableSince === 0) stableSince = Date.now();
      if (Date.now() - stableSince > 800) return;
    } else {
      stableSince = 0;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

const joinedText = (events: AdapterEvent[], sessionId: string): string =>
  events
    .filter((e): e is ChatEvent => "type" in e && e.type === "message_delta" && e.sessionId === sessionId)
    .map((e) => (e as Extract<ChatEvent, { type: "message_delta" }>).delta)
    .join("");

describe.skipIf(!E2E)("生命周期真实集成（#13：退出 dispose + 重启 adopt/readHistory/resume）", () => {
  beforeAll(() => {
    if (!E2E) return;
    for (const dir of [codexDir, claudeDir, claudeHookDir]) mkdirSync(dir, { recursive: true }); // spawn cwd 须真实存在（不存在时 spawn ENOENT 报在 exe 路径上）
  });

  afterAll(() => {
    if (!E2E) return;
    rmBestEffort(root);
  });

  it("codex：真实 turn → 全量 dispose（进程退出）→ 新实例 adoptSession → thread 原生历史在场 → resume 暗号复现（不重放）", async () => {
    const magic = `KBLC-CX-${randomUUID().slice(0, 6).toUpperCase()}`;
    // 第一次运行：会话 + 埋暗号短 turn
    const a = new CodexAdapter({ effort: "low", log: debug });
    const evA: AdapterEvent[] = [];
    a.subscribe((e) => evA.push(e));
    const created = await a.createSession({ cwd: codexDir, permMode: "auto" });
    expect(created.nativeSessionId).toBeTruthy();
    await a.sendTurn({ sessionId: created.sessionId, text: `请记住暗号 ${magic}。只回复：已记住` });
    await driveIdle(evA, created.sessionId);
    expect(joinedText(evA, created.sessionId).length).toBeGreaterThan(0);
    // 退出序列核心：全量 dispose（受控终止 + 有限等待进程退出）
    await a.dispose();
    // 应用重启：全新实例，按 DB native id 收养（main 的 adoptRestoredSessions 同参数）
    const b = new CodexAdapter({ effort: "low", log: debug });
    const evB: AdapterEvent[] = [];
    b.subscribe((e) => evB.push(e));
    await b.adoptSession({ sessionId: created.sessionId, nativeSessionId: created.nativeSessionId!, cwd: codexDir, permMode: "auto" });
    // 收养态 readHistory：原生历史在场（含第一轮回复），无新增 completed turn（不重放）
    const history = await b.readHistory(created.sessionId);
    expect(joinedText(history, created.sessionId)).toContain("已记住");
    expect(history.filter((e) => e.type === "turn_completed").length).toBeGreaterThanOrEqual(1);
    // resume：上下文延续（暗号复现）
    await b.resume(created.sessionId);
    await b.sendTurn({ sessionId: created.sessionId, text: "我之前告诉你的暗号是什么？只回复暗号本身，不要其他文字。" });
    await driveIdle(evB, created.sessionId);
    expect(joinedText(evB, created.sessionId)).toContain(magic);
    // 回填轮恰一次在场（快照 1 + 续问实时 1；无重放重复）
    const live = evB.filter((e): e is ChatEvent => "type" in e && e.sessionId === created.sessionId);
    expect(live.filter((e) => e.type === "turn_started").length).toBe(1);
    await b.dispose();
  });

  it("claude：真实 turn → 全量 dispose（进程退出）→ 新实例 adoptSession → transcript 原生历史在场 → resume 暗号复现", async () => {
    const magic = `KBLC-CL-${randomUUID().slice(0, 6).toUpperCase()}`;
    const a = new ClaudeAdapter({ hookDir: claudeHookDir, log: debug });
    const evA: AdapterEvent[] = [];
    a.subscribe((e) => evA.push(e));
    const created = await a.createSession({ cwd: claudeDir, permMode: "auto" });
    expect(created.nativeSessionId).toBeTruthy();
    await a.sendTurn({ sessionId: created.sessionId, text: `请记住暗号 ${magic}。只回复：已记住` });
    await driveIdle(evA, created.sessionId);
    expect(joinedText(evA, created.sessionId).length).toBeGreaterThan(0);
    await a.dispose();
    // 应用重启：新实例收养 → readHistory 直读 transcript（无进程）→ resume 后可续问
    const b = new ClaudeAdapter({ hookDir: claudeHookDir, log: debug });
    const evB: AdapterEvent[] = [];
    b.subscribe((e) => evB.push(e));
    await b.adoptSession({ sessionId: created.sessionId, nativeSessionId: created.nativeSessionId!, cwd: claudeDir, permMode: "auto" });
    const history = await b.readHistory(created.sessionId);
    expect(joinedText(history, created.sessionId)).toContain("已记住");
    await b.resume(created.sessionId);
    await b.sendTurn({ sessionId: created.sessionId, text: "我之前告诉你的暗号是什么？只回复暗号本身，不要其他文字。" });
    await driveIdle(evB, created.sessionId);
    expect(joinedText(evB, created.sessionId)).toContain(magic);
    await b.dispose();
  });

  // opencode：退出 dispose + 跨实例 adopt/readHistory/resume 暗号复现已由 opencode-adapter.e2e.test.ts
  // 「跨实例收养（#13 接入点）」与 dispose 用例覆盖（env 同为 KANBAN_E2E=1），此处引用不重跑（控成本）。
});
