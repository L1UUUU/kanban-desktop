// 用途：T4 跨重启 resume 实测 —— 进程 A 正常退出后，进程 B 以 --resume <session-id> 续问，验证埋入暗号跨进程复现（Claude 多轮此前仅在单进程内实证）
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveClaudeExe, prepareCleanHome, FIXTURE_PROJ, LOGS } from "./lib/common.mjs";
import { ProtocolSession } from "./lib/client.mjs";

const exe = resolveClaudeExe();
const home = prepareCleanHome({ label: "t4" });
const report = { exe, phaseA: {}, phaseB: {}, judgments: {} };

// —— 进程 A：埋暗号，正常退出 ——
const a = new ProtocolSession({
  exe, cwd: FIXTURE_PROJ,
  env: { CLAUDE_CONFIG_DIR: home.dir },
  rawLogPath: join(LOGS, "t4a-raw-stream.jsonl"),
  turnTimeoutMs: 150000,
});
await a.start();
const aInitDebug = { initNull: !a.init, initSessionId: a.init?.session_id ?? null }; // 诊断 init 竞态（不参与判定）
const turnA = await a.sendTurn("请牢牢记住这个暗号：琥珀象9号。不要调用任何工具，只回复四个字：已记住暗号");
const exitCodeA = await a.gracefulEnd(); // 关 stdin 等 CLI 自然退出
report.phaseA = { sessionId: turnA.result?.sessionId ?? null, reply: turnA.texts.join("").slice(0, 100), resultSubtype: turnA.result?.subtype ?? null, exitCode: exitCodeA, costUsd: turnA.result?.costUsd ?? null, initDebug: aInitDebug };

// —— 进程 B：新进程 --resume 续问 ——
const sessionId = report.phaseA.sessionId;
if (!sessionId) throw new Error("phase A produced no session id; aborting before spawning B");
const b = new ProtocolSession({
  exe, cwd: FIXTURE_PROJ,
  args: ["--resume", sessionId],
  env: { CLAUDE_CONFIG_DIR: home.dir },
  rawLogPath: join(LOGS, "t4b-raw-stream.jsonl"),
  turnTimeoutMs: 150000,
});
await b.start();
const turnB = await b.sendTurn("我们之前约定的暗号是什么？不要调用任何工具，只回复暗号本身。");
const exitCodeB = await b.gracefulEnd();
report.phaseB = {
  resumeArg: sessionId,
  initSessionId: b.init?.session_id ?? null,
  initSessionIds: b.init?.session_ids ?? undefined,
  resultSessionId: turnB.result?.sessionId ?? null,
  reply: turnB.texts.join("").slice(0, 200),
  resultSubtype: turnB.result?.subtype ?? null,
  exitCode: exitCodeB,
  costUsd: turnB.result?.costUsd ?? null,
  cliVersionB: b.init?.claude_code_version ?? null,
};

// —— 判定 ——
report.judgments = {
  t4_phaseA_normal_exit: exitCodeA === 0,
  t4_phaseA_success: turnA.result?.subtype === "success",
  t4_phaseB_new_process: true,
  t4_resumed_same_session_id: report.phaseB.resultSessionId === sessionId,
  t4_secret_recalled: (report.phaseB.reply ?? "").includes("琥珀象9号"),
  t4_phaseB_success: turnB.result?.subtype === "success" && !turnB.result?.is_error,
};

writeFileSync(join(LOGS, "t4-result.json"), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report.judgments, null, 2));
console.log("A reply:", JSON.stringify(report.phaseA.reply), "| B reply:", JSON.stringify(report.phaseB.reply));
