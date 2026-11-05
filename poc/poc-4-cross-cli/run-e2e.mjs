// 用途：PoC 4 端到端混合流运行器 —— 场景 1-5 全链路：真实 Claude hook 建卡 → 真实 Codex turn + self_reported → 合成 OpenCode 事件 → 手动修正/重放/延迟/乱序注入 → 解除关联 → 重启恢复（--verify-restart 子命令为新进程校验）
// 用法：node run-e2e.mjs               # 主链路（真实模型调用 ≤8 次硬上限）
//       node run-e2e.mjs --verify-restart  # 退出重开校验：新进程读同一 SQLite 恢复并做重放注入
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PoCEngine } from "./lib/engine.mjs";
import { runClaudePrompt, readHookSkillEvents, hookFileLineCount, HOOK_FILE, FIXTURE_PROJ } from "./adapters/claude.mjs";
import { CodexAppServerClient } from "./adapters/codex-client.mjs";
import { synthSkillEvent, guiEvent } from "./adapters/synth.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const RUNS = join(here, "runs");
const DB = join(RUNS, "poc4.db");
const WORKDIR = join(here, "fixture", "workdir");
mkdirSync(RUNS, { recursive: true });

const MODEL_BUDGET = 8; // 真实模型调用硬上限（一句话级）
const report = { startedAt: new Date().toISOString(), mode: process.argv.includes("--verify-restart") ? "verify-restart" : "main", steps: [], modelCalls: { claude: 0, codexTurn: 0 }, budget: MODEL_BUDGET, checks: [], snapshot: null };
let snapshotFinal = null; // main 末尾状态，供 restart 对比

function step(name, fn) {
  report.steps.push({ step: name, at: new Date().toISOString() });
  console.log(`\n=== ${name} ===`);
  return fn();
}
function check(name, pass, detail) {
  report.checks.push({ name, pass: !!pass, detail: String(detail).slice(0, 500) });
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name} — ${String(detail).slice(0, 200)}`);
  return !!pass;
}
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 从 hook 文件提取本会话新增的 verified skill 事件（sinceLine 避免读到旧运行残留）
function newHookEvents(sinceLine) {
  return readHookSkillEvents({ sinceLine });
}

// 跑一次真实 Claude 调用并返回新增 hook 事件；skill 未被调用时返回空（由调用方重试）
async function claudeOnce(label) {
  report.modelCalls.claude++;
  if (report.modelCalls.claude + report.modelCalls.codexTurn > MODEL_BUDGET) throw new Error("真实模型调用超出预算上限，中止");
  const since = hookFileLineCount();
  const out = await runClaudePrompt({ prompt: label });
  return { out, events: newHookEvents(since) };
}

// ---------- main 模式 ----------
async function main() {
  // 干净起点：清 hook 捕获与旧 DB（可重复复现）
  if (existsSync(HOOK_FILE)) rmSync(HOOK_FILE);
  if (existsSync(DB)) rmSync(DB);
  const eng = new PoCEngine(DB);

  // ---- 场景 1：自由 Claude Session 调 design-feature（真实 stub skill + hook 捕获）→ 自动建卡 ----
  let s1Events = [];
  let s1Out = null;
  // prompt 附带显式执行指令：poc-2 发现 #2/#3 —— 模型是否调用 Skill 工具是模型决策且受本机用户级同名 skill 干扰；
  // 本 PoC 验证目标是「hook 捕获真调用 → tracker 正确处理」链路，等价于 GUI 中用户确定性触发场景
  const S1_PROMPT = "/design-feature\n\n请立即使用 Skill 工具执行 design-feature，不要运行任何其他工具，不要做任何调查。";
  await step("S1 真实 Claude：/design-feature stub → hook verified → 自动建卡", async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await claudeOnce(S1_PROMPT);
      s1Out = r.out;
      s1Events = r.events;
      if (s1Events.some((e) => e.skill === "design-feature")) break; // hook 捕获到 Skill 真调用即成功
      console.log(`  尝试 ${attempt}：模型未调用 Skill 工具（skillToolCalls=${r.out.skillToolCalls}），重试`);
      await sleep(500);
    }
    const ev = s1Events.find((e) => e.skill === "design-feature");
    check("Claude 真实会话建立（原生 session id）", !!s1Out.sessionId, `sessionId=${s1Out.sessionId} cli=${s1Out.cliVersion} cost=${s1Out.costUsd}`);
    check("hook 捕获到 Skill 真调用（PreToolUse）", !!ev, ev ? `${ev.source} eventId=${ev.eventId}` : `skillToolCalls=${s1Out?.skillToolCalls}`);
    if (!ev) {
      check("S1 致命失败：未捕获 Skill 真调用，后续场景无法进行", false, "fail-fast，详见 RESULT 降级说明");
      throw new Error("S1_FAIL_FAST");
    }
    const { changes } = eng.process(ev);
    const snap = eng.snapshot();
    check("自动创建 REQ-001 并关联该 Session，阶段 Design", snap.length === 1 && snap[0].id === "REQ-001" && snap[0].stage === "Design" && snap[0].sessions.includes(ev.sessionId) && changes[0]?.type === "requirement_created",
      `REQ-001 stage=${snap[0]?.stage} sessions=${JSON.stringify(snap[0]?.sessions)} uncertain=${snap[0]?.uncertain}`);
    // 重复注入同一 eventId → 不重复建卡
    const ch2 = eng.process(ev);
    check("重复注入同一 hook 事件不重复建卡", ch2.changes.length === 0 && eng.snapshot().length === 1, `changes=${ch2.changes.length}`);
  });
  const claudeSessionA = s1Events.find((e) => e.skill === "design-feature")?.sessionId ?? "(未捕获)";

  // ---- 场景 2：从 REQ-001 创建 Codex Session（真实 thread/start）→ self_reported implement-spec ----
  await step("S2 真实 Codex：thread/start 自动关联 → 真实 turn + self_reported /implement-spec", async () => {
    const client = new CodexAppServerClient({ log: () => {} });
    client.start();
    const init = await client.initialize();
    check("Codex app-server initialize", !!init, JSON.stringify(init).slice(0, 120));
    const MODEL = "gpt-5.6-luna"; // poc-1 结论：本账号实际可用模型
    const ts = await client.threadStart({ cwd: WORKDIR, model: MODEL });
    const threadId = ts.thread?.id;
    check("从 REQ-001 创建 Codex 原生 Session（thread/start）", !!threadId, `threadId=${threadId} cwd=${ts.thread?.cwd}`);

    // GUI 从卡片创建 → 自动关联（GUI 自身动作，evidenceLevel=verified）
    const linkEv = guiEvent("link", { sessionId: threadId, cli: "codex", requirementId: "REQ-001", source: "gui-card" });
    const linkRes = eng.process(linkEv);
    check("Codex Session 自动关联 REQ-001", eng.snapshot()[0].sessions.includes(threadId) && linkRes.changes.some((c) => c.type === "session_linked"), `changes=${JSON.stringify(linkRes.changes.map((c) => c.type))}`);

    // 用户「手动调用 implement-spec」的 GUI 可观察信号：提交 /implement-spec 且 turn 真实开始/完成（Codex 无 per-turn hook，§8.5）
    report.modelCalls.codexTurn++;
    const turnStartedAt = { local: null };
    client.on("turn/started", (p) => { if (p.threadId === threadId) turnStartedAt.local = now(); });
    const r = await client.runTurn(threadId, "/implement-spec（链路验证：请只回复一句话 IMPLEMENT-TURN-OK，不要执行任何工具）");
    client.stop();
    const turn = r.turn;
    const texts = [...r.collected.agentItems.values()].map((i) => i.text).join(" ");
    check("真实 turn 开始并完成（Session 可用）", turn?.status === "completed", `turnId=${turn?.id} status=${turn?.status} 答复="${texts.trim().slice(0, 60)}"`);

    // 构造 self_reported 事件：occurredAt 用 turn 实际开始时间（协议字段为 epoch 秒，需转 ISO；兜底本地观察时间），seq=turnId
    const toIso = (v) => {
      if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString(); // 秒/毫秒自适应
      return v;
    };
    const occurredAt = toIso(turn?.startedAt ?? turnStartedAt.local ?? now());
    const selfEv = {
      eventId: `codex-turn:${threadId}:implement-spec:${turn?.id}`,
      kind: "skill", sessionId: threadId, cli: "codex", skill: "implement-spec", stage: null, requirementId: null,
      occurredAt, receivedAt: now(), seq: turn?.id ?? null,
      evidenceLevel: "self_reported", source: "codex-appserver:turn(user submitted /implement-spec)",
    };
    const { changes } = eng.process(selfEv);
    const snap = eng.snapshot()[0];
    check("self_reported implement-spec 驱动阶段到 Implement 且标 uncertain", snap.stage === "Implement" && snap.uncertain === true, `stage=${snap.stage} uncertain=${snap.uncertain} basis=${JSON.stringify(snap.stageBasis)}`);
    // 用户在 GUI 确认 → uncertain 转正
    eng.process(guiEvent("manual", { requirementId: "REQ-001", stage: "Implement", source: "gui-confirm" }));
    check("用户确认后 uncertain 转正（manual 立即生效）", eng.snapshot()[0].uncertain === false, `stage=${eng.snapshot()[0].stage} uncertain=${eng.snapshot()[0].uncertain}`);
  });

  // ---- 场景 3：OpenCode Session 先执行阶段 Skill 后手动关联（凭据阻塞 → 合成事件，标注 simulated） ----
  await step("S3 合成 OpenCode：先执行 pr（simulated）后手动关联 → 按实际发生时间同步", async () => {
    const ocSession = "ses_opencode_sim_0001";
    const prAt = now();
    const prEv = synthSkillEvent({ sessionId: ocSession, cli: "opencode", skill: "pr", occurredAt: prAt, note: "opencode-credentials-expired(poc3)" });
    const r1 = eng.process(prEv);
    check("OpenCode 先执行 Skill（未关联）→ 只记活动不建卡不改阶段", r1.changes.length === 0 && eng.snapshot().length === 1, `changes=${r1.changes.length} cards=${eng.snapshot().length}`);
    await sleep(5);
    const linkEv = guiEvent("link", { sessionId: ocSession, cli: "opencode", requirementId: "REQ-001", source: "gui-manual-link" });
    const { changes } = eng.process(linkEv);
    const snap = eng.snapshot()[0];
    check("手动关联后按 Skill 实际发生时间同步阶段到 PR", snap.stage === "PR" && snap.sessions.includes(ocSession), `stage=${snap.stage} basis.at=${snap.stageBasis?.at}（link 时间更晚但不冒充依据） uncertain=${snap.uncertain}`);
    check("simulated 依据 → 阶段标 uncertain", snap.uncertain === true, `uncertain=${snap.uncertain}`);
  });

  // ---- 场景 4：手动修正 → 新有效事件覆盖；重复/延迟旧事件不覆盖；多 Session 最新有效胜出 ----
  await step("S4 混合流：手动修正 / 真实覆盖 / 重放 / 延迟旧事件 / 乱序并发回退", async () => {
    // 4.1 用户手动修正 → Retro
    eng.process(guiEvent("manual", { requirementId: "REQ-001", stage: "Retro", source: "gui-manual" }));
    check("手动修正立即生效 → Retro", eng.snapshot()[0].stage === "Retro", `stage=${eng.snapshot()[0].stage}`);

    // 4.2 新的真实 Claude Session D：关联后真实调用 implement-spec stub → verified 事件覆盖手动修正（多 Session 最新有效事件胜出）
    let dEvents = [];
    let dOut = null;
    const S4_PROMPT = "/implement-spec\n\n请立即使用 Skill 工具执行 implement-spec，不要运行任何其他工具，不要做任何调查。";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await claudeOnce(S4_PROMPT);
      dOut = r.out;
      dEvents = r.events;
      if (dEvents.some((e) => e.skill === "implement-spec")) break;
      console.log(`  尝试 ${attempt}：模型未调用 Skill 工具（skillToolCalls=${r.out.skillToolCalls}），重试`);
      await sleep(500);
    }
    const dEv = dEvents.find((e) => e.skill === "implement-spec");
    const claudeSessionD = dEv?.sessionId ?? dOut?.sessionId ?? null;
    if (claudeSessionD) {
      eng.process(guiEvent("link", { sessionId: claudeSessionD, cli: "claude-code", requirementId: "REQ-001", source: "gui-manual-link" }));
      check("真实 Claude Session D 关联 REQ-001", eng.snapshot()[0].sessions.includes(claudeSessionD), `sessionD=${claudeSessionD}`);
    } else {
      check("真实 Claude Session D 关联 REQ-001", false, "会话未建立，本轮 4.2-4.4 降级跳过");
    }
    if (dEv) {
      eng.process(dEv);
      const snap = eng.snapshot()[0];
      check("新 verified 事件覆盖手动修正 → Implement（uncertain=false）", snap.stage === "Implement" && snap.uncertain === false, `stage=${snap.stage} uncertain=${snap.uncertain} basis=${snap.stageBasis?.skill}@${snap.stageBasis?.at}`);
    } else {
      check("新 verified 事件覆盖手动修正 → Implement", false, "模型未调用 Skill 工具（hook 无事件），真实覆盖分支本轮未达成，见 RESULT 降级说明");
    }

    // 4.3 重放攻击注入：S1 的 hook 事件原文再入 → 幂等
    const before = JSON.stringify(eng.snapshot());
    const s1ev = s1Events.find((e) => e.skill === "design-feature");
    const replayRes = s1ev ? eng.process(s1ev) : { changes: [] };
    check("重放注入（同 eventId 原文）不改变任何状态", replayRes.changes.length === 0 && JSON.stringify(eng.snapshot()) === before, "duplicate_ignored");

    // 4.4 延迟旧事件：occurredAt 早于当前依据的新事件 → 不覆盖（复用 4.3 的 s1ev 真实事件时间）
    if (dEv && s1ev) {
      const staleEv = synthSkillEvent({ sessionId: claudeSessionA, cli: "claude-code", skill: "pr", occurredAt: s1ev.occurredAt, note: "delayed-old-event" });
      const r = eng.process(staleEv);
      check("延迟旧事件（occurredAt 早于依据）不覆盖", r.changes.length === 0 && eng.snapshot()[0].stage === "Implement", `stage=${eng.snapshot()[0].stage} changes=${r.changes.length}`);
    } else {
      check("延迟旧事件（occurredAt 早于依据）不覆盖", false, "前置真实事件缺失，降级跳过");
    }

    // 4.5 乱序并发 + PR→Implement 回退（simulated 混合注入，时间递增）
    await sleep(5);
    eng.process(synthSkillEvent({ sessionId: "ses_opencode_sim_0001", cli: "opencode", skill: "pr", occurredAt: now(), note: "concurrent-newest-1" }));
    const prStage = eng.snapshot()[0].stage;
    await sleep(5);
    eng.process(synthSkillEvent({ sessionId: claudeSessionA, cli: "claude-code", skill: "implement-spec", occurredAt: now(), note: "concurrent-newest-2-regress" }));
    const finalStage = eng.snapshot()[0].stage;
    check("多 Session 并发最新有效事件胜出，且允许 PR→Implement 回退", prStage === "PR" && finalStage === "Implement", `t6=PR → t7=${finalStage}`);
  });

  // ---- 场景 5（前半）：解除关联不删历史、不回退 ----
  await step("S5a 解除关联：阶段保持、历史仍在", async () => {
    const snapBefore = eng.snapshot()[0];
    const unlinkEv = guiEvent("unlink", { sessionId: snapBefore.sessions[0], source: "gui-unlink" });
    const { changes } = eng.process(unlinkEv);
    const snapAfter = eng.snapshot()[0];
    check("解除关联不回退阶段", snapAfter.stage === snapBefore.stage, `stage=${snapAfter.stage}`);
    check("解除关联后 session 从卡片移除", !snapAfter.sessions.includes(unlinkEv.sessionId), `sessions=${JSON.stringify(snapAfter.sessions)}`);
    const hist = eng.store.listEvents({ sessionId: unlinkEv.sessionId });
    check("解除关联不删历史（stage_events 仍可查）", hist.length >= 1, `该 session 历史事件数=${hist.length}`);
    snapshotFinal = eng.snapshot();
    report.snapshot = snapshotFinal;
    report.tables = eng.store.snapshotTables();
    eng.close(); // 模拟「正常退出应用」：进程结束，状态全部在 SQLite
  });

  // main 末尾状态落盘，供 --verify-restart 对比
  writeFileSync(join(RUNS, "e2e-final-state.json"), JSON.stringify({ snapshot: snapshotFinal, tables: report.tables }, null, 2), "utf8");
}

// ---------- verify-restart 模式：新进程，读同一 DB 恢复 ----------
async function verifyRestart() {
  const { snapshot: expected, tables: expectedTables } = JSON.parse((await import("node:fs")).readFileSync(join(RUNS, "e2e-final-state.json"), "utf8"));
  const eng = new PoCEngine(DB);
  eng.restore(); // 退出重开：仅凭 SQLite 恢复全部状态
  const snap = eng.snapshot();

  check("重启后卡片数量与编号一致", snap.length === expected.length && snap.every((r, i) => r.id === expected[i].id), JSON.stringify(snap.map((r) => r.id)));
  check("重启后阶段与 uncertain 一致", snap.every((r, i) => r.stage === expected[i].stage && r.uncertain === expected[i].uncertain), JSON.stringify(snap.map((r) => `${r.stage}${r.uncertain ? "?" : ""}`)));
  check("重启后 Session 关联一致", snap.every((r, i) => JSON.stringify(r.sessions) === JSON.stringify(expected[i].sessions)), JSON.stringify(snap.map((r) => r.sessions)));

  // 重放注入：把 main 阶段已处理过的真实 hook 事件原文再入一遍（模拟攻击者/重连重放）
  const histEvents = eng.store.listEvents();
  const realHookEv = histEvents.find((e) => e.evidenceLevel === "verified" && e.kind === "skill" && e.cli === "claude-code");
  const before = JSON.stringify(eng.snapshot());
  const replayRes = eng.process(realHookEv);
  check("重启后重放真实 hook 事件（同 eventId）→ 幂等不变化", replayRes.changes.length === 0 && JSON.stringify(eng.snapshot()) === before, `eventId=${realHookEv?.eventId} → duplicate_ignored`);

  // 历史完整性：stage_events 行数不因重启丢失
  const tables = eng.store.snapshotTables();
  check("重启后历史事件完整（stage_events 行数一致）", tables.stageEventCount === expectedTables.stageEventCount, `events=${tables.stageEventCount}`);
  check("证据等级分布可查（verified/self_reported/simulated 均在库）", tables.eventsByEvidence.length === 3, JSON.stringify(tables.eventsByEvidence));

  // 恢复后 tracker 仍可继续工作（新事件正常驱动）
  const t = now();
  eng.process(synthSkillEvent({ sessionId: "ses_opencode_sim_0001", cli: "opencode", skill: "retro", occurredAt: t, note: "post-restart" }));
  check("重启后新事件仍正常驱动阶段", eng.snapshot()[0].stage === "Retro", `stage=${eng.snapshot()[0].stage}`);
  eng.close();
}

(async () => {
  if (report.mode === "verify-restart") await verifyRestart();
  else await main();
  const failed = report.checks.filter((c) => !c.pass);
  console.log(`\n==== 汇总：${report.checks.length - failed.length}/${report.checks.length} checks 通过 ====`);
  for (const f of failed) console.log(`  FAIL: ${f.name} — ${f.detail}`);
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(RUNS, report.mode === "verify-restart" ? "e2e-restart.json" : "e2e-main.json"), JSON.stringify(report, null, 2), "utf8");
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  report.fatal = String(e?.stack ?? e);
  writeFileSync(join(RUNS, report.mode === "verify-restart" ? "e2e-restart.json" : "e2e-main.json"), JSON.stringify(report, null, 2), "utf8");
  console.error("E2E FATAL:", e);
  process.exit(1);
});
