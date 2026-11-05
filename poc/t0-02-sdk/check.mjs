// 用途：Windows 真实复测 @anthropic-ai/claude-agent-sdk —— T1 最小 query / T2 interrupt 后会话存活（上游 #444 场景）/ T3 canUseTool 审批回调（PoC 2 发现 5 缺口），断言明确、留证 runs/
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const RUNS = join(here, "runs");
const FIXTURE = join(here, "fixture", "proj");
mkdirSync(RUNS, { recursive: true });
mkdirSync(FIXTURE, { recursive: true });

const T_TIMEOUT_MS = 120_000;
const T1_MARKER = "T0-02-SDK-OK";
const T2_MARKER = "T0-02-WARM-OK";

// —— 环境与版本入档（SDK 版本、捆绑 win32 CLI 包版本、Node、临时目录线索）
const sdkPkg = JSON.parse(readFileSync(join(here, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf8"));
let win32PkgVersion = null;
try {
  win32PkgVersion = JSON.parse(readFileSync(join(here, "node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64", "package.json"), "utf8")).version;
} catch { /* 非 win32 依赖缺失时如实留空 */ }
const envInfo = {
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  sdkVersion: sdkPkg.version,
  win32CliPackageVersion: win32PkgVersion,
  temp: process.env.TEMP ?? process.env.TMP ?? null,
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  startedAt: new Date().toISOString(),
};

// —— 未捕获 rejection 记为证据，防 SDK 异步吞错导致误判
const asyncErrors = [];
process.on("unhandledRejection", (e) => { asyncErrors.push(String(e?.stack ?? e)); });

const errText = (e) => String(e?.stack ?? e?.telemetryMessage ?? e?.message ?? e);

// 超时守护 + 异常兜底：测试函数自身不抛（内部 try/catch），这里只防挂死与意外崩溃
async function guard(label, fn) {
  const t0 = Date.now();
  let timer = null;
  try {
    const detail = await Promise.race([
      fn(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout after ${T_TIMEOUT_MS}ms`)), T_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
    return { test: label, status: detail.pass ? "pass" : "fail", durationMs: Date.now() - t0, ...detail };
  } catch (e) {
    if (timer) clearTimeout(timer);
    return { test: label, status: "fail", durationMs: Date.now() - t0, summary: `guard caught: ${String(e).slice(0, 200)}`, evidence: { error: errText(e) } };
  }
}

// T1：最小裸 query —— 判定 SDK 传输层能否在 Windows 完成 spawn 并拿到 success result
async function t1() {
  const ev = { messages: [], stderrTail: [], initSeen: false };
  let pass = false;
  try {
    const q = query(`Reply with exactly: ${T1_MARKER}`, {
      cwd: FIXTURE,
      settingSources: ["user"],
      stderr: (d) => { ev.stderrTail.push(String(d).slice(0, 300)); if (ev.stderrTail.length > 20) ev.stderrTail.shift(); },
    });
    for await (const m of q) {
      ev.messages.push({ type: m.type, subtype: m.subtype ?? null });
      if (m.type === "system" && m.subtype === "init") { ev.initSeen = true; ev.cliVersion = m.claude_code_version; ev.sessionId = m.session_id; }
      if (m.type === "result") {
        ev.resultSubtype = m.subtype; ev.resultIsError = m.is_error; ev.costUsd = m.total_cost_usd;
        ev.resultText = String(m.result ?? "").slice(0, 200);
      }
    }
    pass = ev.resultSubtype === "success" && (ev.resultText ?? "").includes(T1_MARKER);
  } catch (e) {
    ev.error = errText(e);
  }
  const summary = `messages=${ev.messages.length} init=${ev.initSeen} result=${ev.resultSubtype ?? "(none)"} text=${ev.resultText ?? "(none)"}`;
  return { pass, summary, evidence: ev };
}

// T2：#444 复现 —— init 后立即 interrupt，断言子进程不 segfault、被中断轮有终态 result、会话可继续第二轮
async function t2() {
  const ev = { messages: [], stderrTail: [], interruptAck: false };
  let pass = false;
  // 异步 prompt 通道：多轮持久会话（push 消息 / end 结束）
  const queue = []; let wake = null; let closed = false;
  const chan = (async function* () {
    while (true) {
      if (queue.length) yield queue.shift();
      else if (closed) return;
      else await new Promise((r) => { wake = r; });
    }
  })();
  queue.push("warmup: do not answer yet");
  let turn = 0;
  try {
    const q = query({ prompt: chan, options: {
      cwd: FIXTURE,
      settingSources: ["user"],
      stderr: (d) => { ev.stderrTail.push(String(d).slice(0, 300)); if (ev.stderrTail.length > 20) ev.stderrTail.shift(); },
    } });
    for await (const m of q) {
      ev.messages.push({ type: m.type, subtype: m.subtype ?? null });
      if (m.type === "system" && m.subtype === "init") {
        ev.cliVersion = m.claude_code_version; ev.sessionId = m.session_id;
        if (!ev.interruptAck) {
          try { await q.interrupt(); ev.interruptAck = true; } catch (e) { ev.interruptError = errText(e); }
        }
      }
      if (m.type === "result") {
        turn += 1;
        if (turn === 1) {
          ev.turn1 = { subtype: m.subtype, isError: m.is_error };
          queue.push(`Reply with exactly: ${T2_MARKER}`); // 中断后同会话续问，验证存活
        } else if (turn === 2) {
          ev.turn2 = { subtype: m.subtype, isError: m.is_error, text: String(m.result ?? "").slice(0, 100) };
          closed = true; wake?.(); // 第二轮终态即收工，结束 prompt 流
        }
      }
    }
    ev.streamEndedCleanly = true;
  } catch (e) {
    ev.error = errText(e);
  }
  // segfault 证据扫描：0xC0000005 / 3221225477 出现在任何错误文本中即判崩
  const allErrText = [ev.error, ev.interruptError, ...ev.stderrTail].filter(Boolean).join("\n");
  ev.segfaultEvidence = /0xC0000005|3221225477/i.test(allErrText);
  pass = ev.interruptAck
    && !!ev.turn1
    && !!ev.turn2 && ev.turn2.subtype === "success" && ev.turn2.text.includes(T2_MARKER)
    && !ev.segfaultEvidence;
  const summary = `interruptAck=${ev.interruptAck} turn1=${JSON.stringify(ev.turn1 ?? null)} turn2=${JSON.stringify(ev.turn2 ?? null)} segfault=${ev.segfaultEvidence}`;
  return { pass, summary, evidence: ev };
}

// T3：canUseTool 审批回调（PoC 2 发现 5 当时因 SDK 不可用未测）—— deny Bash 并断言回调真实触发、轮次正常收尾
async function t3() {
  const ev = { approvals: [], stderrTail: [] };
  let pass = false;
  try {
    const q = query("Use the Bash tool to run exactly: echo hello-t0-02", {
      cwd: FIXTURE,
      settingSources: ["user"],
      canUseTool: async (toolName, input) => {
        ev.approvals.push({ toolName, command: input?.command ?? null, at: new Date().toISOString() });
        return { behavior: "deny", message: "t0-02 test denial: do not run any tool, just reply with the exact token DONE-T0-02" };
      },
      stderr: (d) => { ev.stderrTail.push(String(d).slice(0, 300)); if (ev.stderrTail.length > 20) ev.stderrTail.shift(); },
    });
    for await (const m of q) {
      if (m.type === "result") {
        ev.resultSubtype = m.subtype; ev.resultText = String(m.result ?? "").slice(0, 200); ev.costUsd = m.total_cost_usd;
      }
    }
  } catch (e) {
    ev.error = errText(e);
  }
  ev.bashApprovalSeen = ev.approvals.some((a) => a.toolName === "Bash");
  ev.denialRelaySeen = /DONE-T0-02/.test(ev.resultText ?? "");
  pass = ev.bashApprovalSeen && ev.resultSubtype === "success";
  const summary = `approvals=[${ev.approvals.map((a) => a.toolName).join(",")}] result=${ev.resultSubtype ?? "(none)"} denialRelay=${ev.denialRelaySeen}`;
  return { pass, summary, evidence: ev };
}

// —— 执行：T1 失败则 T2/T3 跳过（传输层不可用时后续能力无从谈起）
const results = [];
const t1r = await guard("T1-minimal-query", t1);
results.push(t1r);
if (t1r.status === "pass") {
  results.push(await guard("T2-interrupt-survival", t2));
  results.push(await guard("T3-canUseTool-approval", t3));
} else {
  results.push({ test: "T2-interrupt-survival", status: "skipped", reason: "T1 failed" });
  results.push({ test: "T3-canUseTool-approval", status: "skipped", reason: "T1 failed" });
}

const usable = results.every((r) => r.status !== "fail");
const out = {
  env: envInfo,
  verdict: usable ? "SDK-USABLE" : "SDK-UNUSABLE",
  results: results.map((r) => ({ test: r.test, status: r.status, durationMs: r.durationMs, summary: r.summary ?? r.reason })),
  unhandledRejections: asyncErrors,
  detail: results,
  finishedAt: new Date().toISOString(),
};
const outFile = join(RUNS, `check-${envInfo.sdkVersion}.json`);
writeFileSync(outFile, JSON.stringify(out, null, 2), "utf8");

console.log(`SDK ${envInfo.sdkVersion} (win32-x64 pkg ${win32PkgVersion}) on ${envInfo.platform} ${envInfo.node}`);
for (const r of results) console.log(`  ${r.status.toUpperCase().padEnd(7)} ${r.test} (${r.durationMs ?? "-"}ms) ${r.summary ?? r.reason ?? ""}`);
if (asyncErrors.length) console.log(`  unhandledRejections: ${asyncErrors.length}`);
console.log(`verdict: ${out.verdict} -> ${outFile}`);
process.exit(usable ? 0 : 1);
