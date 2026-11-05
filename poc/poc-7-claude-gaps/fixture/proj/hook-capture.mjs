// 用途：PoC 7 hook 捕获脚本（形态复制 poc-2）——把 hook 事件 JSON 追加写入 hook-events.jsonl，另记录注入 settings 的 env 探针（POC7_SESSION_INJECTED）供 T6 合并行为取证
// 注意：Windows 上同步 readSync(fd0) 读管道不可靠，必须用异步迭代读 stdin
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 输出文件固定在脚本同目录，不依赖 hook 执行时的 cwd
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "hook-events.jsonl");

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString("utf8");
let evt = {};
try {
  evt = JSON.parse(raw);
} catch {
  evt = { parseError: true, raw };
}

// capturedAt 是排序用本地时间戳；envProbe 验证注入 settings 的 env 是否生效（T6）；其余字段均来自 CLI stdin 原文
const record = {
  capturedAt: new Date().toISOString(),
  capturePid: process.pid,
  envProbe: { POC7_SESSION_INJECTED: process.env.POC7_SESSION_INJECTED ?? null },
  hookEventName: evt.hook_event_name ?? null,
  sessionId: evt.session_id ?? null,
  transcriptPath: evt.transcript_path ?? null,
  cwd: evt.cwd ?? null,
  permissionMode: evt.permission_mode ?? null,
  toolName: evt.tool_name ?? null,
  toolInput: evt.tool_input ?? null,
  toolResponse: evt.tool_response ?? null,
  prompt: evt.prompt ?? null,
};

appendFileSync(OUT, JSON.stringify(record) + "\n", "utf8");
process.exit(0);
