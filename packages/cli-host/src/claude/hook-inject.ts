// 用途：Claude 会话级 hook 注入设施（PoC 7 T5/T6 实证形态）—— 每会话临时目录：hook 捕获脚本 + hook-events.jsonl + `--settings` 注入文件（叠加语义：用户级认证 env 不受影响；禁用 --setting-sources）
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * hook 捕获脚本源码（poc-7 fixture/proj/hook-capture.mjs 产品化）：
 * 把 hook 事件（stdin JSON）追加写入脚本同目录的 hook-events.jsonl，字段命名与 tracker transformHookEvents 对齐。
 * 注意：Windows 上同步读管道不可靠，必须异步迭代 stdin（poc-7 实证）。
 */
const HOOK_CAPTURE_SOURCE = `// kanban-desktop 注入的 hook 捕获脚本：hook stdin JSON -> 追加写入同目录 hook-events.jsonl
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "hook-events.jsonl");
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let evt = {};
try { evt = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { evt = { parseError: true }; }
const record = {
  capturedAt: new Date().toISOString(),
  hookEventName: evt.hook_event_name ?? null,
  sessionId: evt.session_id ?? null,
  transcriptPath: evt.transcript_path ?? null,
  toolName: evt.tool_name ?? null,
  toolInput: evt.tool_input ?? null,
  toolResponse: evt.tool_response ?? null,
};
appendFileSync(OUT, JSON.stringify(record) + "\\n", "utf8");
process.exit(0);
`;

/**
 * 解析 hook 命令使用的 node 可执行：优先显式覆盖（KANBAN_CLAUDE_HOOK_NODE / options），
 * process.execPath 是 node（cli-host 在 vitest/纯 node 下运行）时直接用绝对路径，
 * 否则回退 PATH 上的 "node"（poc-7 同款命令形态，本机实证可用）。
 * shortcut: Electron utilityProcess 下 process.execPath 是 electron.exe（不能直接跑 .mjs），
 * 依赖 PATH 有 node；复查触发条件：打包版（无系统 node 的机器）hook 不产事件时，改为随应用分发 node 或改用 BAT/JS 方案。
 */
export function resolveHookNodeBin(override?: string | null): string {
  if (override && existsSync(override)) return override;
  if (process.env.KANBAN_CLAUDE_HOOK_NODE && existsSync(process.env.KANBAN_CLAUDE_HOOK_NODE)) {
    return process.env.KANBAN_CLAUDE_HOOK_NODE;
  }
  const exec = process.execPath;
  const base = path.basename(exec).toLowerCase();
  if (base === "node" || base === "node.exe") return exec;
  return "node";
}

/**
 * 权限档 ask（请求）的严格工具配置：permissions.ask 规则强制弹审批（即便他处允许也问，SDK matchedAskRule 语义）。
 * 覆盖 shell（含 Windows PowerShell 工具——本机实测用户级环境下被自动放行，E1-E5 隔离实验）与文件写类（default 档应问但以 ask 规则兜底确保「请求=全部先问」）。
 */
const STRICT_ASK_TOOLS = [
  "Bash",
  "PowerShell",
  "Write",
  "Edit",
  "NotebookEdit",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "Skill",
  "TodoWrite",
  "ListAgents",
  "ToolSearch",
  "Workflow",
  "Monitor",
];

/** 会话 hook 目录布局：<base>/<sessionId>/{hook-capture.mjs, hook-events.jsonl, settings.json} */
export interface SessionHookFiles {
  dir: string;
  scriptPath: string;
  eventsPath: string;
  settingsPath: string;
}

/** 建会话 hook 目录并写入捕获脚本（幂等；UTF-8 无 BOM） */
export function prepareSessionHookDir(baseDir: string, sessionId: string): SessionHookFiles {
  const dir = path.join(baseDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, "hook-capture.mjs");
  writeFileSync(scriptPath, HOOK_CAPTURE_SOURCE, "utf8");
  return {
    dir,
    scriptPath,
    eventsPath: path.join(dir, "hook-events.jsonl"),
    settingsPath: path.join(dir, "settings.json"),
  };
}

/** 写 `--settings` 注入文件：PreToolUse/PostToolUse(Skill) hook（叠加语义）+ ask 档严格工具配置 */
export function writeSessionSettings(
  files: SessionHookFiles,
  options: { nodeBin: string; strictAsk?: boolean },
): string {
  const hookCommand = `"${options.nodeBin}" "${files.scriptPath}"`;
  const settings: Record<string, unknown> = {
    hooks: {
      PreToolUse: [{ matcher: "Skill", hooks: [{ type: "command", command: hookCommand, timeout: 15 }] }],
      PostToolUse: [{ matcher: "Skill", hooks: [{ type: "command", command: hookCommand, timeout: 15 }] }],
    },
  };
  if (options.strictAsk) {
    settings.permissions = { ask: [...STRICT_ASK_TOOLS] };
  }
  writeFileSync(files.settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return files.settingsPath;
}

/** 增量读取 JSONL 新行（按字节偏移 tail；文件不存在返回空） */
export function tailJsonl(file: string, offset: number): { lines: string[]; offset: number } {
  if (!existsSync(file)) return { lines: [], offset };
  const size = statSync(file).size;
  if (size <= offset) return { lines: [], offset };
  const buf = readFileSync(file);
  const chunk = buf.subarray(offset).toString("utf8");
  // 末行可能不完整（hook 进程写到一半）：只消费到最后一个换行，剩余字节下轮再读
  const lastNewline = chunk.lastIndexOf("\n");
  if (lastNewline === -1) return { lines: [], offset };
  const consumed = chunk.slice(0, lastNewline);
  const newOffset = offset + Buffer.byteLength(consumed, "utf8");
  const lines = consumed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return { lines, offset: newOffset };
}
