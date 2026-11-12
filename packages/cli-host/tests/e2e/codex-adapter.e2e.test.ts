// 用途：CodexAdapter 真实集成套（KANBAN_E2E=1 才跑）—— 契约套参数化复跑 + 权限三档可观察差异 + ≥3 会话并发 + 模型回退；短提示+effort low 控成本
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../../src/codex-adapter";
import { defineAdapterContractTests, createCollector } from "../../src/adapter.contract";
import { resolveCodexExe, readCodexVersion } from "../../src/codex/exe";
import { probeProtocol } from "../../src/codex/protocol-probe";
import type { AdapterEvent, ChatEvent, PermMode } from "@kanban/ipc-schema";
import { transcriptEventSchema } from "@kanban/ipc-schema";

const E2E = process.env.KANBAN_E2E === "1";

// 真实模型 turn 十秒级：测试与钩子都放宽
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

// fixture 顶层同步初始化（契约套 opts 在 describe 收集阶段求值，值须在调用前就绪；beforeAll 赋值会捕获到空串）；
// 非 E2E 模式不建目录（describe skip 后 afterAll 不执行，无条件 mkdtemp 会泄漏临时目录）
const workdir = E2E ? mkdtempSync(path.join(tmpdir(), "kb-e2e-work-")) : "";
const outside = E2E ? mkdtempSync(path.join(tmpdir(), "kb-e2e-out-")) : "";
// 审批共用 prompt：两条独立写 cwd 内命令 + ask 档（untrusted）——非只读操作必弹原生审批
// （e2e 实测：写 cwd 外时模型直接文字拒绝不执行命令、不触发审批；写内+untrusted 稳定弹，poc-1 d 同理）
const f1 = path.join(workdir, "probe-f1.txt");
const f2 = path.join(workdir, "probe-f2.txt");

/** 尽力清理：Windows 下子进程退出有延迟，重试后仍锁则放行（残留 %TEMP% 不判失败） */
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
const approvalPrompt = [
  "请依次分别运行下面两条 shell 命令（分成两次独立运行，不要合并成一条，也不要跳过）：",
  `1) echo a > "${f1}"`,
  `2) echo b > "${f2}"`,
  "每条运行完后各用一句话报告结果。",
].join("\n");

describe.skipIf(!E2E)("CodexAdapter 真实集成（env-gated）", () => {
  let adapter: CodexAdapter;
  const events: AdapterEvent[] = [];

  beforeAll(() => {
    adapter = new CodexAdapter({ effort: "low", log: (k, d) => process.env.KANBAN_E2E_DEBUG && console.error(`[codex:${k}] ${d}`) });
    adapter.subscribe((e) => events.push(e));
  });

  afterAll(async () => {
    await adapter.dispose(); // 等进程退出后再清理（workdir 是 codex 子进程 cwd，未退出时 rmSync EPERM）
    rmBestEffort(workdir);
    rmBestEffort(outside);
  });

  const chat = (sid: string) => events.filter((e): e is ChatEvent => "type" in e && e.sessionId === sid);

  /** 轮询推进到全局空闲（running 消失且稳定 800ms；waiting=审批等待用户视为稳定） */
  async function driveIdle(): Promise<void> {
    const deadline = Date.now() + 180_000;
    let stableSince = 0;
    for (;;) {
      if (Date.now() > deadline) throw new Error("driveIdle 超时（180s 无空闲）");
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

  /* ---------------- 契约套（Fake 同断言参数化复跑，spec Testing seam 1） ---------------- */
  defineAdapterContractTests(
    async () => ({ adapter, driveIdle }),
    {
      turnText: "请用两三句话解释什么是单元测试。",
      secondTurnText: "只回复一句话：第二轮完成。",
      interruptTurnText: "请从 1 慢慢数到 30，每行一个数字，不要跳过任何数字，也不要提前停止。",
      approvalTurnText: approvalPrompt,
      approvalPermMode: "ask", // untrusted：非只读操作必弹审批（on-request 下模型可能不主动请求提升——e2e 第二轮实测）
      cwd: workdir, // 真实执行命令须真实存在的目录（占位 cwd 会导致模型不执行命令、无审批）
      assistantMessages: { atLeast: 1 },
      firstAssistantText: null,
      suggestionsRequired: false,
      deny: { contains: [], notContains: [], verify: async () => { expect(existsSync(f1)).toBe(false); } },
      once: { outputContains: [], verify: async () => { expect(existsSync(f1)).toBe(true); } },
      // codex 0.144.1 实测：acceptForSession 后「不同目标文件的同类型写命令」仍会再问（CLI 原生会话级放行范围窄于 Fake 脚本）；
      // 映射不换写（allow-always→acceptForSession），断言按真实行为：第一命令真执行（f1 存在），第二审批按 CLI 语义处理
      always: { outputContains: [], finalContains: [], expectNoSecondAsk: false, verify: async () => { expect(existsSync(f1)).toBe(true); } },
    },
  );

  /* ---------------- 权限三档映射：每档一个可观察差异（spec B 权限映射表） ---------------- */
  async function permSession(permMode: PermMode) {
    const { sessionId } = await adapter.createSession({ cwd: workdir, permMode });
    return sessionId;
  }
  const assistantText = (sid: string) =>
    chat(sid)
      .filter((e): e is Extract<ChatEvent, { type: "message_delta" }> => e.type === "message_delta")
      .map((e) => e.delta)
      .join("");

  it("权限档位 ask（untrusted+workspace-write）：写 cwd 内文件也触发原生审批", async () => {
    const sid = await permSession("ask");
    const file = path.join(workdir, "perm-ask.txt"); // cwd 内：untrusted 对非只读操作仍问
    await adapter.sendTurn({ sessionId: sid, text: `请运行这条命令并报告结果：echo ask > "${file}"` });
    await driveIdle();
    const req = chat(sid).find((e) => e.type === "approval_requested");
    expect(req).toBeDefined(); // ask 档：工具执行前询问
    await adapter.resolveApproval({ sessionId: sid, requestId: req!.requestId, decision: "allow-once" });
    await driveIdle();
    expect(existsSync(file)).toBe(true); // accept 真执行
  });

  it("权限档位 auto（on-request+workspace-write）：写 cwd 内直接放行不弹审批", async () => {
    const sid = await permSession("auto");
    const file = path.join(workdir, "perm-auto.txt"); // 同为 cwd 内写：与 ask 档的可观察差异
    await adapter.sendTurn({ sessionId: sid, text: `请运行这条命令并报告结果：echo auto > "${file}"` });
    await driveIdle();
    expect(chat(sid).some((e) => e.type === "approval_requested")).toBe(false); // 沙箱内写：无审批
    expect(existsSync(file)).toBe(true);
    expect(chat(sid).some((e) => e.type === "turn_completed")).toBe(true);
  });

  it("权限档位 full（never+danger-full-access）：写 cwd 外直接执行不弹审批", async () => {
    const sid = await permSession("full");
    const file = path.join(outside, "perm-full.txt");
    await adapter.sendTurn({ sessionId: sid, text: `请运行这条命令并报告结果：echo full > "${file}"` });
    await driveIdle();
    expect(chat(sid).some((e) => e.type === "approval_requested")).toBe(false); // 全放行
    expect(existsSync(file)).toBe(true);
    expect(chat(sid).some((e) => e.type === "turn_completed")).toBe(true);
  });

  /* ---------------- ≥3 会话并发无串扰（工单验收 7） ---------------- */
  it("3 会话并发 turn：各自回复正确、事件按会话无串扰", async () => {
    const marks = ["ALPHA-91", "BRAVO-92", "CHERRY-93"];
    const sids: string[] = [];
    for (const _ of marks) sids.push(await permSession("auto"));
    await Promise.all(marks.map((m, i) => adapter.sendTurn({ sessionId: sids[i], text: `只回复这个词，不要回复其他任何内容：${m}` })));
    await driveIdle();
    for (let i = 0; i < marks.length; i++) {
      const text = assistantText(sids[i]);
      expect(text).toContain(marks[i]);
      for (let j = 0; j < marks.length; j++) {
        if (j !== i) expect(text).not.toContain(marks[j]); // 无串扰
      }
    }
  });

  /* ---------------- readTranscript：thread/read 只读双视角（#28 验收：user 提问 + 工具调用历史） ---------------- */
  it("readTranscript：读取含 user 提问与工具调用的原生历史（thread/read 只读，不 resume 不发 turn），断言 role/text/tool 形状", async () => {
    const sid = await permSession("full");
    const file = path.join(workdir, "tr-probe.txt");
    await adapter.sendTurn({ sessionId: sid, text: `请运行这条命令并报告结果：echo TR-PROBE-CODEX > "${file}"` });
    await driveIdle();
    expect(existsSync(file)).toBe(true); // 工具真执行
    const transcript = await adapter.readTranscript(sid);
    for (const ev of transcript) expect(() => transcriptEventSchema.parse(ev)).not.toThrow(); // 形状全过 schema
    expect(transcript.some((e) => e.role === "user" && e.text.includes("TR-PROBE-CODEX"))).toBe(true); // user 提问原文
    const tool = transcript.find((e) => e.tool);
    expect(tool).toBeDefined();
    expect(tool!.tool!.name.length).toBeGreaterThan(0);
    expect(tool!.tool!.summary.length).toBeGreaterThan(0);
    expect(transcript.some((e) => e.role === "assistant" && e.text.length > 0)).toBe(true); // assistant 回复在场
  });

  /* ---------------- 模型可用性（model/list 不可信，poc-1 发现 2；spec #75/#76 修正：显式失败不回退） ---------------- */
  it("显式假模型名 → 创建直接报错含模型名（不静默回退换模型；探测 400 拒绝零推理成本）", async () => {
    await expect(adapter.createSession({ cwd: workdir, model: "definitely-not-a-model-xyz", permMode: "auto" })).rejects.toThrow(
      /definitely-not-a-model-xyz/,
    );
  });

  /* ---------------- 锁版本 + generate-ts diff 协议探针（§7-6；独立 env 开关：成本较高，升级/排障时跑） ---------------- */
  describe.skipIf(process.env.KANBAN_PROTOCOL_PROBE !== "1")("协议探针", () => {
    it("generate-ts 产物与锁版本基线 diff 一致", () => {
      const exe = resolveCodexExe();
      console.log("[probe] exe:", exe, "version:", readCodexVersion(exe));
      const r = probeProtocol(exe);
      console.log("[probe]", r.detail);
      expect(r.generated).toBe(true);
      expect(r.matchesBaseline).toBe(true);
    });
  });

  /* ---------------- 进程受控停止：session_exit + 后续明确报错（工单验收 3） ---------------- */
  /* ---------------- setModel 真实切换（issue #79：白名单控成本，最小 turn 验证） ---------------- */
  it("setModel：切换白名单模型后 turn/start 携带新 model——最小 turn 正常完成（不可用模型会 400 报错，完成即覆盖参数生效）", async () => {
    const preferred = (process.env.KANBAN_CODEX_MODEL ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    expect(preferred.length).toBeGreaterThan(0); // 白名单必设（docs/testing.md 门禁协议；成本控制不回退）
    const { sessionId } = await adapter.createSession({ cwd: workdir, model: preferred[0] }); // 探测一次（白名单内廉价模型）
    const target = preferred[1] ?? preferred[0];
    await expect(adapter.setModel({ sessionId, model: target })).resolves.toEqual({ model: target });
    await adapter.sendTurn({ sessionId, text: "只回复两个字：收到" });
    await driveIdle();
    expect(chat(sessionId).some((e) => e.type === "turn_completed")).toBe(true); // turn/start 携带新 model 被服务端接受并完成
    expect(chat(sessionId).some((e) => e.type === "session_error")).toBe(false);
  });

  it("dispose 后 session_exit 呈现，后续操作明确报错不重放", async () => {
    const a = new CodexAdapter({ effort: "low" });
    const local: AdapterEvent[] = [];
    a.subscribe((e) => local.push(e));
    const { sessionId } = await a.createSession({ cwd: workdir, permMode: "auto" });
    await a.dispose();
    const exits = local.filter((e): e is ChatEvent => "type" in e && e.type === "session_exit" && e.sessionId === sessionId);
    expect(exits.length).toBe(1);
    await expect(a.sendTurn({ sessionId, text: "x" })).rejects.toMatchObject({ code: "E_INTERNAL" });
  });
});

// 保持 createCollector 引用（契约套收集器与事件形状一致性由其自身保证）
void createCollector;
