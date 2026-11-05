// 用途：A/B 判别实验 —— 同一最小 query 在「捆绑 exe+user settings / 全局 exe+user settings / 捆绑 exe+无 settings」三种组合下的行为，定位 SDK Windows 失败层
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixture", "proj");
// 全局 claude.exe（2.1.317，PoC 7 协议直连已实证可用）——APPDATA 派生 npm 全局路径，探测不到则跳过该变体
const GLOBAL_EXE = process.env.APPDATA
  ? join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
  : null;

const globalExe = GLOBAL_EXE && existsSync(GLOBAL_EXE) ? GLOBAL_EXE : null;
const variants = [
  { label: "A-bundled-user-settings", options: { cwd: FIXTURE, settingSources: ["user"] } },
  ...(globalExe ? [{ label: "B-global-exe-user-settings", options: { cwd: FIXTURE, settingSources: ["user"], pathToClaudeCodeExecutable: globalExe } }] : []),
  { label: "C-bundled-no-settings", options: { cwd: FIXTURE, settingSources: [] } },
];

if (process.argv.includes("--list")) { console.log(JSON.stringify({ globalExe }, null, 2)); }

for (const v of variants) {
  const t0 = Date.now();
  let n = 0, resultSubtype = null, resultText = null;
  const stderrLines = [];
  try {
    const q = query("Reply with exactly: DIAG-OK", { ...v.options, stderr: (d) => { stderrLines.push(String(d).slice(0, 200)); } });
    for await (const m of q) {
      n += 1;
      if (m.type === "result") { resultSubtype = m.subtype; resultText = String(m.result ?? "").slice(0, 80); }
    }
    console.log(`[${v.label}] COMPLETED ${Date.now() - t0}ms msgs=${n} result=${resultSubtype} text=${resultText}`);
  } catch (e) {
    console.log(`[${v.label}] THREW ${Date.now() - t0}ms msgs=${n} err=${e?.telemetryMessage ?? e?.message} stderr=${stderrLines.length ? stderrLines.join(" | ").slice(0, 300) : "(empty)"}`);
  }
}
