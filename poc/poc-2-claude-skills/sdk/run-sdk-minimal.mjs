// 用途：SDK 最小复现 —— 裸 query 隔离变量，判断 abort 是环境问题还是选项导致
import { query } from "@anthropic-ai/claude-agent-sdk";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixture", "proj");

try {
  const q = query("Reply with exactly: MINIMAL-OK", {
    cwd: FIXTURE,
    stderr: (d) => process.stderr.write("[cli-stderr] " + d),
  });
  for await (const m of q) {
    if (m.type === "system" && m.subtype === "init") console.log("init ok, session=", m.session_id, "version=", m.claude_code_version);
    else if (m.type === "result") console.log("result:", m.subtype, "isError=", m.is_error, "|", String(m.result ?? "").slice(0, 80));
  }
} catch (e) {
  console.error("QUERY FAILED:", e?.telemetryMessage ?? e?.message ?? String(e).slice(0, 300));
  process.exit(1);
}
