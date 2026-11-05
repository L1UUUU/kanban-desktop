// 用途：诊断模式 —— 只跑一次最小 query 并打印时间线，配合外部 CIM 轮询抓 SDK 实际 spawn 的子进程
import { query } from "@anthropic-ai/claude-agent-sdk";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
console.log("[diag] start", new Date().toISOString());
try {
  const q = query("Reply with exactly: DIAG-OK", { cwd: join(here, "fixture", "proj"), settingSources: ["user"] });
  let n = 0;
  for await (const m of q) { n += 1; console.log("[diag] msg", m.type, m.subtype ?? ""); }
  console.log("[diag] completed, messages =", n);
} catch (e) {
  console.log("[diag] threw at", new Date().toISOString(), ":", e?.telemetryMessage ?? e?.message);
}
console.log("[diag] end", new Date().toISOString());
