// 用途：debug 变体 —— debug:true 让 CLI 自写排障输出到 stderr，抓子进程秒退的退出原因
import { query } from "@anthropic-ai/claude-agent-sdk";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const t0 = Date.now();
const stderrAll = [];
try {
  const q = query("Reply with exactly: DEBUG-OK", {
    cwd: join(here, "fixture", "proj"),
    settingSources: ["user"],
    debug: true,
    stderr: (d) => { stderrAll.push(String(d)); },
  });
  let n = 0;
  for await (const m of q) { n += 1; }
  console.log(`[debug] COMPLETED ${Date.now() - t0}ms msgs=${n}`);
} catch (e) {
  console.log(`[debug] THREW ${Date.now() - t0}ms: ${e?.telemetryMessage ?? e?.message}`);
}
const text = stderrAll.join("");
console.log(`[debug] stderr ${text.length} bytes:`);
console.log(text.slice(-3000));
