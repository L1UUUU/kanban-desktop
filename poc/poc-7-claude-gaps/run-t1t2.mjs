// 用途：T1（持久多轮：单进程连发多轮、同 session id、上下文保持）+ T2（interrupt 控制请求取消当前 Turn，输出停止且同会话可继续）实测脚本
import { writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveClaudeExe, prepareCleanHome, FIXTURE_PROJ, LOGS } from "./lib/common.mjs";
import { ProtocolSession } from "./lib/client.mjs";

const exe = resolveClaudeExe();
const home = prepareCleanHome({ label: "t1t2" });

// T5 干净前提在所有测试通用：项目级与（重定向后的）用户级均无 hook 配置
const projectSettingsClean = !existsSync(join(FIXTURE_PROJ, ".claude", "settings.json"));
const homeNoHooks = !home.hasHooks;

const report = { exe, cliVersion: null, sessionId: null, turns: [], judgments: {}, timeline: [] };
const session = new ProtocolSession({
  exe, cwd: FIXTURE_PROJ,
  env: { CLAUDE_CONFIG_DIR: home.dir },
  rawLogPath: join(LOGS, "t1t2-raw-stream.jsonl"),
  turnTimeoutMs: 150000,
});

// —— 轮 1（T1）：埋暗号 ——
await session.start();
report.cliVersion = session.init?.claude_code_version ?? null;
report.sessionId = session.init?.session_id ?? null;
report.initModel = session.init?.model ?? null;
report.initPermissionMode = session.init?.permissionMode ?? null;
report.turns.push(await session.sendTurn("请牢牢记住这个暗号：紫鲸7号。不要调用任何工具，只回复四个字：已记住暗号"));

// —— 轮 2（T2）：长输出中 interrupt ——
const t2p = session.sendTurn("从1数到30，每个数字单独占一行，依次连续输出全部30个数字。不要调用任何工具，不要解释，直接开始输出。");
const t2 = session.currentTurn;
let interrupted = false, interruptInfo = null, stoppedCheck = null;
const t2Start = Date.now();
while (!t2.done && Date.now() - t2Start < 150000) {
  // 收到首批 delta 立即发 interrupt（只发一次）
  if (!interrupted && t2.deltas.length >= 1) {
    interrupted = true;
    interruptInfo = await session.interrupt();
  }
  // interrupt 确认后观察 3.5s：无新 delta 判「输出停止」
  if (interrupted && !stoppedCheck && Date.now() - new Date(session.interruptSentAt).getTime() >= 3500) {
    const deltasAfter = t2.deltas.filter((d) => new Date(d.ts).getTime() > new Date(session.interruptSentAt).getTime());
    stoppedCheck = { deltasAfterInterrupt: deltasAfter.length, totalDeltas: t2.deltas.length };
  }
  // interrupt 后 20s 仍无 result 则不再等待（记录 no_result 形态）
  if (interrupted && Date.now() - new Date(session.interruptSentAt).getTime() >= 20000) break;
  await new Promise((r) => setTimeout(r, 30));
}
// 等待 result 或额外 20s（interrupt 后 CLI 应发终止 result）
const t2Settled = await Promise.race([t2p, new Promise((r) => setTimeout(() => r(null), 20000))]);
const t2Record = t2Settled ?? { ...t2, endedBy: t2.endedBy ?? "no_result_after_interrupt", done: t2.done };
report.turns.push(t2Record);
report.t2 = {
  interruptSentAt: session.interruptSentAt,
  interruptAck: interruptInfo,
  stoppedCheck,
  partialText: t2.texts.join("").slice(0, 400),
  deltasTotal: t2.deltas.length,
  endedBy: t2Record.endedBy,
  result: t2Record.result,
};
report.t2.partialDeltas = t2.deltas.slice(0, 12).map((d) => d.text).join("");

// —— 轮 3（T1 收口 + T2 后续）：同会话续问暗号 ——
const t3 = await session.sendTurn("我们之前约定的暗号是什么？不要调用任何工具，只回复暗号本身。");
report.turns.push(t3);
session.kill();

// —— 判定 ——
const t1 = report.turns[0], t3r = report.turns[2];
const partialText = report.t2.partialText;
const numbersSeen = (partialText.match(/\b\d+\b/g) ?? []).length;
// 输出停止的最终口径：轮 settle 后统计 interrupt 时刻之后到达的 text delta（轮内提前 settle 时循环观察窗口可能未到，以 settle 后统计为准）
const deltasAfterInterrupt = t2.deltas.filter((d) => session.interruptSentAt && new Date(d.ts).getTime() > new Date(session.interruptSentAt).getTime());
const sessionIds = report.turns.map((t) => t.result?.sessionId).filter(Boolean);
report.judgments = {
  t1_single_process: true,
  t1_same_session_id: sessionIds.length === report.turns.length && sessionIds.every((s) => s === sessionIds[0]),
  t1_turn1_success: t1.endedBy === "result" && t1.result?.subtype === "success" && !t1.result?.is_error,
  t1_secret_recalled: (t3r.texts.join("") ?? "").includes("紫鲸7号"),
  t1_turn3_success: t3r.endedBy === "result" && t3r.result?.subtype === "success",
  t2_interrupt_acknowledged: !!interruptInfo?.acknowledged,
  t2_output_stopped_partial: deltasAfterInterrupt.length === 0 && numbersSeen < 30,
  t2_deltas_after_interrupt: deltasAfterInterrupt.length,
  t2_numbers_before_interrupt: numbersSeen,
  t2_turn_terminated: t2Record.endedBy === "result" || t2Record.endedBy === "no_result_after_interrupt",
  t2_interrupted_result_subtype: t2Record.result?.subtype ?? null,
  t2_session_continues_next_turn: (t3r.texts.join("") ?? "").includes("紫鲸7号") && t3r.result?.subtype === "success",
  precondition_project_settings_clean: projectSettingsClean,
  precondition_home_no_hooks: homeNoHooks,
};

writeFileSync(join(LOGS, "t1t2-result.json"), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report.judgments, null, 2));
console.log("T2 partial output:", JSON.stringify(partialText.slice(0, 200)));
console.log("T3 reply:", JSON.stringify((t3r.texts.join("") ?? "").slice(0, 120)));
