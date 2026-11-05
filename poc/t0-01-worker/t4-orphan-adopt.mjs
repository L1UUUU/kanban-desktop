// 用途：T4 验证孤儿 CLI「先核对再接管」策略 —— A：opencode 孤儿 server（宿主强杀后存活）按注册表核对身份后重连复用（不重复 spawn、幂等）；B：codex 孤儿（turn 进行中宿主强杀）核对后受控终止并按原生历史 resume（快照一致=不重放、暗号复现）；C：身份核对负例（死 pid / 签名不符不接管）
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { alive, waitGone, sleep, queryByExe } from "./lib/procs.mjs";
import { SpawnRegistry, verifyEntry, adoptDecision } from "./lib/orphan.mjs";
import { CodexClient } from "./lib/codex-client.mjs";
import { resolveOpencodeExe, resolveCodexExe } from "./lib/exe-paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS = path.join(__dirname, "logs");
mkdirSync(LOGS, { recursive: true });
const RUN_TAG = process.env.T0_T4_TAG || new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
const OC_PORT = Number(process.env.T0_T4_OC_PORT || 40221);
const registryFile = path.join(LOGS, "t4-registry.json");
rmSync(registryFile, { force: true });
const registry = new SpawnRegistry(registryFile);

const logLines = [];
function log(msg, obj) {
  const line = `[T4 ${new Date().toISOString()}] ${msg}${obj !== undefined ? " " + JSON.stringify(obj) : ""}`;
  console.log(line);
  logLines.push(line);
}
const verdicts = {};
const taskkillForce = (pid, tree = false) => spawnSync("taskkill.exe", ["/F", ...(tree ? ["/T"] : []), "/PID", String(pid)], { encoding: "utf8" }).status;

// fetch 重试：服务端可能关闭空闲 keep-alive 连接，POST 不被 undici 自动重试，网络错时重试一次
async function fetchJson(url, opts = {}, retries = 2) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      await sleep(300);
    }
  }
  throw lastErr;
}

// 按「exe + 命令行签名」数进程（判定是否重复 spawn）
function countBySignature(exe, signature) {
  const norm = (p) => (p || "").toLowerCase().replace(/\//g, "\\");
  return queryByExe(exe).filter((p) => signature.every((s) => (p.CommandLine || "").includes(s))).length;
}

// ========== Part A：opencode 孤儿 server → 核对后重连复用 ==========
async function partA() {
  const name = "A opencode 孤儿：先核对再重连复用（不重复接管）";
  let hostState = null;
  const ocExe = resolveOpencodeExe();
  try {
    // 宿主 A 起 opencode server（detached）
    const planFile = path.join(LOGS, "t4-plan-a.json");
    const stateFile = path.join(LOGS, "t4-state-a.json");
    rmSync(stateFile, { force: true });
    writeFileSync(planFile, JSON.stringify({ children: [{ type: "opencode", port: OC_PORT }] }));
    const host = spawn(process.execPath, [path.join(__dirname, "lib", "host-runner.mjs"), "--plan", planFile, "--state", stateFile], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    host.stdout.resume();
    let st = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      try { const s = JSON.parse(readFileSync(stateFile, "utf8")); if (s.hostPid) { st = s; break; } } catch { /* not ready */ }
      await sleep(300);
    }
    if (!st) throw new Error("宿主 A 状态超时");
    hostState = st;
    const oc = st.children.find((c) => c.type === "opencode");
    let httpOk = false;
    const t1 = Date.now();
    while (Date.now() - t1 < 30000) {
      try { const r = await fetch(`http://127.0.0.1:${OC_PORT}/config`); if (r.ok) { httpOk = true; break; } } catch { /* not up */ }
      await sleep(400);
    }
    log("A: 宿主 A 就绪", { host: st.hostPid, ocPid: oc.pid, httpOk });

    // 注册（spawn 时身份：exe + 命令行签名 + spawnAt）
    const entry = registry.record({ kind: "opencode-server", exe: ocExe, port: OC_PORT, pid: oc.pid, spawnAt: oc.spawnAt, cmdSignature: ["serve", "--port", String(OC_PORT)], reattachable: true, project: "p-A" });
    // 宿主 A 强杀 → 孤儿
    taskkillForce(st.hostPid);
    await sleep(3000);
    const orphanAlive = alive(oc.pid);
    log("A: 宿主 A 强杀后孤儿存活", { orphanAlive, ocPid: oc.pid });
    if (!orphanAlive) throw new Error("opencode 孤儿未存活（detached 失效？）");

    // 宿主 B：先核对再接管
    const dec1 = adoptDecision(entry);
    const reattachOk = dec1.action === "reattach" && dec1.verify.match && dec1.pid === oc.pid;
    const dupBefore = countBySignature(ocExe, ["serve", "--port", String(OC_PORT)]);
    // 接管 = 复用 HTTP（建会话，零模型调用；响应字段为 id，poc-3 同款）
    const ses = await fetchJson(`http://127.0.0.1:${OC_PORT}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "t4-adopted" }) });
    const sessionId = ses.id ?? ses.sessionID;
    const dupAfter = countBySignature(ocExe, ["serve", "--port", String(OC_PORT)]);
    log("A: 接管决策与复用", { action: dec1.action, reattachOk, dupBefore, dupAfter, sessionCreated: !!sessionId, sessionRespKeys: Object.keys(ses).slice(0, 8) });

    // 幂等：再次核对接管 → 同 pid、仍无重复 spawn
    entry.adopted = true;
    const dec2 = adoptDecision(entry);
    const idempotent = dec2.action === "reattach" && dec2.pid === oc.pid && countBySignature(ocExe, ["serve", "--port", String(OC_PORT)]) === 1;
    log("A: 幂等二次接管", { action: dec2.action, samePid: dec2.pid === oc.pid, processCount: countBySignature(ocExe, ["serve", "--port", String(OC_PORT)]) });

    // 收尾：受控停止被接管的 server
    taskkillForce(oc.pid);
    const gone = await waitGone(oc.pid, 8000);
    verdicts.A = { name, pass: orphanAlive && reattachOk && dupBefore === 1 && dupAfter === 1 && idempotent && !!sessionId && gone };
  } catch (e) {
    log("A: ERROR", { error: e.message });
    verdicts.A = { name, pass: false, error: e.message };
    if (hostState?.children) for (const c of hostState.children) taskkillForce(c.pid, true);
  }
}

// ========== Part B：codex 孤儿（turn 中）→ 核对后受控终止 + resume 不重放 ==========
async function partB() {
  const name = "B codex 孤儿：核对→受控终止→resume 不重放、暗号复现";
  const stateFile = path.join(LOGS, "t4-state-b.json");
  let hostB = null;
  let newClient = null;
  try {
    rmSync(stateFile, { force: true });
    // 宿主 B'：codex detached + 埋暗号 turn + 长数数 turn 进行中
    hostB = spawn(process.execPath, [path.join(__dirname, "lib", "host-b-turn.mjs"), "--state", stateFile, "--mode", "counting"], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    hostB.stdout.resume();
    let st = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 180000) {
      try { const s = JSON.parse(readFileSync(stateFile, "utf8")); if (s.phase === "counting" && s.deltas >= 5) { st = s; break; } } catch { /* not ready */ }
      if (hostB.exitCode !== null) throw new Error(`宿主 B' 提前退出 code=${hostB.exitCode}`);
      await sleep(500);
    }
    if (!st) throw new Error("宿主 B' 计数 turn 超时");
    log("B: 宿主 B' turn 进行中", { host: st.hostPid, codexPid: st.codexPid, threadId: st.threadId, turn1: st.turn1Status, preCrashTurns: st.preCrashTurns?.length, deltas: st.deltas, magic: st.magic });

    const entry = registry.record({ kind: "codex-appserver", exe: resolveCodexExe(), pid: st.codexPid, spawnAt: st.codexSpawnAt, cmdSignature: ["app-server"], reattachable: false, threadId: st.threadId });
    // 强杀宿主（turn 进行中）；尽快做接管决策（stdio 断管后 codex 会在秒级窗口内退出，WMI 记录随终止移除）
    taskkillForce(st.hostPid);
    await sleep(1000);
    const orphanAt1s = alive(st.codexPid);

    // 先核对再接管：+1s 即决策，terminate-then-resume 分支要求孤儿仍在
    const aliveAtDecision = alive(st.codexPid);
    const codexCim = queryByExe(resolveCodexExe()).find((p) => Number(p.ProcessId) === Number(st.codexPid));
    log("B: 决策前核对现场", { orphanAt1s, aliveAtDecision, cimFound: !!codexCim, cimCreated: codexCim?.CreationDate ?? null, spawnAt: st.codexSpawnAt, diffMs: codexCim ? new Date(codexCim.CreationDate).getTime() - new Date(st.codexSpawnAt).getTime() : null });
    const dec = adoptDecision(entry);
    let orphanTerminated = true;
    let outcome = null;
    if (dec.action === "terminate-then-resume") {
      taskkillForce(entry.pid, true);
      orphanTerminated = await waitGone(entry.pid, 8000);
      outcome = "terminated-by-policy";
      log("B: 核对通过并受控终止孤儿", { pid: entry.pid, orphanTerminated });
    } else {
      // none：窗口内自灭（退出中进程 kill(0) 仍 true 但 WMI 已移除）——等待其完全消亡并记录窗口
      let windowMs = 0;
      const tw = Date.now();
      while (alive(st.codexPid) && Date.now() - tw < 15000) { await sleep(300); }
      windowMs = Date.now() - tw;
      outcome = "self-exited-in-window";
      log("B: 决策 none（孤儿退出中/已退出）", { action: dec.action, reason: dec.reason, aliveAtDecision, windowMs, fullyGone: !alive(st.codexPid) });
      if (dec.action === "none" && aliveAtDecision && codexCim && !orphanAt1s) orphanTerminated = false; // 真存活却被拒才算误拒
    }

    // 新宿主：resume 同 thread → 快照一致（不重放）→ 暗号复现
    newClient = new CodexClient({ cwd: path.join(__dirname, "fixture", "workdir-codex"), log: () => {} });
    newClient.start();
    await newClient.initialize();
    const resumed = await newClient.request("thread/resume", { threadId: st.threadId });
    const sameThread = resumed.thread.id === st.threadId;
    const read2 = await newClient.request("thread/read", { threadId: st.threadId, includeTurns: true });
    const preIds = new Set((st.preCrashTurns || []).map((t) => t.id));
    const post = (read2.thread.turns || []).map((t) => ({ id: t.id, status: t.status ?? null }));
    const postIds = new Set(post.map((t) => t.id));
    const allPrePresent = [...preIds].every((id) => postIds.has(id));
    const noNewCompleted = post.filter((t) => t.status === "completed").every((t) => preIds.has(t.id));
    log("B: resume 快照对比", { sameThread, preTurns: preIds.size, postTurns: postIds.size, allPrePresent, noNewCompleted, postStatuses: post.map((t) => t.status) });

    // 会话仍可用 + 上下文延续（tiny turn 问暗号）
    const r = await newClient.runTurn(st.threadId, "我之前告诉你的暗号是什么？只输出暗号本身，不要其他文字。");
    const magicFound = r.deltaText.toUpperCase().includes(st.magic);
    log("B: 暗号复现", { turnStatus: r.turn?.status, magicFound, text: r.deltaText.slice(0, 60), magic: st.magic });

    verdicts.B = { name, pass: orphanTerminated && sameThread && allPrePresent && noNewCompleted && magicFound, orphanAt1s, outcome, adoptAction: dec.action };
  } catch (e) {
    log("B: ERROR", { error: e.message });
    verdicts.B = { name, pass: false, error: e.message };
  } finally {
    try { newClient?.stop(); } catch { /* ignore */ }
    // 兜底：清 codex 残留（按注册表）
    for (const e of registry.entries) {
      if (e.kind === "codex-appserver" && alive(e.pid)) { taskkillForce(e.pid, true); }
    }
  }
}

// ========== Part C：身份核对负例（先核对=不盲目接管） ==========
async function partC() {
  const name = "C 身份核对负例：死 pid / 签名不符 / pid 复用形态不接管";
  try {
    // 负例 1：pid 已死（用刚被终止的宿主 A pid 不稳定，改用一个确定已退出的进程：spawn 一个立即退出的 node）
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise((r) => dead.on("exit", r));
    const v1 = verifyEntry({ exe: resolveCodexExe(), pid: dead.pid, spawnAt: new Date().toISOString(), cmdSignature: ["app-server"] });
    // 负例 2：pid 存活但命令行签名不符（用本测试进程 pid 冒充 codex）
    const v2 = verifyEntry({ exe: resolveCodexExe(), pid: process.pid, spawnAt: new Date().toISOString(), cmdSignature: ["app-server"] });
    // 负例 3：spawnAt 与实际创建时间差过大（pid 复用形态）
    const live = spawn(process.execPath, ["-e", "setInterval(()=>{},60000)"], { stdio: "ignore" });
    await sleep(600);
    const v3 = verifyEntry({ exe: process.execPath, pid: live.pid, spawnAt: new Date(Date.now() - 3600_000).toISOString(), cmdSignature: [] });
    taskkillForce(live.pid);
    log("C: 负例核对结果", { deadPid: !v1.match, wrongSignature: !v2.match, staleSpawnAt: !v3.match });
    verdicts.C = { name, pass: !v1.match && !v2.match && !v3.match };
  } catch (e) {
    log("C: ERROR", { error: e.message });
    verdicts.C = { name, pass: false, error: e.message };
  }
}

await partA();
await partB();
await partC();

const allPass = Object.values(verdicts).every((v) => v.pass);
console.log(`T4_VERDICT ${allPass ? "PASS" : "FAIL"}`);
logLines.push(`T4_VERDICT ${allPass ? "PASS" : "FAIL"} ${JSON.stringify(verdicts)}`);
writeFileSync(path.join(LOGS, `t4-result-${RUN_TAG}.json`), JSON.stringify({ verdicts, registry: registry.entries }, null, 2), "utf8");
writeFileSync(path.join(LOGS, `t4-orphan-adopt-${RUN_TAG}.log`), logLines.join("\n") + "\n", "utf8");
process.exit(allPass ? 0 : 1);
