// 用途：Claude Code hook 捕获脚本 —— 把 hook 事件 JSON（含本地捕获时间）追加写入事件文件，供 PoC 2 观察与回放
// 注意：Windows 上同步 readSync(fd0) 读管道不可靠，必须用异步迭代读 stdin
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 输出文件固定在脚本同目录，不依赖 hook 执行时的 cwd
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "hook-events.jsonl");

// 读取 stdin（Claude Code 把事件 JSON 通过 stdin 传入）
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString("utf8");
let evt = {};
try {
  evt = JSON.parse(raw);
} catch {
  evt = { parseError: true, raw };
}

// capturedAt 是 tracker 排序用的本地时间戳；其余字段均来自 CLI stdin 原文，不改写
const record = {
  capturedAt: new Date().toISOString(),
  capturePid: process.pid,
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
