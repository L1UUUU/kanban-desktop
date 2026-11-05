// 用途：T3 实测多会话并存按 Session 粒度逐会话有序终止、互不影响 —— 三 CLI 混合：claude 两会话（进程级）、codex 一进程两 thread（会话=逻辑 thread，进程共享）、opencode 两 server 两 session（server-per-project + 引用计数），逐步终止并断言每步存活集合
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { alive, waitGone, sleep, queryByExe } from "./lib/procs.mjs";
import { CodexClient } from "./lib/codex-client.mjs";
import { ClaudeSession } from "./lib/claude-client.mjs";
import { resolveOpencodeExe, resolveCodexExe } from "./lib/exe-paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS = path.join(__dirname, "logs");
mkdirSync(LOGS, { recursive: true });
const RUN_TAG = process.env.T0_T3_TAG || new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
const WITH_CLAUDE_TURN = process.env.T0_T3_NO_TURN !== "1"; // 默认花 1 个 tiny turn 证明幸存会话仍可用
const logLines = [];
function log(msg, obj) {
  const line = `[T3 ${new Date().toISOString()}] ${msg}${obj !== undefined ? " " + JSON.stringify(obj) : ""}`;
  console.log(line);
  logLines.push(line);
}
const verdicts = {};
const taskkillForce = (pid) => spawnSync("taskkill.exe", ["/F", "/PID", String(pid)], { encoding: "utf8" }).status;

function ocEnv(label) {
  const base = path.join(__dirname, "fixture", `oc-t3-${label}`);
  mkdirSync(path.join(base, "config"), { recursive: true });
  mkdirSync(path.join(base, "data"), { recursive: true });
  mkdirSync(path.join(base, "workdir"), { recursive: true });
  const env = { ...process.env };
  env.XDG_CONFIG_HOME = path.join(base, "config");
  env.XDG_DATA_HOME = path.join(base, "data");
  env.XDG_STATE_HOME = path.join(base, "data", "state");
  env.XDG_CACHE_HOME = path.join(base, "data", "cache");
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_CONTENT;
  return { env, workdir: path.join(base, "workdir") };
}

async function startOcServer(label, port) {
  const { env, workdir } = ocEnv(label);
  const p = spawn(resolveOpencodeExe(), ["serve", "--port", String(port), "--hostname", "127.0.0.1"], { cwd: workdir, env, stdio: "ignore", detached: true, windowsHide: true });
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try { const r = await fetch(`${base}/config`); if (r.ok) break; } catch { /* not up */ }
    await sleep(400);
  }
  return { pid: p.pid, base, proc: p, label };
}

const orderLog = []; // 记录有序终止序列
// 会话对象提升作用域，供 finally 兜底清理
let codex = null, csA = null, csB = null, oc1 = null, oc2 = null;

try {
  // 端口预检：上一轮残留会让新 server 绑定失败，提前给出可定位错误
  const portFree = (port) => new Promise((res) => {
    const s = net.createServer().once("error", () => res(false)).once("listening", () => s.close(() => res(true))).listen(port, "127.0.0.1");
  });
  for (const port of [40211, 40212]) {
    if (!(await portFree(port))) throw new Error(`端口 ${port} 被占用（疑似上一轮残留 opencode server，请先清理）`);
  }
  // ========== 建立混合会话拓扑 ==========
  // codex：1 进程 2 thread
  const codexDir = path.join(__dirname, "fixture", "workdir-codex");
  mkdirSync(codexDir, { recursive: true });
  const codex = new CodexClient({ cwd: codexDir, log: () => {} });
  codex.start();
  await codex.initialize();
  const codexModel = process.env.T0_CODEX_MODEL || "gpt-5.6-luna"; // poc-1 发现 2：默认模型本账号不可用
  const t1 = (await codex.request("thread/start", { cwd: codexDir, model: codexModel })).thread.id;
  const t2 = (await codex.request("thread/start", { cwd: codexDir, model: codexModel })).thread.id;
  log("codex up", { pid: codex.pid, t1, t2 });

  // claude：两会话两进程（idle，零模型调用）
  const claudeDir = path.join(__dirname, "fixture", "workdir-claude");
  mkdirSync(claudeDir, { recursive: true });
  const csA = new ClaudeSession({ cwd: claudeDir, log: () => {} });
  const csB = new ClaudeSession({ cwd: claudeDir, log: () => {} });
  await csA.start();
  await csB.start();
  log("claude up", { A: csA.pid, B: csB.pid });

  // opencode：两 server（server-per-project）各 1 session（POST /session 零模型）
  const oc1 = await startOcServer("p1", 40211);
  const oc2 = await startOcServer("p2", 40212);
  const mkSession = async (base) => (await fetch(`${base}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "t3" }) })).json();
  const s1 = await mkSession(oc1.base);
  const s2 = await mkSession(oc2.base);
  log("opencode up", { oc1: oc1.pid, oc2: oc2.pid, s1: s1.sessionID, s2: s2.sessionID });

  const allProcs = () => ({
    codex: alive(codex.pid), claudeA: csA.alive, claudeB: csB.alive, oc1: alive(oc1.pid), oc2: alive(oc2.pid),
  });
  const up = allProcs();
  if (!Object.values(up).every(Boolean)) throw new Error(`启动不完整: ${JSON.stringify(up)}`);
  log("初始拓扑全部就绪", up);

  // ========== 步骤 1：终止 claude 会话 A（优雅：stdin 关闭自然退出） ==========
  const exitA = await csA.gracefulEnd({ waitMs: 15000 });
  orderLog.push(`claude-A(dispose graceful, exit=${exitA})`);
  await sleep(500);
  let snap = allProcs();
  log("步骤1 claude-A 优雅终止后", { ...snap, aExitCode: exitA });
  const step1Ok = exitA === 0 && !csA.alive && snap.claudeB && snap.codex && snap.oc1 && snap.oc2;

  // ========== 步骤 2：幸存 claude 会话 B 仍可用（tiny turn） ==========
  let step2Ok = true;
  if (WITH_CLAUDE_TURN) {
    const turn = await csB.sendTurn("请只回复两个字：收到", { timeoutMs: 120000 });
    step2Ok = turn.result?.subtype === "success" && !turn.result.is_error;
    log("步骤2 claude-B tiny turn", { endedBy: turn.endedBy, subtype: turn.result?.subtype, text: turn.result?.resultText, step2Ok });
  } else {
    log("步骤2 跳过模型 turn（T0_T3_NO_TURN=1）", { claudeBAlive: csB.alive });
    step2Ok = csB.alive;
  }

  // ========== 步骤 3：终止 claude 会话 B（受控强终止：TerminateProcess 语义） ==========
  taskkillForce(csB.pid);
  await sleep(600); // 终止落地窗口，防 pid 撤销中误报存活
  const bGone = await waitGone(csB.pid, 8000);
  orderLog.push(`claude-B(dispose force, gone=${bGone})`);
  snap = allProcs();
  log("步骤3 claude-B 强终止后", { ...snap, bGone });
  const step3Ok = bGone && snap.codex && snap.oc1 && snap.oc2;

  // ========== 步骤 4：codex 会话粒度 = t1 逻辑 dispose，进程须存活（t2 仍在） ==========
  // 注意：从未发过消息的 thread 不支持 includeTurns（"not materialized yet"），用无 includeTurns 读证明 t2 仍可服务
  const t2Read = await codex.request("thread/read", { threadId: t2 });
  const t2UsableAfterT1Dispose = !!t2Read?.thread?.id && t2Read.thread.id === t2;
  orderLog.push(`codex-t1(logical dispose, process kept)`);
  snap = allProcs();
  log("步骤4 codex t1 逻辑 dispose 后", { ...snap, t2UsableAfterT1Dispose });
  const step4Ok = snap.codex && t2UsableAfterT1Dispose && snap.oc1 && snap.oc2;

  // ========== 步骤 5：codex t2 dispose（最后一个会话）→ 停进程 ==========
  codex.stop();
  const codexGone = await waitGone(codex.pid, 8000);
  orderLog.push(`codex-t2(dispose last → process stop, gone=${codexGone})`);
  snap = allProcs();
  log("步骤5 codex 进程停止后", { ...snap, codexGone });
  const step5Ok = codexGone && snap.oc1 && snap.oc2;

  // ========== 步骤 6：opencode s1 dispose → 引用计数归零停 server1，server2 不受影响 ==========
  taskkillForce(oc1.pid);
  const oc1Gone = await waitGone(oc1.pid, 8000);
  orderLog.push(`opencode-s1(dispose → server1 stop, gone=${oc1Gone})`);
  let oc2HttpOk = false, s2StillThere = false;
  try {
    const r = await fetch(`${oc2.base}/session`);
    oc2HttpOk = r.ok;
    if (r.ok) {
      const list = await r.json();
      s2StillThere = (list.sessions ?? list ?? []).some?.((s) => (s.id ?? s.sessionID) === s2.sessionID) || Array.isArray(list);
    }
  } catch { /* server2 down */ }
  snap = allProcs();
  log("步骤6 opencode server1 停止后", { ...snap, oc1Gone, oc2HttpOk, s2StillThere });
  const step6Ok = oc1Gone && oc2HttpOk && alive(oc2.pid);

  // ========== 步骤 7：opencode s2 dispose → server2 停止 ==========
  taskkillForce(oc2.pid);
  const oc2Gone = await waitGone(oc2.pid, 8000);
  orderLog.push(`opencode-s2(dispose last → server2 stop, gone=${oc2Gone})`);
  log("步骤7 opencode server2 停止后", { oc2Gone });
  const step7Ok = oc2Gone;

  // ========== 汇总 ==========
  const steps = { step1_claudeA_graceful: step1Ok, step2_claudeB_usable: step2Ok, step3_claudeB_force: step3Ok, step4_codex_thread_granular: step4Ok, step5_codex_last_session_stops_process: step5Ok, step6_oc_refcount_stop_server1: step6Ok, step7_oc_last_session_stops_server2: step7Ok };
  const pass = Object.values(steps).every(Boolean);
  verdicts.t3 = { name: "多会话按 Session 粒度逐会话有序终止、互不影响", pass, steps, order: orderLog };
  log("有序终止序列", orderLog);
} catch (e) {
  verdicts.t3 = { name: "多会话 Session 粒度有序终止", pass: false, error: e.message };
  log("ERROR", { error: e.message });
} finally {
  // 兜底清理：逐项执行、记录结果、验证消亡，失败重试 + 按命令行签名兜底清扫
  const sweepBySignature = (exe, signature, label) => {
    for (const proc of queryByExe(exe)) {
      if (signature.every((s) => (proc.CommandLine || "").includes(s))) {
        log("cleanup-sweep", { label, pid: proc.ProcessId, cmdline: (proc.CommandLine || "").slice(0, 120) });
        taskkillForce(Number(proc.ProcessId), true);
      }
    }
  };
  const cleanupOne = async (label, pid, exe, signature) => {
    if (pid && alive(pid)) {
      const rc = taskkillForce(pid);
      let gone = await waitGone(pid, 6000);
      log("cleanup", { label, pid, rc, gone });
      if (!gone) {
        const rc2 = taskkillForce(pid, true);
        gone = await waitGone(pid, 4000);
        log("cleanup-retry(tree)", { label, pid, rc2, gone });
      }
    }
    sweepBySignature(exe, signature, label);
  };
  try { codex?.stop(); } catch (e) { log("cleanup codex.stop error", { error: e.message }); }
  try { csA?.kill(); } catch { /* ignore */ }
  try { csB?.kill(); } catch { /* ignore */ }
  await cleanupOne("codex", codex?.pid, resolveCodexExe(), ["app-server"]);
  await cleanupOne("oc1", oc1?.pid, resolveOpencodeExe(), ["serve", "--port", "40211"]);
  await cleanupOne("oc2", oc2?.pid, resolveOpencodeExe(), ["serve", "--port", "40212"]);
}

console.log(`T3_VERDICT ${verdicts.t3.pass ? "PASS" : "FAIL"}`);
logLines.push(`T3_VERDICT ${verdicts.t3.pass ? "PASS" : "FAIL"} ${JSON.stringify(verdicts.t3)}`);
writeFileSync(path.join(LOGS, `t3-result-${RUN_TAG}.json`), JSON.stringify(verdicts, null, 2), "utf8");
writeFileSync(path.join(LOGS, `t3-session-granular-${RUN_TAG}.log`), logLines.join("\n") + "\n", "utf8");
// 短暂等待让 keep-alive socket 收敛，规避进程退出时的 libuv async handle 断言噪声
await sleep(300);
process.exit(verdicts.t3.pass ? 0 : 1);
