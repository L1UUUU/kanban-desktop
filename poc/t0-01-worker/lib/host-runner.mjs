// 用途：模拟 Worker 宿主进程 —— 按计划 spawn CLI 子进程（codex/claude/opencode/合成孙进程树），可选先建 Job Object 守护并把自己挂入 Job，就绪后写状态文件并长驻等待指令（stdin "END" 优雅退出 / 被外部强杀）
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { resolveCodexExe, resolveClaudeExe, resolveOpencodeExe } from "./exe-paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FIXTURE = path.join(ROOT, "fixture");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const planPath = arg("--plan");
const statePath = arg("--state");
const useJob = process.argv.includes("--use-job");
if (!planPath || !statePath) { console.error("usage: host-runner.mjs --plan <json> --state <json> [--use-job]"); process.exit(2); }
const plan = JSON.parse(readFileSync(planPath, "utf8"));

const hostLogs = path.join(ROOT, "logs", "hosts");
mkdirSync(hostLogs, { recursive: true });

// opencode 的 XDG 隔离（沿用 PoC 3 模式：全局配置/数据重定向到 fixture，不触碰用户目录）
function opencodeEnv(dirLabel) {
  const cfg = path.join(FIXTURE, `opencode-${dirLabel}`);
  mkdirSync(path.join(cfg, "config"), { recursive: true });
  mkdirSync(path.join(cfg, "data"), { recursive: true });
  const env = { ...process.env };
  env.XDG_CONFIG_HOME = path.join(cfg, "config");
  env.XDG_DATA_HOME = path.join(cfg, "data");
  env.XDG_STATE_HOME = path.join(cfg, "data", "state");
  env.XDG_CACHE_HOME = path.join(cfg, "data", "cache");
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_CONTENT;
  return { env, workdir: path.join(cfg, "workdir") };
}

let guardPid = null;
let jobName = null;
let guardBufRef = null;

// —— 可选：Job Object 守护（先于子进程 spawn，子进程经继承自动入 Job）——
if (useJob) {
  jobName = `kanban_t0_${randomUUID().slice(0, 8)}`;
  // guard 不用 detached：powershell + DETACHED_PROCESS 会静默退出；宿主死亡时 guard 随宿主退出（harness/管道），
  // 句柄关闭即触发 Job KILL_ON_JOB_CLOSE —— 与「宿主持句柄、宿主死则句柄关」的产品语义等价（standalone 已验证等待路径）
  const guard = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "job-guard.ps1"), "-WorkerPid", String(process.pid), "-JobName", jobName], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  guardPid = guard.pid;
  const ready = await new Promise((resolve) => {
    const bufRef = { content: "" };
    guardBufRef = bufRef;
    const timer = setTimeout(() => resolve(false), 20000);
    guard.stdout.setEncoding("utf8");
    guard.stdout.on("data", (c) => {
      bufRef.content += c;
      if (bufRef.content.includes("GUARD_READY")) { clearTimeout(timer); resolve(true); }
      if (bufRef.content.includes("GUARD_ERROR")) { clearTimeout(timer); resolve(false); }
    });
    guard.on("exit", () => { clearTimeout(timer); resolve(bufRef.content.includes("GUARD_READY") ? "exited" : false); });
    guard.on("error", (e) => { bufRef.content += `SPAWN_ERROR ${e.message}`; clearTimeout(timer); resolve(false); });
  });
  if (ready !== true) {
    writeFileSync(statePath, JSON.stringify({ error: `guard not ready (${ready})`, jobName, guardPid, guardOutput: (guardBufRef?.content || "").slice(0, 2000) }, null, 2));
    try { guard.kill(); } catch { /* ignore */ }
    process.exit(1);
  }
}

// —— 按计划 spawn 子进程 ——
const children = [];
const grandchildren = [];
const pending = [];

for (const spec of plan.children || []) {
  const label = spec.type + (spec.port ? `-${spec.port}` : "");
  const errFd = openSync(path.join(hostLogs, `${label}.stderr.log`), "a");
  const outFd = openSync(path.join(hostLogs, `${label}.stdout.log`), "a");
  if (spec.type === "codex") {
    const cwd = path.join(FIXTURE, "workdir-codex");
    mkdirSync(cwd, { recursive: true });
    const c = spawn(resolveCodexExe(), ["app-server"], { cwd, stdio: ["pipe", outFd, errFd], detached: true, windowsHide: true });
    children.push({ type: "codex", label, pid: c.pid, spawnAt: new Date().toISOString() });
  } else if (spec.type === "claude") {
    const cwd = path.join(FIXTURE, "workdir-claude");
    mkdirSync(cwd, { recursive: true });
    // stream-json 模式 + initialize 握手（不发用户消息，进程长驻等待下一输入，零模型调用）
    const c = spawn(resolveClaudeExe(), ["-p", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--include-partial-messages"], { cwd, stdio: ["pipe", outFd, errFd], detached: true, windowsHide: true });
    c.stdin.write(JSON.stringify({ request_id: `host-${randomUUID()}`, type: "control_request", request: { subtype: "initialize", options: {} } }) + "\n");
    children.push({ type: "claude", label, pid: c.pid, spawnAt: new Date().toISOString() });
  } else if (spec.type === "opencode") {
    const { env, workdir } = opencodeEnv(String(spec.port));
    mkdirSync(workdir, { recursive: true });
    const c = spawn(resolveOpencodeExe(), ["serve", "--port", String(spec.port), "--hostname", "127.0.0.1"], { cwd: workdir, env, stdio: ["ignore", outFd, errFd], detached: true, windowsHide: true });
    children.push({ type: "opencode", label: `opencode-${spec.port}`, pid: c.pid, port: spec.port, spawnAt: new Date().toISOString() });
  } else if (spec.type === "tree") {
    const c = spawn(process.execPath, [path.join(__dirname, "tree-child.mjs")], { stdio: ["ignore", "pipe", errFd], detached: true, windowsHide: true });
    children.push({ type: "tree", label, pid: c.pid, spawnAt: new Date().toISOString() });
    pending.push(new Promise((resolve) => {
      let buf = "";
      c.stdout.setEncoding("utf8");
      c.stdout.on("data", (chunk) => {
        buf += chunk;
        const m = buf.match(/CHILD_READY (\d+) GRANDCHILD (\d+)/);
        if (m) { grandchildren.push({ type: "tree-grandchild", label: `${label}-gc`, pid: Number(m[2]) }); resolve(); }
      });
      setTimeout(resolve, 15000); // 孙进程上报兜底超时
    }));
  }
}

await Promise.all(pending);
writeFileSync(statePath, JSON.stringify({ hostPid: process.pid, guardPid, jobName, useJob, children, grandchildren, readyAt: new Date().toISOString() }, null, 2));

// —— 长驻等待：stdin 收到 END 优雅退出；stdin 关闭或超时也退出（子进程一律不动，由外层清理）——
let ended = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { if (c.includes("END") && !ended) { ended = true; process.exit(0); } });
process.stdin.on("close", () => { if (!ended) { ended = true; process.exit(0); } });
setTimeout(() => process.exit(0), 300000).unref(); // 安全兜底：5 分钟自动退出
setInterval(() => {}, 60000); // 保持事件循环
