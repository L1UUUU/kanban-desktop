// Codex 原生历史读取：经 app-server thread/read（读磁盘，不 resume、不发 turn）归一化为统一事件模型。
// 客户端类复制自 poc-1（已验证），此处仅做导入复用。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CodexAppServerClient } from "./codex-client.mjs";

export class MissingHistoryError extends Error {
  constructor(sessionId, detail) {
    super(`历史不可读：codex thread ${sessionId} — ${detail}`);
    this.name = "MissingHistoryError";
    this.sessionId = sessionId;
    this.cli = "codex";
  }
}

// 启动临时 app-server 客户端（仅用于 thread/read，读完即 stop）
export async function withCodexReader(log, fn) {
  const c = new CodexAppServerClient({ log: log || (() => {}) });
  c.start();
  try {
    await c.initialize();
    return await fn(c);
  } finally {
    c.stop();
  }
}

// thread/read 读回完整 turns/items 并归一化；threadId 无效时抛 MissingHistoryError
export async function readCodexHistory(c, { threadId }) {
  let res;
  try {
    res = await c.request("thread/read", { threadId, includeTurns: true });
  } catch (e) {
    throw new MissingHistoryError(threadId, `thread/read 失败: ${e.message}`);
  }
  const thread = res.thread || res;
  const turns = thread.turns || [];
  if (turns.length === 0 && !thread.id) {
    throw new MissingHistoryError(threadId, "响应中无 thread/turns");
  }
  const events = [];
  for (const turn of turns) {
    const ts = turn.startedAt || "";
    for (const item of turn.items || []) {
      const ev = normalizeItem(item, threadId, ts);
      if (ev) events.push(ev);
    }
  }
  return { events, threadPath: thread.path || null };
}

// item → 事件；只保留对经验提取有信息量的类型，避免 reasoning 噪音
function normalizeItem(item, threadId, ts) {
  const base = { sessionId: threadId, cli: "codex", ts };
  if (item.type === "userMessage") {
    const text = (item.content || [])
      .filter((c) => c && c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    return text ? { ...base, role: "user", text } : null;
  }
  if (item.type === "agentMessage") {
    return item.text && item.text.trim()
      ? { ...base, role: "assistant", text: item.text.trim() }
      : null;
  }
  if (item.type === "commandExecution") {
    const exit = item.exitCode !== undefined ? ` (exit=${item.exitCode})` : "";
    return { ...base, role: "assistant", text: `[cmd] ${item.command || ""}${exit}` };
  }
  if (item.type === "fileChange") {
    return { ...base, role: "assistant", text: `[file-change] ${item.path || ""} ${item.action || ""}`.trim() };
  }
  return null; // reasoning / webSearch 等跳过
}

// codex rollout 文件指纹（若 thread.path 可得），用于提取前后隔离性对比
export function codexRolloutFingerprint(rolloutPath) {
  if (!rolloutPath) return null;
  try {
    const buf = readFileSync(rolloutPath);
    return {
      file: rolloutPath,
      sha256: createHash("sha256").update(buf).digest("hex"),
      size: buf.length,
    };
  } catch {
    return null;
  }
}
