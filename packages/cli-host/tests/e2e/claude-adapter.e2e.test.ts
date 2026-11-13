// 用途：ClaudeAdapter 真实集成套（KANBAN_E2E=1 才跑）—— 契约套参数化复跑 + 权限三档可观察差异 + interrupt + dispose→resume 暗号复现（poc-7 T4）+ hook verified 双信号与 T5 反例 + 认证叠加（T6 场景随全部用例隐式回归）；短提示控成本
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "../../src/claude-adapter";
import { createCollector, defineAdapterContractTests, type EventCollector } from "../../src/adapter.contract";
import type { AdapterEvent, ChatEvent, SkillObservation } from "@kanban/ipc-schema";
import { transcriptEventSchema } from "@kanban/ipc-schema";

const E2E = process.env.KANBAN_E2E === "1";

// 真实模型 turn 十秒级：测试与钩子都放宽
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

// fixture 顶层同步初始化（契约套 opts 在 describe 收集阶段求值；非 E2E 不建目录）
const workdir = E2E ? mkdtempSync(path.join(tmpdir(), "kb-claude-work-")) : "";
const outside = E2E ? mkdtempSync(path.join(tmpdir(), "kb-claude-out-")) : "";
const hookDir = E2E ? mkdtempSync(path.join(tmpdir(), "kb-claude-hooks-")) : "";

// 无害探针 skill（poc-7 同法）：保证 Skill 工具可被真实调用，驱动 PreToolUse/PostToolUse(Skill) hook
if (E2E) {
  const skillDir = path.join(workdir, ".claude", "skills", "kb-probe-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: kb-probe-skill\ndescription: E2E 探针 skill——被调用时只回复固定标记，不执行任何其他操作\n---\n\n被调用时只回复：KB-PROBE-SKILL-OK\n",
    "utf8",
  );
}

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

// 审批共用 prompt：两条独立写命令（与 Codex e2e 同构；ask 档 default+严格工具配置下 Bash 写必弹 stdio 审批）
const f1 = path.join(workdir, "probe-f1.txt");
const f2 = path.join(workdir, "probe-f2.txt");
const approvalPrompt = [
  "请依次分别运行下面两条 shell 命令（分成两次独立运行，不要合并成一条，也不要跳过）：",
  `1) echo a > "${f1}"`,
  `2) echo b > "${f2}"`,
  "每条运行完后各用一句话报告结果。",
].join("\n");

describe.skipIf(!E2E)("ClaudeAdapter 真实集成（env-gated）", () => {
  let adapter: ClaudeAdapter;
  const events: AdapterEvent[] = [];

  beforeAll(() => {
    adapter = new ClaudeAdapter({ hookDir, log: (k, d) => process.env.KANBAN_E2E_DEBUG && console.error(`[claude:${k}] ${d}`) });
    adapter.subscribe((e) => events.push(e));
  });

  afterAll(async () => {
    await adapter.dispose(); // 等进程退出后再清理（workdir 是 claude 子进程 cwd）
    rmBestEffort(workdir);
    rmBestEffort(outside);
    rmBestEffort(hookDir);
  });

  const chat = (sid: string) => events.filter((e): e is ChatEvent => "type" in e && e.sessionId === sid);
  const skillsOf = (sid: string) => events.filter((e): e is SkillObservation => !("type" in e) && e.sessionId === sid);
  const assistantText = (sid: string) =>
    chat(sid)
      .filter((e): e is Extract<ChatEvent, { type: "message_delta" }> => e.type === "message_delta")
      .map((e) => e.delta)
      .join("");

  /** 轮询推进到全局空闲（running 消失且稳定 800ms；waiting=审批等待用户视为稳定） */
  async function driveIdle(): Promise<void> {
    const deadline = Date.now() + 240_000;
    let stableSince = 0;
    for (;;) {
      if (Date.now() > deadline) throw new Error("driveIdle 超时（240s 无空闲）");
      const statuses = new Map<string, string>();
      for (const e of events) if ("type" in e && e.type === "session_status") statuses.set(e.sessionId, e.status);
      const busy = [...statuses.values()].some((s) => s === "running");
      if (!busy) {
        if (stableSince === 0) stableSince = Date.now();
        if (Date.now() - stableSince > 800) return;
      } else {
        stableSince = 0;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  /* ---------------- 契约套（Fake 同断言参数化复跑，spec Testing seam 1；T6 叠加语义随全部用例隐式回归：--settings 注入存在的会话认证正常出流） ---------------- */
  /** 契约中断用例前置钩子：等该会话首个 message_delta（模型真实出流）再返回，由契约套立即 interrupt——中断时机与模型速度解耦（issue #39 flaky 1） */
  async function waitTurnActive(col: EventCollector, sid: string): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (!col.chat(sid).some((e) => e.type === "message_delta")) {
      if (Date.now() > deadline) return; // 尽力等待：超时照常打断（turn 若已完成，断言显性失败）
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  defineAdapterContractTests(
    async () => ({ adapter, driveIdle }),
    {
      turnText: "请用两三句话解释什么是单元测试。",
      secondTurnText: "只回复一句话：第二轮完成。",
      // 长输出任务 + 首 delta 后打断（interruptWaitTurnActive）：保证被中断的 turn 真实长跑（issue #39）
      interruptTurnText: "请从 1 慢慢数到 100，每行一个数字，不要跳过任何数字，也不要提前停止。",
      interruptWaitTurnActive: waitTurnActive,
      approvalTurnText: approvalPrompt,
      approvalPermMode: "ask",
      cwd: workdir,
      assistantMessages: { atLeast: 1 },
      firstAssistantText: null,
      summarizeTitle: "loose", // #95：真实摘要生成（单轮一次性进程，上下文零污染由契约不变量断言）
      suggestionsRequired: false,
      deny: { contains: [], notContains: [], verify: async () => { expect(existsSync(f1)).toBe(false); } },
      once: { outputContains: [], verify: async () => { expect(existsSync(f1)).toBe(true); } },
      // 真实放行范围由 CLI 解释（addRules 规则化回传不断言其跳过效果）：第一命令真执行；第二审批按 CLI 语义处理
      always: { outputContains: [], finalContains: [], expectNoSecondAsk: false, verify: async () => { expect(existsSync(f1)).toBe(true); } },
    },
  );

  /* ---------------- 权限三档映射：每档一个可观察差异（spec B 权限映射表 Claude 列） ---------------- */
  it("权限档位 ask（default+permissions.ask 严格工具配置）：只读 Read 也触发 stdio 审批", async () => {
    const seed = path.join(workdir, "seed.txt");
    writeFileSync(seed, "ASK-TIER-PROBE", "utf8");
    const { sessionId } = await adapter.createSession({ cwd: workdir, permMode: "ask" });
    await adapter.sendTurn({ sessionId, text: `请用 Read 工具读取文件 "${seed}" 并原样告诉我内容，不要运行任何命令。` });
    await driveIdle();
    const req = chat(sessionId).find((e) => e.type === "approval_requested");
    expect(req).toBeDefined(); // ask 档：Read（default 下自动放行的只读工具）也弹审批
    expect(req!.command).toContain("Read");
    await adapter.resolveApproval({ sessionId, requestId: req!.requestId, decision: "allow-once" });
    await driveIdle();
    expect(assistantText(sessionId)).toContain("ASK-TIER-PROBE"); // 放行后真读取
  });

  it("权限档位 auto（default）：Read 直接放行不弹审批，turn 完成", async () => {
    const seed = path.join(workdir, "seed.txt");
    const { sessionId } = await adapter.createSession({ cwd: workdir, permMode: "auto" });
    await adapter.sendTurn({ sessionId, text: `请用 Read 工具读取文件 "${seed}" 并原样告诉我内容，不要运行任何命令。` });
    await driveIdle();
    expect(chat(sessionId).some((e) => e.type === "approval_requested")).toBe(false); // 读自动
    expect(assistantText(sessionId)).toContain("ASK-TIER-PROBE");
    expect(chat(sessionId).some((e) => e.type === "turn_completed")).toBe(true);
  });

  it("权限档位 full（bypassPermissions）：写 cwd 外文件直接执行不弹审批", async () => {
    const { sessionId } = await adapter.createSession({ cwd: workdir, permMode: "full" });
    const file = path.join(outside, "perm-full.txt");
    await adapter.sendTurn({ sessionId, text: `请运行这条命令并报告结果：echo full > "${file}"` });
    await driveIdle();
    expect(chat(sessionId).some((e) => e.type === "approval_requested")).toBe(false); // 全放行
    expect(existsSync(file)).toBe(true);
    expect(chat(sessionId).some((e) => e.type === "turn_completed")).toBe(true);
  });

  /* ---------------- 跨重启 resume：暗号复现（poc-7 T4 场景回归）+ transcript 直读 ---------------- */
  it("dispose（进程终止）→ session_exit/disconnected → resume 原会话暗号无损复现 + readHistory 快照增量拼接", async () => {
    const { sessionId, nativeSessionId } = await adapter.createSession({ cwd: workdir, permMode: "auto" });
    await adapter.sendTurn({ sessionId, text: "请记住这个暗号：琥珀象9号。只回复：已记住" });
    await driveIdle();
    expect(chat(sessionId).some((e) => e.type === "turn_completed")).toBe(true);
    await adapter.dispose(); // 全局受控终止：会话状态保留（进程死亡语义）
    expect(chat(sessionId).some((e) => e.type === "session_exit")).toBe(true);
    expect(chat(sessionId).at(-1)).toMatchObject({ type: "session_status", status: "disconnected" });
    await expect(adapter.sendTurn({ sessionId, text: "x" })).rejects.toMatchObject({ code: "E_INTERNAL" });
    // 断开态 readHistory：transcript 直读（本进程日志已有第 1 轮；无重复）
    const snapshot = await adapter.readHistory(sessionId);
    const maxSeq = Math.max(...snapshot.map((e) => e.seq));
    // resume：spawn 新进程 --resume 原 native id 续问（poc-7 T4：session id 不变）
    await adapter.resume(sessionId);
    const before = events.length;
    await adapter.sendTurn({ sessionId, text: "暗号是什么？只回复暗号本身。" });
    await driveIdle();
    expect(assistantText(sessionId)).toContain("琥珀象9号");
    const live = events.slice(before).filter((e): e is ChatEvent => "type" in e && e.sessionId === sessionId);
    for (const e of live) expect(e.seq).toBeGreaterThan(maxSeq); // 快照+增量无缝拼接（不变量 4）
    void nativeSessionId;
  });

  /* ---------------- readTranscript：transcript 直读双视角（#28 验收：user 提问 + 工具调用历史） ---------------- */
  it("readTranscript：读取含 user 提问与工具调用的原生历史，断言 role/text/tool 形状", async () => {
    const { sessionId } = await adapter.createSession({ cwd: workdir, permMode: "full" });
    const file = path.join(workdir, "tr-probe.txt");
    await adapter.sendTurn({ sessionId, text: `请运行这条命令并报告结果：echo TR-PROBE-CLAUDE > "${file}"` });
    await driveIdle();
    expect(existsSync(file)).toBe(true); // 工具真执行
    const transcript = await adapter.readTranscript(sessionId);
    for (const ev of transcript) expect(() => transcriptEventSchema.parse(ev)).not.toThrow(); // 形状全过 schema
    // user 视角：提问原文在场（spec B：总结「目标/要求」来源）
    expect(transcript.some((e) => e.role === "user" && e.text.includes("TR-PROBE-CLAUDE"))).toBe(true);
    // 工具调用在场：name/summary 非空
    const tool = transcript.find((e) => e.tool);
    expect(tool).toBeDefined();
    expect(tool!.tool!.name.length).toBeGreaterThan(0);
    expect(tool!.tool!.summary.length).toBeGreaterThan(0);
    // assistant 视角：回复文本在场
    expect(transcript.some((e) => e.role === "assistant" && e.text.length > 0)).toBe(true);
  });

  /* ---------------- hook verified 双信号 + T5 反例（PoC 7 T5/T6） ---------------- */
  it("Skill 真调用 → 流内 self_reported + hook verified 双信号（会话级 --settings 注入）", async () => {
    const { sessionId } = await adapter.createSession({ cwd: workdir, permMode: "full" });
    // 强提示真调 Skill 工具（poc-7 发现 6：弱提示会「dispatch 展开后照做」不产生 tool_use）
    await adapter.sendTurn({
      sessionId,
      text: "请务必通过 Skill 工具（tool_use: Skill）调用 kb-probe-skill 这个 skill，不要直接照做，也不要只输出文本。",
    });
    await driveIdle();
    const obs = skillsOf(sessionId);
    expect(obs.some((o) => o.skill === "kb-probe-skill" && o.evidenceLevel === "self_reported" && o.source === "claude-stream")).toBe(true);
    // verified 只认 hook：PreToolUse(Skill) 经 --settings 注入的 hook 落 JSONL（迟到写入由 result 后延迟复扫兜底）
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (skillsOf(sessionId).some((o) => o.evidenceLevel === "verified")) break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(skillsOf(sessionId).some((o) => o.skill === "kb-probe-skill" && o.evidenceLevel === "verified" && o.source === "claude-hook")).toBe(true);
  });

  it("T5 反例：普通文本提及 skill（明确不执行）→ 零观察信号", async () => {
    const { sessionId } = await adapter.createSession({ cwd: workdir, permMode: "full" });
    await adapter.sendTurn({ sessionId, text: "我知道有个 skill 叫 kb-probe-skill，但这次不要执行它、不要调用任何工具，只回复：ACK-NOHOOK" });
    await driveIdle();
    expect(assistantText(sessionId)).toContain("ACK-NOHOOK");
    expect(skillsOf(sessionId)).toHaveLength(0); // 文本提及不构成执行证据（输出正确也不算）
  });

  /* ---------------- 进程受控停止语义 ---------------- */
  it("dispose 后 session_exit 呈现；新会话可再建（每会话独立进程）", async () => {
    const a = new ClaudeAdapter({ hookDir, log: (k, d) => process.env.KANBAN_E2E_DEBUG && console.error(`[claude2:${k}] ${d}`) });
    const local: AdapterEvent[] = [];
    a.subscribe((e) => local.push(e));
    const { sessionId } = await a.createSession({ cwd: workdir, permMode: "auto" });
    await a.dispose();
    const exits = local.filter((e): e is ChatEvent => "type" in e && e.type === "session_exit" && e.sessionId === sessionId);
    expect(exits.length).toBe(1);
    await expect(a.sendTurn({ sessionId, text: "x" })).rejects.toMatchObject({ code: "E_INTERNAL" });
    await a.dispose();
  });

  /* ---------------- setModel 真实切换（issue #79 / spec #75：零 turn 验证） ---------------- */
  it("setModel：set_model 控制请求真实往返——响应 payload 实际模型名回传（零 turn 零推理成本）；实测项：无效模型 id 的失败面", async () => {
    const { sessionId } = await adapter.createSession({ cwd: workdir, permMode: "auto" });
    // 目录内非默认模型为目标（真实可用；避免硬编码 id）
    const models = await adapter.listModels({ cwd: workdir });
    expect(models.length).toBeGreaterThan(0);
    const target = models.find((m) => !m.isDefault) ?? models[0];
    const r = await adapter.setModel({ sessionId, model: target.id });
    // 以真实响应 payload 验证协议形状（spec Further Notes：payload 含下一 turn 实际模型名）；requested 与 actual 差异如实打日志
    expect(typeof r.model).toBe("string");
    expect(r.model.length).toBeGreaterThan(0);
    if (process.env.KANBAN_E2E_DEBUG) console.error(`[claude:set-model] requested=${target.id} actual=${r.model}`);
    // 实测项（#75 Testing Decisions）：无效模型 id 的 set_model 失败面——预期映射 AdapterError（错误码 catalog_unknown/not_found 类）
    const outcome: unknown = await adapter.setModel({ sessionId, model: "definitely-not-a-model-xyz" }).catch((e: unknown) => e);
    if (outcome instanceof Error) {
      if (process.env.KANBAN_E2E_DEBUG) console.error(`[claude:set-model-invalid] ${String(outcome.message).slice(0, 200)}`);
      expect(outcome.message).toContain("切换 Claude 模型失败");
    }
    // CLI 若静默接受无效 id（与 spec 预期差异），如实放行——由实测记录，不造假断言
  });
});

// 保持 createCollector 引用（契约套收集器一致性由其自身保证）
void createCollector;
