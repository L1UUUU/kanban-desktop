// 用途：T2 实测「取消 Turn ≠ 杀 Session」—— 真实 codex app-server：长 turn 进行中发 turn/interrupt，断言 CLI 主进程存活、turn 终态 interrupted、同 thread 下一 turn 正常完成（Claude/OpenCode 侧引用 poc-7 T2 / poc-3 结论，本脚本做 codex 最小复证）
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexClient } from "./lib/codex-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS = path.join(__dirname, "logs");
mkdirSync(LOGS, { recursive: true });
const RUN_TAG = process.env.T0_T2_TAG || new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
const logFile = path.join(LOGS, `t2-cancel-turn-${RUN_TAG}.log`);
const logLines = [];
function log(msg, obj) {
  const line = `[T2 ${new Date().toISOString()}] ${msg}${obj !== undefined ? " " + JSON.stringify(obj) : ""}`;
  console.log(line);
  logLines.push(line);
}

const cwd = path.join(__dirname, "fixture", "workdir-codex");
mkdirSync(cwd, { recursive: true });

const c = new CodexClient({ cwd, log: (m, d) => logLines.push(`[codex ${new Date().toISOString()}] ${m} ${String(d).slice(0, 200)}`) });
const verdict = { name: "取消 Turn ≠ 杀 Session（codex app-server 实测）" };
try {
  c.start();
  await c.initialize();
  const pid = c.pid;
  log("app-server started", { pid });
  // poc-1 发现 2：账号默认模型 gpt-6.1-terra 报 400，须显式传实际可用模型
  const model = process.env.T0_CODEX_MODEL || "gpt-5.6-luna";
  const ts = await c.request("thread/start", { cwd, model });
  const threadId = ts.thread.id;
  log("thread started", { threadId, model });

  // —— 轮 1：数数长 turn，turn/started 拿 turnId、首批 delta 到达后 interrupt ——
  let interruptSent = false;
  let turnId = null;
  const offStarted = c.on("turn/started", (p) => { if (p.threadId === threadId && p.turn?.id) turnId = p.turn.id; });
  const r1 = await c.runTurn(threadId, "请从 1 慢慢数到 40，每个数字一行，不要解释。", {
    onDelta: () => {
      if (!interruptSent && turnId) {
        interruptSent = true;
        // 收到首个增量即请求中断（turn/interrupt 是协议消息，不是杀进程；wire 需要 turnId，poc-1 e 同款）
        c.request("turn/interrupt", { threadId, turnId }).then(
          (res) => log("turn/interrupt accepted", res),
          (e) => log("turn/interrupt rejected", { error: e.message }),
        );
      }
    },
  });
  offStarted();
  const deltasBeforeKill = r1.deltas;
  await new Promise((r) => setTimeout(r, 800)); // 中断生效窗口，观察结束后是否还有新 delta
  const procAliveAfterInterrupt = c.alive;
  log("turn1 finished", {
    turnStatus: r1.turn?.status,
    deltasBeforeKill,
    deltasAfterEnd: r1.deltasAfterEnd,
    procAliveAfterInterrupt,
  });
  // 断言 A：turn 终态为 interrupted（而非进程死亡/错误）
  const interruptClean = r1.turn?.status === "interrupted";
  // 断言 B：中断后 CLI 主进程仍存活（同 pid）
  const pidUnchanged = c.pid === pid && c.alive;

  // —— 轮 2：同 thread 继续（会话保留的最小证明）——
  const r2 = await c.runTurn(threadId, "请只回复两个字：收到");
  log("turn2 finished", { turnStatus: r2.turn?.status, text: r2.deltaText.slice(0, 50) });
  // 断言 C：同 thread 新 turn 正常完成
  const sessionReusable = r2.turn?.status === "completed" && r2.deltaText.length > 0;
  const procAliveAtEnd = c.alive;

  verdict.pass = interruptClean && pidUnchanged && sessionReusable && procAliveAtEnd;
  verdict.evidence = { interruptClean, turn1Status: r1.turn?.status, turn1ErrorEvent: r1.errorEvent ?? r1.turnStartError ?? null, pidUnchanged, sessionReusable, turn2Status: r2.turn?.status, turn2ErrorEvent: r2.errorEvent ?? r2.turnStartError ?? null, procAliveAtEnd, deltasBeforeKill, deltasAfterInterrupt: r1.deltasAfterEnd };
} catch (e) {
  verdict.pass = false;
  verdict.error = e.message;
  log("ERROR", { error: e.message });
} finally {
  c.stop();
}

console.log(`T2_VERDICT ${verdict.pass ? "PASS" : "FAIL"}`);
logLines.push(`T2_VERDICT ${verdict.pass ? "PASS" : "FAIL"} ${JSON.stringify(verdict)}`);
writeFileSync(logFile, logLines.join("\n") + "\n", "utf8");
writeFileSync(path.join(LOGS, `t2-result-${RUN_TAG}.json`), JSON.stringify(verdict, null, 2), "utf8");
process.exit(verdict.pass ? 0 : 1);
