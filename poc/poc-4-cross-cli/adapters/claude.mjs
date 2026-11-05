// 用途：Claude Code Adapter —— 解析真实 claude.exe、以编程 spawn（不经 shell）跑一次性 -p 会话（stdin 传 prompt 避免 MSYS 改写）、并把项目级 hook 落盘的 hook-events.jsonl 转换为归一化 verified 事件（方案复制自 poc-2 已验证链路）
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PROJ = join(here, "..", "fixture", "proj");
export const HOOK_FILE = join(FIXTURE_PROJ, "hook-events.jsonl");

let cachedExe;
// 解析真实 claude.exe（npm 全局包内 bin/claude.exe；避免 .cmd shim 的 shell 链）
export function resolveClaudeCommand() {
  if (cachedExe) return cachedExe;
  if (process.env.POC4_CLAUDE_EXE && existsSync(process.env.POC4_CLAUDE_EXE)) return (cachedExe = process.env.POC4_CLAUDE_EXE);
  try {
    const isWin = process.platform === "win32";
    const npmRoot = execFileSync(isWin ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8", shell: isWin }).trim();
    const exe = join(npmRoot, "@anthropic-ai", "claude-code", "bin", isWin ? "claude.exe" : "claude");
    if (existsSync(exe)) return (cachedExe = exe);
  } catch { /* 继续回退 */ }
  return (cachedExe = "claude"); // 回退 PATH（POSIX 可执行；Windows 下由调用方 shell 化）
}

// 跑一次一次性 -p 会话：prompt 经 stdin 传入（保 slash 原文），stream-json 输出逐行解析；返回 {sessionId, costUsd, skillToolCalls, texts, resultText}
export function runClaudePrompt({ prompt, cwd = FIXTURE_PROJ, timeoutMs = 180000 }) {
  const exe = resolveClaudeCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ["-p", "--output-format", "stream-json", "--verbose"], {
      cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false,
    });
    const out = { exe, sessionId: null, cliVersion: null, costUsd: null, skillToolCalls: 0, skillInputs: [], texts: [], resultText: null, isError: null };
    let buf = "";
    let done = false;
    const timer = setTimeout(() => { done = true; child.kill(); reject(new Error(`claude prompt timeout after ${timeoutMs}ms`)); }, timeoutMs);
    const finish = (err, code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* 已关闭 */ }
      if (err) reject(err);
      else if (code !== 0 && out.sessionId === null) reject(new Error(`claude exited code=${code}`));
      else resolve(out);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === "system" && msg.subtype === "init") {
          out.sessionId = msg.session_id;
          out.cliVersion = msg.claude_code_version;
        } else if (msg.type === "assistant" && msg.message) {
          for (const c of msg.message.content ?? []) {
            if (c.type === "tool_use" && c.name === "Skill") { out.skillToolCalls++; out.skillInputs.push(c.input ?? null); }
            if (c.type === "text" && c.text?.trim()) out.texts.push(c.text.trim());
          }
        } else if (msg.type === "result") {
          out.costUsd = msg.total_cost_usd ?? null;
          out.resultText = String(msg.result ?? "");
          out.isError = !!msg.is_error;
          finish(null, 0);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => process.stderr.write("[claude-stderr] " + d));
    child.on("error", (e) => finish(e));
    child.on("exit", (code) => finish(null, code));
    // stdin 传 prompt 必须 EOF（end）才会触发 -p 处理（claude 从 stdin 读到关闭为止）
    child.stdin.write(prompt + "\n");
    child.stdin.end();
  });
}

// 读 hook-events.jsonl，取 PreToolUse(Skill) 生成归一化 verified 事件（真调用唯一真相源，poc-2 结论）；postToolUseSuccess 附加 PostToolUse 成功确认标记
export function readHookSkillEvents({ sinceLine = 0 } = {}) {
  if (!existsSync(HOOK_FILE)) return [];
  const lines = readFileSync(HOOK_FILE, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const records = lines.map((l) => JSON.parse(l));
  const postOk = new Set(records.filter((r) => r.hookEventName === "PostToolUse" && r.toolName === "Skill" && r.toolResponse?.success).map((r) => `${r.sessionId}:${r.toolInput?.skill}`));
  const out = [];
  for (const r of records.slice(sinceLine)) {
    if (r.hookEventName !== "PreToolUse" || r.toolName !== "Skill") continue;
    const skill = r.toolInput?.skill ?? r.toolInput?.command ?? null;
    if (!skill) continue;
    out.push({
      eventId: `hook:${r.sessionId}:${skill}:${r.capturedAt}`,
      kind: "skill",
      sessionId: r.sessionId,
      cli: "claude-code",
      skill,
      stage: null,
      requirementId: null,
      occurredAt: r.capturedAt, // hook 捕获时间即 skill 实际发生时间（PreToolUse 瞬间）
      receivedAt: new Date().toISOString(),
      seq: null,
      evidenceLevel: "verified",
      source: postOk.has(`${r.sessionId}:${skill}`) ? "hook:PreToolUse+PostToolUseSuccess" : "hook:PreToolUse",
    });
  }
  return out;
}

export function hookFileLineCount() {
  if (!existsSync(HOOK_FILE)) return 0;
  return readFileSync(HOOK_FILE, "utf8").split(/\r?\n/).filter((l) => l.trim()).length;
}
