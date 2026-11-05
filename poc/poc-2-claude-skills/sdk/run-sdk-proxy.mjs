// 用途：透明代理复现 —— 自定义 spawnClaudeCodeProcess 记录 SDK 完整协议流，定位子进程死亡原因
import { query } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { writeFileSync, createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixture", "proj");
const LOG = join(here, "..", "runs", "proxy-log.txt");
const stream = createWriteStream(LOG, { flags: "w" });
const log = (s) => stream.write(new Date().toISOString() + " " + s + "\n");

try {
  const q = query("Reply with exactly: MINIMAL-OK", {
    cwd: FIXTURE,
    stderr: (d) => log("[cli-stderr] " + d),
    spawnClaudeCodeProcess: (opts) => {
      // 记录 spawn 参数（env 只记 keys，避免 token 落盘）
      log("SPAWN command=" + opts.command + " args=" + JSON.stringify(opts.args));
      log("SPAWN env keys=" + JSON.stringify(Object.keys(opts.env).sort()));
      const diff = {};
      for (const k of Object.keys(opts.env)) if (process.env[k] !== opts.env[k] && !/TOKEN|KEY|SECRET/i.test(k)) diff[k] = String(opts.env[k]).slice(0, 80);
      log("SPAWN env 相对 process.env 的差异=" + JSON.stringify(diff));
      const child = spawn(opts.command, opts.args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: opts.env, windowsHide: true, signal: opts.signal });
      // tee stdin（SDK 写入的每个字节）
      const origWrite = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk, ...rest) => { log("[sdk->cli stdin] " + String(chunk).slice(0, 2000)); return origWrite(chunk, ...rest); };
      child.stdout.on("data", (d) => log("[cli->sdk stdout] " + d.toString().slice(0, 600)));
      child.stderr.on("data", (d) => log("[cli-stderr] " + d.toString().slice(0, 400)));
      child.on("exit", (c, s) => log("CHILD EXIT code=" + c + " signal=" + s));
      return child;
    },
  });
  for await (const m of q) {
    if (m.type === "system" && m.subtype === "init") log("SDK init ok session=" + m.session_id);
    else if (m.type === "result") log("SDK result: " + m.subtype + " isError=" + m.is_error + " | " + String(m.result ?? "").slice(0, 80));
  }
  log("QUERY COMPLETED");
} catch (e) {
  log("QUERY FAILED: " + (e?.telemetryMessage ?? e?.message));
  process.exitCode = 1;
} finally {
  stream.end();
}
console.log("proxy log ->", LOG);
