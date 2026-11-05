// 用途：手动 spawn 判别 —— 用与 SDK 完全相同的 exe+args，逐项叠加 SDK 设置的 env，找出子进程秒退的最小触发组合（不发生模型调用，只看进程存活）
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const EXE = join(here, "node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64", "claude.exe");
const ARGS = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"];
const CWD = join(here, "fixture", "proj");
const INIT = JSON.stringify({ request_id: "diag1", type: "control_request", request: { subtype: "initialize", options: {} } }) + "\n";
const SURVIVE_MS = 10_000;

// SDK 对子进程 env 的改写（sdk.mjs 反解）：ENTRYPOINT=sdk-ts、SDK 版本、删 NODE_OPTIONS、可选 checkpointing
const variants = [
  { label: "M1-plain", env: {} },
  { label: "M2-sdk-entrypoint", env: { CLAUDE_CODE_ENTRYPOINT: "sdk-ts", CLAUDE_AGENT_SDK_VERSION: "0.3.318" } },
  { label: "M3-checkpointing", env: { CLAUDE_CODE_ENTRYPOINT: "sdk-ts", CLAUDE_AGENT_SDK_VERSION: "0.3.318", CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "true", CLAUDE_CODE_SDK_READS_SESSION_STATE: "true" } },
];

function runOne(v) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...v.env };
    delete env.NODE_OPTIONS; // SDK 各变体都会删
    const child = spawn(EXE, ARGS, { cwd: CWD, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
    const out = [];
    const t0 = Date.now();
    const timer = setTimeout(() => { cleanup(`SURVIVED ${Date.now() - t0}ms (视为成功)`); child.kill(); }, SURVIVE_MS);
    const cleanup = (verdict) => { clearTimeout(timer); resolve({ label: v.label, verdict, stdout: out.slice(0, 5), exitCode: child.exitCode }); };
    child.stdout.on("data", (d) => { out.push(String(d).slice(0, 200)); });
    child.stderr.on("data", (d) => { out.push("[stderr] " + String(d).slice(0, 200)); });
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ label: v.label, verdict: `EXITED code=${code} signal=${signal} after ${Date.now() - t0}ms`, stdout: out.slice(0, 5), exitCode: code }); });
    child.stdin.write(INIT);
    child.on("error", (e) => { clearTimeout(timer); resolve({ label: v.label, verdict: `SPAWN_ERROR ${e.message}`, stdout: [], exitCode: null }); });
  });
}

for (const v of variants) {
  const r = await runOne(v);
  console.log(`[${r.label}] ${r.verdict}`);
  for (const line of r.stdout) console.log(`    ${line.replace(/\n/g, " ").slice(0, 180)}`);
}
