// 用途：OpenCodeAdapter 真实集成套（KANBAN_E2E=1 才跑）—— 契约套参数化复跑（真 server 真 magpie 模型）+ server-per-project 并发引用计数 + 权限三档可观察差异（含 *:*:allow 三层证据）+ abort 续聊 + /command 路由 self_reported + always 判定 + dispose→resume/跨实例收养暗号复现 + 孤儿接管（先核对再接管）+ 端口冲突报错；短提示控成本（内网 GLM 网关 token cost=0）
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OpenCodeAdapter } from "../../src/opencode-adapter";
import { OpenCodeServerHost } from "../../src/opencode/server-host";
import { createCollector, defineAdapterContractTests } from "../../src/adapter.contract";
import type { CliAdapter } from "../../src/adapter";
import type { AdapterEvent, ChatEvent, SkillObservation } from "@kanban/ipc-schema";

const E2E = process.env.KANBAN_E2E === "1";

// 真实模型 turn 十秒级：测试与钩子都放宽
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

// fixture 顶层同步初始化（契约套 opts 在 describe 收集阶段求值；非 E2E 不建目录）
const root = E2E ? mkdtempSync(path.join(tmpdir(), "kb-oc-e2e-")) : "";
const xdgRoot = E2E ? path.join(root, "xdg") : ""; // 隔离用户全局 opencode 数据（poc-3 同法；生产路径无隔离，注入机制同为 OPENCODE_CONFIG_CONTENT）
const registryPath = E2E ? path.join(root, "servers.json") : "";
const workdir = E2E ? path.join(root, "work") : ""; // 契约套 + abort + command + 重启恢复（一 server 贯穿）
const concDir = E2E ? path.join(root, "conc") : ""; // 并发（独立 cwd：独立 server，避免与契约 server 双进程共写同一 XDG 数据库）
const askDir = E2E ? path.join(root, "ask") : "";
const autoDir = E2E ? path.join(root, "auto") : "";
const fullDir = E2E ? path.join(root, "full") : "";
const alwaysDir = E2E ? path.join(root, "always") : "";
const orphanDir = E2E ? path.join(root, "orphan") : "";

// e2e provider 只读注入（poc-3 §10.1：XDG 隔离下从用户全局 opencode.json 只读复制 magpie；密钥不进 git/日志）
const magpieProvider = E2E
  ? (() => {
      const globalPath = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".config", "opencode", "opencode.json");
      const cfg = JSON.parse(readFileSync(globalPath, "utf8")) as { provider?: Record<string, unknown> };
      const prov = cfg.provider?.magpie;
      if (!prov) throw new Error("e2e 需要 ~/.config/opencode/opencode.json 内 magpie provider（只读复制注入）");
      return prov;
    })()
  : null;

if (E2E) {
  for (const dir of [workdir, concDir, askDir, autoDir, fullDir, alwaysDir, orphanDir]) mkdirSync(dir, { recursive: true });
  // 探针 command：须在 server spawn 前落盘（poc-3：command 文件新增需重启 server 才被发现）
  const cmdDir = path.join(workdir, ".opencode", "command");
  mkdirSync(cmdDir, { recursive: true });
  writeFileSync(
    path.join(cmdDir, "kb-probe.md"),
    "---\ndescription: e2e 探针 command，被调用时只回复固定标记\n---\n\n请只回复这一句话：COMMAND-KB-PROBE-OK\n",
    "utf8",
  );
  // read 档探针种子
  writeFileSync(path.join(askDir, "seed.txt"), "ASK-TIER-PROBE", "utf8");
  writeFileSync(path.join(autoDir, "seed.txt"), "AUTO-TIER-PROBE", "utf8");
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

/** e2e 专用 host 构造（隔离 XDG + provider 注入；生产差异仅在两者为空） */
function makeE2EHost(registry: string, overrides: Partial<ConstructorParameters<typeof OpenCodeServerHost>[0]> = {}): OpenCodeServerHost {
  return new OpenCodeServerHost({
    registryPath: registry,
    xdgRoot,
    extraConfig: magpieProvider ? { provider: { magpie: magpieProvider } } : undefined,
    log: (k, d) => process.env.KANBAN_E2E_DEBUG && console.error(`[oc:${k}] ${d}`),
    ...overrides,
  });
}

// 审批共用 prompt：两条独立写命令（与 Codex/Claude e2e 同构；ask/auto 档注入 bash:ask 下必弹审批；强指令降低「只答文本不跑工具」的模型抖动）
const f1 = E2E ? path.join(workdir, "probe-f1.txt") : "";
const approvalPrompt = [
  "请务必使用 bash 工具真实执行（不要只描述、不要只回答文本）：依次分别运行下面两条 shell 命令（分成两次独立运行，不要合并成一条，也不要跳过）：",
  `1) echo a > "${f1}"`,
  `2) echo b > "${path.join(workdir, "probe-f2.txt")}"`,
  "每条运行完后各用一句话报告结果。",
].join("\n");

describe.skipIf(!E2E)("OpenCodeAdapter 真实集成（env-gated）", () => {
  let adapter!: OpenCodeAdapter;
  const events: AdapterEvent[] = [];
  /** 重启恢复用例登记的 native 会话（跨实例收养用例消费） */
  let recovered: { nativeId: string; cwd: string } | null = null;
  /** driveIdle 作用域水位：只等待本测试开始后活跃的会话（避免早前卡死会话级联拖垮后续用例） */
  let watermark = 0;
  const markScope = (): void => {
    watermark = events.length;
  };

  beforeAll(() => {
    adapter = new OpenCodeAdapter({ host: makeE2EHost(registryPath) });
    adapter.subscribe((e) => events.push(e));
  });

  afterAll(async () => {
    await adapter.dispose(); // 停 server（会话数据已落盘于隔离 XDG，随后清理）
    rmBestEffort(root);
  });

  const chat = (sid: string) => events.filter((e): e is ChatEvent => "type" in e && e.sessionId === sid);
  const skillsOf = (sid: string) => events.filter((e): e is SkillObservation => !("type" in e) && e.sessionId === sid);
  const assistantText = (sid: string) =>
    chat(sid)
      .filter((e): e is Extract<ChatEvent, { type: "message_delta" }> => e.type === "message_delta")
      .map((e) => e.delta)
      .join("");

  /** 轮询推进到空闲（running 消失且稳定 800ms；waiting=审批等待用户视为稳定；只看水位之后的会话事件） */
  async function driveIdle(): Promise<void> {
    const deadline = Date.now() + 240_000;
    let stableSince = 0;
    for (;;) {
      if (Date.now() > deadline) throw new Error("driveIdle 超时（240s 无空闲）");
      const statuses = new Map<string, string>();
      for (const e of events.slice(watermark)) if ("type" in e && e.type === "session_status") statuses.set(e.sessionId, e.status);
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

  /** 等指定会话列表全部到达非运行终态 */
  async function waitSessionsDone(local: AdapterEvent[], sids: string[], timeoutMs = 240_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const statuses = sids.map((sid) => {
        const ss = local.filter((e): e is Extract<ChatEvent, { type: "session_status" }> => "type" in e && e.sessionId === sid && e.type === "session_status");
        return ss.at(-1)?.status;
      });
      if (statuses.every((s) => s === "idle" || s === "interrupted" || s === "disconnected")) return;
      if (Date.now() > deadline) throw new Error("turn 超时");
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  const joinedText = (local: AdapterEvent[], sid: string): string =>
    local
      .filter((e): e is Extract<ChatEvent, { type: "message_delta" }> => "type" in e && e.sessionId === sid && e.type === "message_delta")
      .map((e) => e.delta)
      .join("");

  /* ---------------- 契约套（Fake 同断言参数化复跑，spec Testing seam 1） ----------------
   * 会话目录隔离：契约每个会话给独立 cwd → 独立 server。两个原因：
   * 1) allow-always 的 pattern 规则为 server 级持久（实证）——契约 always 用例放行 echo * 后，
   *    同 server 后续用例的 echo 审批被自动跳过（非法时序必挂）；
   * 2) 档位从 spawn 起效——审批用例（ask）不再与不变量用例（缺省 auto）共享 server 串档。 */
  let contractCwdSeq = 0;
  const contractAdapter: CliAdapter = {
    get capabilities() {
      return adapter.capabilities;
    },
    subscribe: (h) => adapter.subscribe(h),
    createSession: (init) => {
      // 审批用例（approvalPermMode=ask）→ 独立 cwd 独立 server；其余共享 workdir server
      if (init.permMode !== "ask") return adapter.createSession({ ...init, cwd: workdir });
      contractCwdSeq += 1;
      const cwd = path.join(root, "contract", `s${contractCwdSeq}`);
      mkdirSync(cwd, { recursive: true });
      return adapter.createSession({ ...init, cwd });
    },
    sendTurn: (i) => adapter.sendTurn(i),
    interruptTurn: (id) => adapter.interruptTurn(id),
    resolveApproval: (i) => adapter.resolveApproval(i),
    readHistory: (id) => adapter.readHistory(id),
    resume: (id) => adapter.resume(id),
    dispose: (i) => adapter.dispose(i),
  };
  defineAdapterContractTests(
    async () => {
      markScope(); // 契约各用例独立作用域
      return { adapter: contractAdapter, driveIdle };
    },
    {
      turnText: "请用两三句话解释什么是单元测试。",
      secondTurnText: "只回复一句话：第二轮完成。",
      interruptTurnText: "请从 1 慢慢数到 30，每行一个数字，不要跳过任何数字，也不要提前停止。",
      approvalTurnText: approvalPrompt,
      approvalPermMode: "ask",
      cwd: workdir, // 占位（契约 wrapper 已按会话改写为独立 cwd）
      assistantMessages: { atLeast: 1 },
      firstAssistantText: null,
      suggestionsRequired: true,
      deny: { contains: [], notContains: [], verify: async () => { expect(existsSync(f1)).toBe(false); } },
      once: { outputContains: [], verify: async () => { expect(existsSync(f1)).toBe(true); } },
      // 真实放行范围由 server 解释（always patterns 为 server 级建议）：第一命令真执行；第二审批按原生语义处理
      always: { outputContains: [], finalContains: [], expectNoSecondAsk: false, verify: async () => { expect(existsSync(f1)).toBe(true); } },
    },
  );

  /* ---------------- server-per-project：并发 ≥3 共享 server + 引用计数生命周期 ---------------- */
  it("server-per-project：并发 ≥3 会话共享同一 server 回复互不串扰；逐个 dispose 最后一个释放才停", async () => {
    markScope();
    const host = makeE2EHost(path.join(root, "servers-conc.json"));
    const a = new OpenCodeAdapter({ host });
    const local: AdapterEvent[] = [];
    a.subscribe((e) => local.push(e));
    const s1 = (await a.createSession({ cwd: concDir })).sessionId;
    const s2 = (await a.createSession({ cwd: concDir })).sessionId;
    const s3 = (await a.createSession({ cwd: concDir })).sessionId;
    const inspect = host.inspect();
    expect(inspect).toHaveLength(1); // server-per-project：一个项目一个 server
    expect(inspect[0].refs).toBe(3); // 引用计数 3
    // 三路并发（真实模型调用）
    const texts = ["只回复：OK1", "只回复：OK2", "请记住暗号：紫貂3号。只回复：已记住。"];
    await Promise.all([s1, s2, s3].map((sid, i) => a.sendTurn({ sessionId: sid, text: texts[i] })));
    await waitSessionsDone(local, [s1, s2, s3]);
    expect(joinedText(local, s1)).toContain("OK1");
    expect(joinedText(local, s2)).toContain("OK2");
    expect(joinedText(local, s3)).toContain("已记住"); // 无串扰
    // 逐个 dispose：引用计数归零才停
    await a.dispose({ sessionId: s1 });
    expect(host.inspect()[0]?.refs).toBe(2);
    await a.dispose({ sessionId: s2 });
    expect(host.inspect()[0]?.refs).toBe(1);
    await a.dispose({ sessionId: s3 });
    expect(host.inspect()).toHaveLength(0); // 最后一个会话释放才停 server
  });

  /* ---------------- 权限三档映射（spec B OpenCode 列；独立 cwd = 独立 server 保证档位从 spawn 起效） ---------------- */
  it("权限档位 ask：read 工具也弹审批（显式 read:ask 注入生效）", async () => {
    markScope();
    const seed = path.join(askDir, "seed.txt");
    const { sessionId } = await adapter.createSession({ cwd: askDir, permMode: "ask" });
    await adapter.sendTurn({ sessionId, text: `请用 read 工具读取文件 "${seed}" 并原样告诉我内容，不要运行任何命令。` });
    await driveIdle();
    const req = chat(sessionId).find((e): e is Extract<ChatEvent, { type: "approval_requested" }> => e.type === "approval_requested");
    expect(req).toBeDefined(); // ask 档：只读工具也弹审批
    expect(req!.command.toLowerCase()).toContain("read");
    await adapter.resolveApproval({ sessionId, requestId: req!.requestId, decision: "allow-once" });
    await driveIdle();
    expect(assistantText(sessionId)).toContain("ASK-TIER-PROBE"); // 放行后真读取
    await adapter.dispose({ sessionId });
  });

  it("权限档位 auto：read 直接放行不弹审批（read 未注入 → 原生默认放行）", async () => {
    markScope();
    const seed = path.join(autoDir, "seed.txt");
    const { sessionId } = await adapter.createSession({ cwd: autoDir, permMode: "auto" });
    await adapter.sendTurn({ sessionId, text: `请用 read 工具读取文件 "${seed}" 并原样告诉我内容，不要运行任何命令。` });
    await driveIdle();
    expect(chat(sessionId).some((e) => e.type === "approval_requested")).toBe(false); // 读放行
    expect(assistantText(sessionId)).toContain("AUTO-TIER-PROBE");
    expect(chat(sessionId).some((e) => e.type === "turn_completed")).toBe(true);
    await adapter.dispose({ sessionId });
  });

  it("权限档位 full：bash 写文件直接执行不弹审批 + /agent 表含 *:*:allow（三层证据回归）", async () => {
    markScope();
    const host = makeE2EHost(registryPath);
    const a = new OpenCodeAdapter({ host });
    const local: AdapterEvent[] = [];
    a.subscribe((e) => local.push(e));
    const file = path.join(fullDir, "perm-full.txt");
    const { sessionId } = await a.createSession({ cwd: fullDir, permMode: "full" });
    await a.sendTurn({ sessionId, text: `请运行这条命令并报告结果：echo full > "${file}"` });
    await waitSessionsDone(local, [sessionId]);
    expect(local.some((e): e is ChatEvent => "type" in e && e.sessionId === sessionId && e.type === "approval_requested")).toBe(false); // 全放行（无 permission 注入 → 原生默认）
    expect(existsSync(file)).toBe(true); // 命令真执行
    expect(local.some((e): e is ChatEvent => "type" in e && e.sessionId === sessionId && e.type === "turn_completed")).toBe(true);
    // 三层证据之二：GET /agent 运行时权限表 *:*:allow（经 server 端口直读；兼容 {items} 与裸数组两种形状）
    const entry = host.inspect().find((s) => s.cwd === fullDir);
    expect(entry).toBeDefined();
    const agentRes = await fetch(`http://127.0.0.1:${entry!.port}/agent`);
    const agentJson = (await agentRes.json()) as unknown as Array<{ name?: string; permission?: Array<{ permission?: string; pattern?: string; action?: string }> }> | { items?: Array<{ name?: string; permission?: Array<{ permission?: string; pattern?: string; action?: string }> }> };
    const agents = Array.isArray(agentJson) ? agentJson : (agentJson.items ?? []);
    const build = agents.find((x) => x.name === "build");
    const table = build?.permission ?? [];
    expect(table.some((r) => r.permission === "*" && r.pattern === "*" && r.action === "allow")).toBe(true); // *:*:allow 原生默认
    await a.dispose(); // 引用归零停 server
  });

  /* ---------------- abort：取消保留会话可继续（MessageAbortedError 归类已取消，poc-3 §10.5） ---------------- */
  it("abort：长任务中断 → turn_interrupted + interrupted 状态；同会话可继续", async () => {
    markScope();
    const { sessionId } = await adapter.createSession({ cwd: workdir });
    await adapter.sendTurn({ sessionId, text: "请从 1 慢慢数到 30，每行一个数字，不要跳过，也不要提前停止。" });
    // 等首批输出到达再取消（保证取消的是进行中的 turn）
    const firstDelta = Date.now() + 120_000;
    while (!chat(sessionId).some((e) => e.type === "message_delta") && Date.now() < firstDelta) {
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(chat(sessionId).some((e) => e.type === "message_delta")).toBe(true);
    await adapter.interruptTurn(sessionId);
    await waitSessionsDone(events, [sessionId]);
    expect(chat(sessionId).some((e) => e.type === "turn_interrupted")).toBe(true);
    expect(chat(sessionId).at(-1)).toMatchObject({ type: "session_status", status: "interrupted" });
    // 会话保留可继续
    await adapter.sendTurn({ sessionId, text: "只回复一句话：取消后可继续。" });
    await driveIdle();
    expect(assistantText(sessionId)).toContain("取消后可继续");
  });

  /* ---------------- /command 路由：SkillObservation self_reported（spec B） ---------------- */
  it("/command：命中已知 command → command API 真执行 + self_reported；未命中按普通 prompt", async () => {
    markScope();
    const { sessionId } = await adapter.createSession({ cwd: workdir });
    await adapter.sendTurn({ sessionId, text: "/kb-probe" });
    await driveIdle();
    expect(skillsOf(sessionId).some((o) => o.skill === "kb-probe" && o.evidenceLevel === "self_reported" && o.source === "opencode-command")).toBe(true);
    expect(assistantText(sessionId)).toContain("COMMAND-KB-PROBE-OK"); // 模板真实执行（poc-3 §10.4：非文本展开模拟）
    expect(chat(sessionId).some((e) => e.type === "turn_completed")).toBe(true);
    // 未命中的斜杠输入按普通 prompt
    const { sessionId: sid2 } = await adapter.createSession({ cwd: workdir });
    await adapter.sendTurn({ sessionId: sid2, text: "/definitely-not-a-command 只回复：PLAIN-PROMPT-OK" });
    await driveIdle();
    expect(skillsOf(sid2)).toHaveLength(0);
    expect(assistantText(sid2)).toContain("PLAIN-PROMPT-OK");
  });

  /* ---------------- always 判定（spec B：未实测则 capabilities 声明/UI 不暴露；本用例即实证） ---------------- */
  it("allow-always：第一命令 always 放行后同类第二命令不再询问（patterns server 级生效）", async () => {
    markScope();
    const g1 = path.join(alwaysDir, "always-g1.txt");
    const g2 = path.join(alwaysDir, "always-g2.txt");
    const host = makeE2EHost(path.join(root, "servers-always.json"));
    const a = new OpenCodeAdapter({ host });
    const local: AdapterEvent[] = [];
    a.subscribe((e) => local.push(e));
    const { sessionId } = await a.createSession({ cwd: alwaysDir, permMode: "ask" });
    await a.sendTurn({
      sessionId,
      text: [
        "请依次分别运行下面两条 shell 命令（分成两次独立运行，不要合并，也不要跳过）：",
        `1) echo g1 > "${g1}"`,
        `2) echo g2 > "${g2}"`,
        "每条运行完后各用一句话报告结果。",
      ].join("\n"),
    });
    // 停在第一处审批等待（waiting 稳定）
    const waitApproval = async (): Promise<Extract<ChatEvent, { type: "approval_requested" }>> => {
      const deadline = Date.now() + 180_000;
      for (;;) {
        const req = local.find((e): e is Extract<ChatEvent, { type: "approval_requested" }> => "type" in e && e.sessionId === sessionId && e.type === "approval_requested");
        if (req) return req;
        if (Date.now() > deadline) throw new Error("审批未到达");
        await new Promise((r) => setTimeout(r, 400));
      }
    };
    const first = await waitApproval();
    await a.resolveApproval({ sessionId, requestId: first.requestId, decision: "allow-always" });
    await waitSessionsDone(local, [sessionId]);
    const asks = local.filter((e): e is Extract<ChatEvent, { type: "approval_requested" }> => "type" in e && e.sessionId === sessionId && e.type === "approval_requested");
    expect(asks.length).toBe(1); // 同类（echo *）不再询问 —— always 实证
    expect(existsSync(g1)).toBe(true);
    expect(existsSync(g2)).toBe(true);
    expect(local.some((e): e is ChatEvent => "type" in e && e.sessionId === sessionId && e.type === "turn_completed")).toBe(true);
    await a.dispose();
  });

  /* ---------------- 重启恢复：dispose 停 server → readHistory 拉起回填 → 上下文延续（poc-3 resume） ---------------- */
  it("dispose → session_exit；readHistory 按需拉起 server 回填历史；resume 后暗号无损复现", async () => {
    markScope();
    const { sessionId, nativeSessionId } = await adapter.createSession({ cwd: workdir });
    recovered = { nativeId: nativeSessionId!, cwd: workdir };
    await adapter.sendTurn({ sessionId, text: "请记住这个暗号：青鸾6号。只回复：已记住，暗号是青鸾6号" });
    await driveIdle();
    expect(chat(sessionId).some((e) => e.type === "turn_completed")).toBe(true);
    await adapter.dispose(); // 全局受控终止：server 停止，会话状态保留（进程死亡语义）
    expect(chat(sessionId).some((e) => e.type === "session_exit")).toBe(true);
    expect(chat(sessionId).at(-1)).toMatchObject({ type: "session_status", status: "disconnected" });
    await expect(adapter.sendTurn({ sessionId, text: "x" })).rejects.toMatchObject({ code: "E_INTERNAL" });
    // 断开态 readHistory：按需拉起 server + 原生历史回填（快照含暗号轮，与实时流同键无重复）
    const snapshot = await adapter.readHistory(sessionId);
    const snapshotText = snapshot
      .filter((e): e is Extract<ChatEvent, { type: "message_delta" }> => e.type === "message_delta")
      .map((e) => e.delta)
      .join("");
    expect(snapshotText).toContain("青鸾6号");
    const maxSeq = Math.max(...snapshot.map((e) => e.seq));
    // resume：续问暗号（原生上下文经 native session id 延续）
    await adapter.resume(sessionId);
    await adapter.sendTurn({ sessionId, text: "暗号是什么？只回复暗号本身。" });
    await driveIdle();
    expect(assistantText(sessionId)).toContain("青鸾6号");
    for (const e of chat(sessionId).filter((e) => e.seq > maxSeq)) expect(e.seq).toBeGreaterThan(maxSeq); // 快照+增量无缝拼接（不变量 4）
  });

  it("跨实例收养（#13 接入点）：新 adapter adoptSession → 原生历史可读 → 暗号续问复现", async () => {
    markScope();
    expect(recovered).toBeTruthy();
    const b = new OpenCodeAdapter({ host: makeE2EHost(registryPath) });
    const adoptedId = "s-restart-adopt";
    await b.adoptSession({ sessionId: adoptedId, nativeSessionId: recovered!.nativeId, cwd: recovered!.cwd, permMode: "auto" });
    const local: AdapterEvent[] = [];
    b.subscribe((e) => local.push(e));
    const snapshot = await b.readHistory(adoptedId);
    expect(joinedText(snapshot, adoptedId)).toContain("青鸾6号"); // 原生历史在新实例可见
    await b.resume(adoptedId);
    await b.sendTurn({ sessionId: adoptedId, text: "再告诉我一次暗号，只回复暗号本身。" });
    await waitSessionsDone(local, [adoptedId]);
    expect(joinedText(local, adoptedId)).toContain("青鸾6号"); // 上下文延续
    await b.dispose();
  });

  /* ---------------- 孤儿接管：先核对再接管（t0-01 T4-A：exe+签名+创建时间核对，HTTP 可重连直接复用） ---------------- */
  it("孤儿 server 接管：宿主遗弃后新宿主核对复用同 pid（不重复 spawn），接管后可用、可受控终止", async () => {
    markScope();
    const regA = path.join(root, "servers-orphan.json");
    const hostA = makeE2EHost(regA);
    const a = new OpenCodeAdapter({ host: hostA });
    await a.createSession({ cwd: orphanDir, permMode: "auto" });
    const orphan = hostA.inspect().at(-1)!;
    expect(orphan.pid).toBeTruthy();
    hostA.abandon(orphanDir); // 模拟宿主崩溃：遗弃 server（进程存活 + 注册表条目保留）
    // 新宿主：注册表核对（exe/命令行签名/创建时间）+ HTTP 可达 → 接管复用（不重复 spawn）
    const hostB = makeE2EHost(regA);
    const b = new OpenCodeAdapter({ host: hostB });
    const local: AdapterEvent[] = [];
    b.subscribe((e) => local.push(e));
    const sb = await b.createSession({ cwd: orphanDir, permMode: "auto" }); // 首次 acquire 即接管路径
    const adopted = hostB.inspect().at(-1)!;
    expect(adopted.pid).toBe(orphan.pid); // 同一进程：未重复 spawn
    expect(adopted.port).toBe(orphan.port);
    // 接管后可用（真会话真回复）
    await b.sendTurn({ sessionId: sb.sessionId, text: "只回复：ORPHAN-ADOPT-OK" });
    await waitSessionsDone(local, [sb.sessionId]);
    expect(joinedText(local, sb.sessionId)).toContain("ORPHAN-ADOPT-OK");
    await b.dispose(); // 接管者受控终止（taskkill 按 pid，接管进程无子进程句柄）
    // 等进程退出（最多 8s；系统繁忙时 taskkill 生效有延迟）
    const killDeadline = Date.now() + 8_000;
    let alive = true;
    for (;;) {
      try {
        process.kill(orphan.pid!, 0);
      } catch {
        alive = false;
        break;
      }
      if (Date.now() > killDeadline) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(alive).toBe(false); // 进程已终止，无孤儿残留
  });

  /* ---------------- 端口冲突：serve 起不来明确报错（重试耗尽不挂死） ---------------- */
  it("端口冲突：目标端口被占 → 启动失败明确报错", async () => {
    markScope();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const blockedPort = (blocker.address() as net.AddressInfo).port;
    const host = makeE2EHost(path.join(root, "servers-conflict.json"), {
      portPicker: async () => blockedPort, // 固定撞占用端口
      portRetries: 2,
      startTimeoutMs: 6_000,
    });
    const a = new OpenCodeAdapter({ host });
    await expect(a.createSession({ cwd: path.join(root, "conflict"), permMode: "auto" })).rejects.toMatchObject({
      code: "E_INTERNAL",
      message: expect.stringContaining("启动失败"),
    });
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });
});

// 保持 createCollector 引用（契约收集器一致性由其自身保证）
void createCollector;
