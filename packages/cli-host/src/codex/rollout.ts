// 用途：Codex 原生 rollout 落盘（~/.codex/sessions/**.jsonl，thread.path 指向）解析 —— readTranscript 双视角的完整数据源（#28；0.144.1 实测：thread/read 归档剥离 commandExecution 工具条目，rollout 文件含全部事件）
import type { TranscriptEvent } from "@kanban/ipc-schema";

/**
 * rollout 行 → user/assistant 双视角事件（#28 / spec #27 B 节）。
 * 事件口径（按真实 rollout 行序，探针 2026-11-06 / codex 0.144.1 实证）：
 * - event_msg.user_message → user 事件（用户发言原文；response_item 里 role=user 会混入 developer/环境注入行，不用）
 * - event_msg.agent_message → assistant 文本事件（commentary/final_answer 两阶段均在场）
 * - response_item.custom_tool_call → assistant 工具事件（name + input 脚本摘要）
 * - response_item.function_call → assistant 工具事件（MCP 等，name + arguments）
 * 其余行（session_meta、turn_context、token_count、task_* 系列、工具输出、reasoning 等）不映射。
 */
export function parseRolloutTranscript(content: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (const line of lines) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = rec.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload.type !== "string") continue;
    if (rec.type === "event_msg" && payload.type === "user_message" && typeof payload.message === "string" && payload.message.length > 0) {
      events.push({ role: "user", text: payload.message });
      continue;
    }
    if (rec.type === "event_msg" && payload.type === "agent_message" && typeof payload.message === "string" && payload.message.length > 0) {
      events.push({ role: "assistant", text: payload.message });
      continue;
    }
    if (rec.type === "response_item" && payload.type === "custom_tool_call" && typeof payload.name === "string") {
      events.push({
        role: "assistant",
        text: "",
        tool: { name: payload.name, summary: typeof payload.input === "string" ? payload.input : safeJson(payload.input) },
      });
      continue;
    }
    if (rec.type === "response_item" && payload.type === "function_call" && typeof payload.name === "string") {
      events.push({
        role: "assistant",
        text: "",
        tool: { name: payload.name, summary: typeof payload.arguments === "string" ? payload.arguments : safeJson(payload.arguments) },
      });
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
