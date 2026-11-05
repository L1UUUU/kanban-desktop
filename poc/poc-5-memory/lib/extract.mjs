// 临时提取 Session：spawn 独立的 claude -p 会话（每次新 UUID、独立 cwd、无 --resume/--continue），
// 注入历史文本并要求输出结构化 JSON；与开发 Session 完全隔离，不在开发 thread/jsonl 上追加任何内容。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// 解析 claude 真实原生 exe（npm 全局包内），直连避免 .cmd shim 的 shell 参数改写
export function resolveClaudeCommand() {
  const exe = path.join(
    os.homedir(),
    "AppData", "Roaming", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin",
    process.platform === "win32" ? "claude.exe" : "claude",
  );
  if (existsSync(exe)) return { cmd: exe, shell: false };
  return { cmd: process.platform === "win32" ? "claude.cmd" : "claude", shell: process.platform === "win32" };
}

// 执行一次 claude -p 调用（提取用独立临时 session；开发 session 创建时亦可复用）；
// 返回 { sessionId, rawText, usage, events, modelCalls:1 }
export function runClaudePrint({ cwd, prompt, sessionId, extraArgs = [], timeoutMs = 300000 }) {
  const sid = sessionId || randomUUID();
  const { cmd, shell } = resolveClaudeCommand();
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--session-id", sid,
    ...extraArgs,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let rawText = "";
    let usage = null;
    let initSessionId = null;
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(reject, new Error(`claude -p 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      out += c;
      let idx;
      while ((idx = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, idx).trim();
        out = out.slice(idx + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "init") initSessionId = ev.session_id || initSessionId;
          if (ev.type === "result") {
            rawText = ev.result || "";
            usage = ev.usage || null;
            if (ev.subtype && ev.subtype !== "success") {
              finish(reject, new Error(`claude -p 失败: subtype=${ev.subtype} ${rawText.slice(0, 200)}`));
            }
          }
        } catch { /* 非整行/非 JSON 忽略 */ }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => { err += c; });
    child.on("error", (e) => finish(reject, new Error(`spawn claude 失败: ${e.message}`)));
    child.on("close", (code) => {
      if (code !== 0 && !rawText) {
        finish(reject, new Error(`claude 退出码 ${code}: ${err.slice(0, 300)}`));
        return;
      }
      finish(resolve, { sessionId: initSessionId || sid, rawText, usage, modelCalls: 1 });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// 提取专用封装：解析 JSON 并做来源校正；解析失败时把原文落盘留证再抛错
export async function runExtractionSession({ cwd, prompt, sessionId, timeoutMs, onParseFailure }) {
  const r = await runClaudePrint({ cwd, prompt, sessionId, timeoutMs });
  let json;
  try {
    json = extractJsonObject(r.rawText);
  } catch (e) {
    if (onParseFailure) onParseFailure(r.rawText);
    throw new Error(`提取输出无法解析为 JSON: ${e.message}; 原文开头=${r.rawText.slice(0, 300)}`);
  }
  return { ...r, json };
}

// 从模型回复文本中抠出 JSON 对象（容忍 ```json 围栏与前后说明文字）
export function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("回复中未找到 JSON 对象");
  return JSON.parse(text.slice(start, end + 1));
}

// 校验并规范化提取结果：candidates 必须为数组且每条含 claim；
// 来源归属强制校正——模型给出的 sourceSessionIds 若不属于本段 session 集合则丢弃并回填段内全部来源。
export function clampExtraction(json, segmentSessions, segmentIndex) {
  const summary = typeof json.summary === "string" ? json.summary.trim() : "";
  const rawCands = Array.isArray(json.candidates) ? json.candidates : [];
  const candidates = [];
  for (const c of rawCands) {
    if (!c || typeof c.claim !== "string" || !c.claim.trim()) continue;
    let src = Array.isArray(c.sourceSessionIds) ? c.sourceSessionIds.filter((s) => segmentSessions.includes(s)) : [];
    if (src.length === 0) src = [...segmentSessions];
    candidates.push({
      claim: c.claim.trim(),
      evidence: typeof c.evidence === "string" ? c.evidence.trim() : "",
      scope: typeof c.scope === "string" ? c.scope.trim() : "",
      sourceSessionIds: src,
      segments: [segmentIndex],
    });
  }
  return { summary, candidates };
}
