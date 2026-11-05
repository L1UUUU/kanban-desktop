// 用途：stream-json 协议直连客户端 —— 等价于 Agent SDK 的传输层（spawn claude.exe + 双向 JSON 流），验证 SDK 同款接入路径的 Skill 触发与事件观察
// 说明：@anthropic-ai/claude-agent-sdk 0.2.141/0.3.318 在本机 Windows 均在 pre-spawn 阶段 abort（详见 RESULT.md），
//       本脚本按 SDK 同款 wire 协议手写传输层，隔离验证同一能力面。
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const EXE = process.env.POC2_CLAUDE_EXE ?? join(here, "..", "sdk", "node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64", "claude.exe");
const FIXTURE = join(here, "..", "fixture", "proj");
const OUT = process.env.POC2_OUT ?? join(here, "..", "runs", "b1-protocol-slash-events.json");

// prompt 经环境变量传入，避免 Git Bash 的 MSYS 参数路径转换改写 / 前缀
const prompt = process.env.POC2_PROMPT ?? process.argv[2] ?? "/design-feature";
const disallowed = ["Bash", "Read", "Glob", "Grep", "PowerShell", "ToolSearch", "WebFetch", "WebSearch", "NotebookEdit"];
const args = [
  "--output-format", "stream-json", "--verbose", "--input-format", "stream-json",
  "--permission-mode", "default",
  "--disallowedTools", disallowed.join(","),
];

const events = { exe: EXE, cliVersion: null, sessionId: null, permissionMode: null, prompt, stream: [], skillToolCalls: 0 };
const child = spawn(EXE, args, { cwd: FIXTURE, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

let buf = "";
let initialized = false;
const pending = {};

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

function handle(msg) {
  // control_response 唤醒等待者
  if (msg.type === "control_response" && pending[msg.request_id ?? msg.response?.request_id]) {
    pending[msg.response?.request_id ?? msg.request_id](msg);
    return;
  }
  if (msg.type === "system" && msg.subtype === "init") {
    events.cliVersion = msg.claude_code_version;
    events.sessionId = msg.session_id;
    events.permissionMode = msg.permissionMode;
    events.skillsDiscovered = (msg.skills ?? []).filter((s) => /design-feature|implement-spec/.test(s));
    events.stream.push({ kind: "init" });
  } else if (msg.type === "assistant" && msg.message) {
    for (const c of msg.message.content ?? []) {
      if (c.type === "tool_use") {
        if (c.name === "Skill") events.skillToolCalls += 1;
        events.stream.push({ kind: "tool_use", name: c.name, input: c.input });
      } else if (c.type === "text" && c.text?.trim()) {
        events.stream.push({ kind: "text", text: c.text.slice(0, 160) });
      }
    }
  } else if (msg.type === "user" && Array.isArray(msg.message?.content)) {
    for (const it of msg.message.content) {
      if (it.type === "text") events.stream.push({ kind: "skill_expansion", text: it.text.slice(0, 160) });
    }
  } else if (msg.type === "result") {
    events.stream.push({ kind: "result", subtype: msg.subtype, isError: msg.is_error, costUsd: msg.total_cost_usd, result: String(msg.result ?? "").slice(0, 160) });
    finish(0);
  }
}

child.stderr.on("data", (d) => process.stderr.write("[cli-stderr] " + d));
child.on("exit", (code) => { if (!done) { events.stream.push({ kind: "early_exit", code }); finish(1); } });

let done = false;
function finish(code) {
  if (done) return;
  done = true;
  writeFileSync(OUT, JSON.stringify(events, null, 2), "utf8");
  console.log(JSON.stringify(events, null, 2));
  try { child.stdin.end(); } catch {}
  setTimeout(() => { child.kill(); process.exit(code); }, 1500).unref();
}

// 1) initialize 握手（等待 control_response）
const initId = randomUUID();
send({ request_id: initId, type: "control_request", request: { subtype: "initialize", options: {} } });
const timer = setTimeout(() => { events.stream.push({ kind: "timeout_waiting_initialize" }); finish(1); }, 60000).unref();
pending[initId] = (resp) => {
  clearTimeout(timer);
  if (resp.response?.subtype !== "success") {
    events.stream.push({ kind: "initialize_failed", resp: JSON.stringify(resp).slice(0, 300) });
    finish(1);
    return;
  }
  initialized = true;
  events.stream.push({ kind: "initialize_ok" });
  // 2) 发送用户消息（slash 文本，与 GUI 输入一致；由 CLI 做 slash dispatch）
  send({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, parent_tool_use_id: null });
};
