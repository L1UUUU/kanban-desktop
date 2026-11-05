// 用途：T1 实测 Windows Job Object + KILL_ON_JOB_CLOSE —— 三场景对照：(control) 无 Job 宿主被 taskkill /F 后子/孙进程存活（复现孤儿问题）；(job) 有 Job 宿主被强杀后 OS 全灭；(graceful) Job 内单会话受控终止互不影响 + 宿主优雅退出后 Job 兜底全灭
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { alive, aliveMap, waitGone, sleep } from "./lib/procs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const LOGS = path.join(ROOT, "logs");
mkdirSync(LOGS, { recursive: true });
const RUN_TAG = process.env.T0_T1_TAG || new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
const OC_PORT = Number(process.env.T0_OC_PORT || 40201);
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;

const logLines = [];
function log(scope, msg) {
  const line = `[T1][${scope}] ${new Date().toISOString()} ${msg}`;
  console.log(line);
  logLines.push(line);
}
const verdicts = {};
const hostProcs = new Map(); // hostPid -> ChildProcess（graceful 场景需要写 stdin）

function taskkillForce(pid, tree = false) {
  const args = ["/F", ...(tree ? ["/T"] : []), "/PID", String(pid)];
  const r = spawnSync("taskkill.exe", args, { encoding: "utf8" });
  return r.status;
}

// —— 起一个宿主（三真实 CLI + 合成孙进程树），等待就绪 ——
async function startHost({ useJob, tag }) {
  const planFile = path.join(LOGS, `t1-plan-${tag}.json`);
  const stateFile = path.join(LOGS, `t1-state-${tag}.json`);
  rmSync(stateFile, { force: true });
  writeFileSync(planFile, JSON.stringify({ children: [
    { type: "codex" },
    { type: "claude" },
    { type: "opencode", port: OC_PORT },
    { type: "tree" },
  ] }));
  const args = [path.join(ROOT, "lib", "host-runner.mjs"), "--plan", planFile, "--state", stateFile];
  if (useJob) args.push("--use-job");
  const host = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  host.stdout.resume();
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    try {
      const st = JSON.parse(readFileSync(stateFile, "utf8"));
      if (st.error) throw new Error(`host error: ${st.error}`);
      if (st.hostPid) {
        hostProcs.set(st.hostPid, host);
        let httpOk = false;
        const t1 = Date.now();
        while (Date.now() - t1 < 30000) {
          try { const r = await fetch(`http://127.0.0.1:${OC_PORT}/config`); if (r.ok) { httpOk = true; break; } } catch { /* not up */ }
          await sleep(400);
        }
        return { host, state: st, httpOk };
      }
    } catch (e) {
      if (String(e.message).startsWith("host error")) throw e;
    }
    if (host.exitCode !== null) throw new Error(`host exited early code=${host.exitCode}`);
    await sleep(300);
  }
  throw new Error("host state file timeout");
}

async function queryJobMembers(jobName) {
  const r = await new Promise((resolve) => {
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "lib", "job-query.ps1"), "-JobName", jobName]);
    let out = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (c) => { out += c; });
    p.on("exit", () => resolve(out.trim()));
    p.on("error", () => resolve(""));
  });
  const m = r.match(/^MEMBERS (.*)$/m);
  if (!m) return { error: r };
  return { pids: m[1].split(",").filter(Boolean).map(Number) };
}

function memberPids(state) {
  return [state.hostPid, ...state.children.map((c) => c.pid), ...state.grandchildren.map((g) => g.pid)];
}

async function cleanupAll(state) {
  if (!state) return;
  for (const c of state.children) taskkillForce(c.pid, true);
  if (state.guardPid) taskkillForce(state.guardPid, true);
  if (state.hostPid) taskkillForce(state.hostPid, true);
  await sleep(800);
}

// —— 场景 control：无 Job，宿主 taskkill /F → 孤儿应存活 ——
async function scenarioControl() {
  const scope = "control";
  let state = null;
  try {
    const { state: st, httpOk } = await startHost({ useJob: false, tag: "control" });
    state = st;
    const childPids = [...st.children.map((c) => c.pid), ...st.grandchildren.map((g) => g.pid)];
    const preAlive = aliveMap(childPids);
    log(scope, `host=${st.hostPid} children=${st.children.map((c) => `${c.type}:${c.pid}`).join(" ")} gc=${st.grandchildren[0]?.pid} opencodeHttpOk=${httpOk}`);
    if (!Object.values(preAlive).every(Boolean) || !httpOk) throw new Error(`启动不完整: ${JSON.stringify(preAlive)} httpOk=${httpOk}`);
    const rc = taskkillForce(st.hostPid);
    log(scope, `taskkill /F /PID ${st.hostPid} → exit=${rc}`);
    await sleep(6000);
    const after = aliveMap(childPids);
    const orphans = Object.entries(after).filter(([, a]) => a).map(([p]) => Number(p));
    log(scope, `6s 后存活子/孙进程: ${JSON.stringify(after)}`);
    // 关键对照：stdio=ignore 的进程（opencode/tree/孙进程）无 EOF 自退路径，宿主死后必然成孤儿
    const nonStdio = [st.children.find((c) => c.type === "opencode").pid, st.children.find((c) => c.type === "tree").pid, ...st.grandchildren.map((g) => g.pid)];
    const orphanReproduced = nonStdio.every((p) => after[p]);
    // stdio 管道子进程（codex/claude）在宿主死后收到 stdin EOF，可能自行退出——如实记录
    const stdioExited = [...st.children.filter((c) => c.type === "codex" || c.type === "claude").map((c) => `${c.type}:${c.pid}:${after[c.pid] ? "存活" : "已自行退出(EOF)"}`)];
    log(scope, `stdio 子进程 EOF 自退情况: ${stdioExited.join(" ")}`);
    verdicts.control = { name: "无 Job 对照：宿主强杀后无 EOF 自退路径的子/孙进程成孤儿", pass: orphanReproduced, orphans, nonStdioOrphans: nonStdio, stdioSelfExit: stdioExited };
    for (const c of st.children) taskkillForce(c.pid, true);
    await sleep(1000);
    const finalMap = aliveMap(childPids);
    const cleaned = !Object.values(finalMap).some(Boolean);
    log(scope, `显式清理后全部消亡=${cleaned} 残留=${JSON.stringify(Object.entries(finalMap).filter(([, a]) => a))}`);
    if (!cleaned) verdicts.control.cleanupNote = `残留: ${JSON.stringify(finalMap)}`;
  } catch (e) {
    log(scope, `ERROR ${e.message}`);
    verdicts.control = { name: "无 Job 对照", pass: false, error: e.message };
    await cleanupAll(state);
  }
}

// —— 场景 job：宿主在 Job 内，taskkill /F → 全部成员被 OS 终止 ——
async function scenarioJob() {
  const scope = "job";
  let state = null;
  try {
    const { state: st, httpOk } = await startHost({ useJob: true, tag: "job" });
    state = st;
    const all = memberPids(st);
    log(scope, `host=${st.hostPid} guard=${st.guardPid} job=${st.jobName} children=${st.children.map((c) => `${c.type}:${c.pid}`).join(" ")} gc=${st.grandchildren[0]?.pid} httpOk=${httpOk}`);
    const q1 = await queryJobMembers(st.jobName);
    const missing = all.filter((p) => !q1.pids?.includes(p));
    log(scope, `job 成员=${JSON.stringify(q1.pids)} 期望缺失=${JSON.stringify(missing)}`);
    if (missing.length > 0) throw new Error(`Job 成员缺失（继承失效）: ${missing}`);
    const rc = taskkillForce(st.hostPid);
    log(scope, `taskkill /F /PID ${st.hostPid} → exit=${rc}`);
    // 宿主死亡瞬间快照：区分 stdio EOF 自退与 Job 终止（非 stdio 成员只能死于 Job）
    await sleep(500);
    const snapOnKill = aliveMap(memberPids(st).filter((p) => p !== st.hostPid));
    log(scope, `宿主死亡 0.5s 时成员存活快照: ${JSON.stringify(snapOnKill)}`);
    const members = all.filter((p) => p !== st.hostPid);
    let allGone = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      if (!Object.values(aliveMap(members)).some(Boolean)) { allGone = true; break; }
      await sleep(300);
    }
    const elapsedMs = Date.now() - t0;
    const guardGone = await waitGone(st.guardPid, 5000);
    const residual = Object.entries(aliveMap(members)).filter(([, a]) => a);
    // 核心：stdio=ignore 的三成员（opencode/tree/孙进程）只能被 Job 终止
    const nonStdioDead = [st.children.find((c) => c.type === "opencode").pid, st.children.find((c) => c.type === "tree").pid, ...st.grandchildren.map((g) => g.pid)].every((p) => !alive(p));
    log(scope, `成员全灭=${allGone}（轮询窗 ${elapsedMs}ms）guard 退出=${guardGone} 非stdio成员被Job终止=${nonStdioDead} 残留=${JSON.stringify(residual)}`);
    verdicts.job = { name: "Job+KILL_ON_JOB_CLOSE：宿主强杀后子/孙进程全灭", pass: allGone && guardGone && nonStdioDead, membersAtKill: members.length, snapOnKill, pollWindowMs: elapsedMs };
  } catch (e) {
    log(scope, `ERROR ${e.message}`);
    verdicts.job = { name: "Job+KILL_ON_JOB_CLOSE", pass: false, error: e.message };
    await cleanupAll(state);
  }
}

// —— 场景 graceful：Job 内单会话受控终止互不影响；宿主优雅退出 → Job 兜底全灭 ——
async function scenarioGraceful() {
  const scope = "graceful";
  let state = null;
  try {
    const { state: st } = await startHost({ useJob: true, tag: "graceful" });
    state = st;
    log(scope, `host=${st.hostPid} guard=${st.guardPid} job=${st.jobName}`);
    // (a) 单会话受控终止：只杀 opencode，其余不受影响
    const oc = st.children.find((c) => c.type === "opencode");
    const rc = taskkillForce(oc.pid);
    const ocGone = await waitGone(oc.pid, 8000);
    const rest = memberPids(st).filter((p) => p !== st.hostPid && p !== oc.pid);
    const restAlive = aliveMap(rest);
    const hostAlive = alive(st.hostPid);
    log(scope, `杀单成员 opencode:${oc.pid} → 消亡=${ocGone} 其余存活=${JSON.stringify(restAlive)} host存活=${hostAlive}`);
    const singleOk = rc === 0 && ocGone && Object.values(restAlive).every(Boolean) && hostAlive;
    // (b) 宿主优雅退出（stdin END）→ guard 检测宿主死亡 → Job 句柄关闭 → 剩余成员被 OS 终止
    const host = hostProcs.get(st.hostPid);
    host.stdin.write("END\n");
    const hostExited = await new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (!alive(st.hostPid)) { clearInterval(iv); resolve(true); }
        else if (Date.now() - t0 > 10000) { clearInterval(iv); resolve(false); }
      }, 150);
    });
    await sleep(500);
    const snapOnExit = aliveMap(rest);
    log(scope, `宿主退出 0.5s 时剩余成员存活快照: ${JSON.stringify(snapOnExit)}（stdio 成员可能已 EOF 自退）`);
    const guardGone = await waitGone(st.guardPid, 8000);
    let allGone = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      if (!Object.values(aliveMap(rest)).some(Boolean)) { allGone = true; break; }
      await sleep(300);
    }
    const residual = Object.entries(aliveMap(rest)).filter(([, a]) => a);
    const treeStill = st.children.find((c) => c.type === "tree");
    const nonStdioDead = [treeStill.pid, ...st.grandchildren.map((g) => g.pid)].every((p) => !alive(p)); // opencode 已在 (a) 终止
    log(scope, `host 优雅退出=${hostExited} guard 退出=${guardGone} 剩余成员全灭=${allGone} 非stdio成员被Job终止=${nonStdioDead} 残留=${JSON.stringify(residual)}`);
    verdicts.graceful = { name: "Job 内单会话受控终止互不影响 + 优雅退出 Job 兜底全灭", pass: singleOk && hostExited && guardGone && allGone && nonStdioDead, singleSessionOk: singleOk, hostExited, guardGone, allGone, snapOnExit };
  } catch (e) {
    log(scope, `ERROR ${e.message}`);
    verdicts.graceful = { name: "Job 内单会话终止 + 优雅退出", pass: false, error: e.message };
    await cleanupAll(state);
  }
}

// —— 兜底清理注册的所有 host ——
process.on("exit", () => {
  for (const [pid] of hostProcs) {
    if (alive(pid)) taskkillForce(pid, true);
  }
});

const scenarios = only ? [only] : ["control", "job", "graceful"];
const map = { control: scenarioControl, job: scenarioJob, graceful: scenarioGraceful };
for (const name of scenarios) await map[name]();

const allPass = Object.values(verdicts).every((v) => v.pass);
console.log(`T1_VERDICT ${allPass ? "PASS" : "FAIL"}`);
logLines.push(`T1_VERDICT ${allPass ? "PASS" : "FAIL"}`);
writeFileSync(path.join(LOGS, `t1-result-${RUN_TAG}.json`), JSON.stringify({ runTag: RUN_TAG, verdicts, logLines }, null, 2), "utf8");
process.exit(allPass ? 0 : 1);
