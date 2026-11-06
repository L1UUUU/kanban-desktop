// 用途：Claude 原生 transcript（会话 jsonl）定位与解析 —— 断开会话「读取原生历史」的直读数据源（poc-7 T4 场景：--resume 不换 id，transcript 跨进程延续）+ readTranscript 双视角解析（#28）
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ChatEventSeed, TranscriptEvent } from "@kanban/ipc-schema";

/** cwd → projects 子目录名（claude 的路径 munge：盘符冒号/分隔符/空格 → "-"；失配时由目录扫描兜底） */
function mungeCwd(cwd: string): string {
  return cwd.replace(/[:\\ /]/g, "-");
}

/** 定位 native 会话的 transcript 文件：候选 munge 目录 → projects 全目录按文件名精确扫描；找不到返回 null */
export function findTranscriptFile(nativeSessionId: string, cwd: string): string | null {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
  const projectsDir = path.join(configDir, "projects");
  const candidate = path.join(projectsDir, mungeCwd(cwd), `${nativeSessionId}.jsonl`);
  if (existsSync(candidate)) return candidate;
  try {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const hit = path.join(projectsDir, entry.name, `${nativeSessionId}.jsonl`);
      if (existsSync(hit)) return hit;
    }
  } catch {
    /* projects 目录不存在 */
  }
  return null;
}

/** 回填历史的一个条目：dedupeKeys 与实时流同键空间（msg:<itemId>:<partId> / tool:<itemId>） */
export interface TranscriptItem {
  dedupeKeys: string[];
  seeds: Array<{ seed: ChatEventSeed; at: string }>;
}

/** transcript 行 → 回填条目序列（用户字符串行分轮；跳过 sidechain；Skill 观察信号不回放——当时已实时入 tracker，重放会双计） */
export function parseTranscriptItems(content: string): { at: string; items: TranscriptItem[] }[] {
  const turns: { at: string; items: TranscriptItem[] }[] = [];
  let current: { at: string; items: TranscriptItem[] } | null = null;
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (const line of lines) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec.isSidechain === true) continue;
    const at = typeof rec.timestamp === "string" ? rec.timestamp : new Date().toISOString();
    const message = rec.message as { role?: string; content?: unknown } | undefined;
    if (rec.type === "user" && message) {
      if (typeof message.content === "string") {
        current = { at, items: [] }; // 用户文本行 = 新一轮
        turns.push(current);
        continue;
      }
      // 数组形态用户行：含 text 块 = 新一轮（claude 2.1.317 起用户输入也写为 text 块数组）；
      // 仅 tool_result 的数组行不另起轮（在既有轮内补对应工具条目的完成态）
      if (Array.isArray(message.content)) {
        const blocks = message.content as Record<string, unknown>[];
        const hasText = blocks.some((b) => b.type === "text" && typeof b.text === "string" && b.text.length > 0);
        if (hasText) {
          current = { at, items: [] };
          turns.push(current);
          continue;
        }
        if (current) {
          for (const it of blocks) {
            if (it.type !== "tool_result" || typeof it.tool_use_id !== "string") continue;
            const key = `tool:${it.tool_use_id}`;
            const owner = current.items.find((x) => x.dedupeKeys.includes(key));
            if (owner && !owner.seeds.some((s) => s.seed.type === "tool_completed")) {
              owner.seeds.push({
                seed: {
                  type: "tool_completed",
                  itemId: it.tool_use_id,
                  status: "completed",
                  durationMs: 0,
                  output: flattenContent(it.content),
                },
                at,
              });
            }
          }
        }
      }
      continue;
    }
    if (rec.type !== "assistant" || !message || !Array.isArray(message.content) || !current) continue;
    const msgId = typeof (rec as { messageId?: unknown }).messageId === "string"
      ? String((rec as { messageId?: unknown }).messageId)
      : typeof (message as { id?: unknown }).id === "string"
        ? String((message as { id?: unknown }).id)
        : `msg-${turns.length}-${current.items.length}`;
    const blocks = message.content as Record<string, unknown>[];
    blocks.forEach((block, index) => {
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        current!.items.push({
          dedupeKeys: [`msg:${msgId}:${index}`],
          seeds: [
            { seed: { type: "message_delta", itemId: msgId, partId: String(index), delta: block.text }, at },
            { seed: { type: "message_completed", itemId: msgId, partId: String(index) }, at },
          ],
        });
      } else if (block.type === "tool_use" && typeof block.id === "string") {
        current!.items.push({
          dedupeKeys: [`tool:${block.id}`],
          seeds: [
            {
              seed: {
                type: "tool_started",
                itemId: block.id,
                tool: String(block.name ?? "tool"),
                argsSummary: safeJson(block.input),
              },
              at,
            },
          ],
        });
      }
    });
  }
  return turns;
}

/** tool_result content（字符串或 text 块数组）→ 纯文本 */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Record<string, unknown>[])
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .join("");
  }
  return "";
}

/**
 * transcript 行 → readTranscript 双视角事件（#28 / spec #27 B 节）。
 * 与 parseTranscriptItems（readHistory 回填）的关键差异：user 文本行不再仅作轮边界丢弃，
 * 而是产出 { role:"user" } 事件（提取管线「目标/要求」的来源）；tool_use 产出带工具标注的 assistant 事件。
 * 跳过 sidechain、tool_result-only 用户行（非用户发言）与空文本。
 */
export function parseTranscriptEvents(content: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (const line of lines) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec.isSidechain === true) continue;
    const message = rec.message as { role?: string; content?: unknown } | undefined;
    if (!message) continue;
    // 用户行：string 直出；数组取 text 块拼接（仅 tool_result 的行不是用户发言，跳过）
    if (rec.type === "user") {
      let text = "";
      if (typeof message.content === "string") text = message.content;
      else if (Array.isArray(message.content)) {
        text = (message.content as Record<string, unknown>[])
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("");
      }
      if (text.length > 0) events.push({ role: "user", text });
      continue;
    }
    if (rec.type !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content as Record<string, unknown>[]) {
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        events.push({ role: "assistant", text: block.text });
      } else if (block.type === "tool_use" && typeof block.id === "string") {
        events.push({
          role: "assistant",
          text: "",
          tool: { name: String(block.name ?? "tool"), summary: safeJson(block.input) },
        });
      }
    }
  }
  return events;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}
