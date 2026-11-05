// Claude Code 原生历史读取：解析 ~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl 为归一化事件（只读，绝不写入用户目录）。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeProjectDirName } from "./normalize.mjs";

export class MissingHistoryError extends Error {
  constructor(sessionId, detail) {
    super(`历史不可读：claude session ${sessionId} — ${detail}`);
    this.name = "MissingHistoryError";
    this.sessionId = sessionId;
    this.cli = "claude";
  }
}

// 计算 claude 原生历史文件路径
export function claudeHistoryFile(cwd, sessionId) {
  return path.join(
    os.homedir(),
    ".claude",
    "projects",
    claudeProjectDirName(cwd),
    `${sessionId}.jsonl`,
  );
}

// 文件级指纹（sha256 + size + mtimeMs），用于提取前后隔离性对比
export function fileFingerprint(file) {
  const buf = readFileSync(file);
  const st = statOf(file);
  return {
    file,
    sha256: createHash("sha256").update(buf).digest("hex"),
    size: buf.length,
    mtimeMs: st ? st.mtimeMs : null,
  };
}

function statOf(file) {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

// 读取并归一化一个 claude session 的原生历史；文件不存在时抛 MissingHistoryError
export function readClaudeHistory({ cwd, sessionId }) {
  const file = claudeHistoryFile(cwd, sessionId);
  if (!existsSync(file)) {
    throw new MissingHistoryError(sessionId, `原生历史文件不存在: ${file}`);
  }
  const events = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // 跳过损坏行
    }
    if (rec.isSidechain) continue; // 子链（skill 内部执行）不进入需求主线
    if (rec.type === "user" && rec.message) {
      const text = extractContentText(rec.message.content);
      if (!text) continue;
      if (/^<(command-name|local-command|bash-input)/.test(text.trim())) continue; // slash 命令回显等噪音
      events.push({ sessionId, cli: "claude", role: "user", text, ts: rec.timestamp || "" });
    } else if (rec.type === "assistant" && rec.message) {
      const text = extractContentText(rec.message.content);
      if (!text) continue; // 纯工具调用行无 text
      events.push({ sessionId, cli: "claude", role: "assistant", text, ts: rec.timestamp || "" });
    }
  }
  return events;
}

// message.content 兼容 string / [{type:"text",text}] 两种形态，只取用户可见文本
function extractContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n")
      .trim();
  }
  return "";
}
