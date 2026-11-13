// 用途：Codex 原生 rollout 落盘（~/.codex/sessions/**.jsonl，thread.path 指向）解析 —— readTranscript 双视角的完整数据源（#28；thread/read 归档剥离 commandExecution 工具条目，rollout 文件含全部事件）
import type { TranscriptEvent } from "@kanban/ipc-schema";

/**
 * rollout 行 → user/assistant 双视角事件（#28 / spec #27 B 节；#97 起双版本口径）。
 * 文本事件源按文件级格式判定（探针 2026-11-06 / codex 0.144.1 与 2026-11-13 / codex 0.167.0 实证）：
 *
 * 旧格式（0.144.1，文件含 event_msg.user_message/agent_message）：
 * - event_msg.user_message → user 事件（用户发言原文；response_item 里 role=user 会混入 developer/环境注入行，不用）
 * - event_msg.agent_message → assistant 文本事件（commentary/final_answer 两阶段均在场）
 *
 * 新格式（0.167.0 起，user_message/agent_message 行消失）：
 * - event_msg.item_completed(item.type=UserMessage) → user 事件（真实用户输入的唯一可靠锚点；
 *   response_item.message(role=user) 混入 AGENTS.md/环境注入行，不用）
 * - response_item.message(role=assistant) → assistant 文本事件（commentary/final_answer 两阶段均在场；
 *   response_item.agent_message 是 codex 内部多代理通信，非用户可见，不映射）
 *
 * 工具事件两版本同形：
 * - response_item.custom_tool_call → assistant 工具事件（name + input 脚本摘要）
 * - response_item.function_call → assistant 工具事件（MCP 等，name + arguments）
 * 其余行（session_meta、turn_context、world_state、token_count、task_* 系列、工具输出、reasoning 等）不映射。
 */
export function parseRolloutTranscript(content: string): TranscriptEvent[] {
  const records = parseLines(content);
  // 格式判定：旧格式以 event_msg 文本行为标志；同一文件只会是一种格式（随创建时的 CLI 版本定死）
  const legacyText = records.some(
    ({ rec, payload }) => rec.type === "event_msg" && (payload.type === "user_message" || payload.type === "agent_message"),
  );
  const events: TranscriptEvent[] = [];
  for (const { rec, payload } of records) {
    if (legacyText) {
      if (rec.type === "event_msg" && payload.type === "user_message" && typeof payload.message === "string" && payload.message.length > 0) {
        events.push({ role: "user", text: payload.message });
        continue;
      }
      if (rec.type === "event_msg" && payload.type === "agent_message" && typeof payload.message === "string" && payload.message.length > 0) {
        events.push({ role: "assistant", text: payload.message });
        continue;
      }
    } else {
      if (rec.type === "event_msg" && payload.type === "item_completed") {
        const item = payload.item as Record<string, unknown> | undefined;
        const text = joinContentText(item?.content);
        if (item?.type === "UserMessage" && text.length > 0) {
          events.push({ role: "user", text });
          continue;
        }
      }
      if (rec.type === "response_item" && payload.type === "message" && payload.role === "assistant") {
        const text = joinContentText(payload.content);
        if (text.length > 0) {
          events.push({ role: "assistant", text });
          continue;
        }
      }
    }
    pushToolEvent(events, rec.type, payload);
  }
  return events;
}

/** 工具事件（两版本 payload 同形）：response_item 的 custom_tool_call / function_call → assistant 工具条目 */
function pushToolEvent(events: TranscriptEvent[], recType: unknown, payload: Record<string, unknown>): void {
  if (recType !== "response_item") return;
  if (payload.type === "custom_tool_call" && typeof payload.name === "string") {
    events.push({
      role: "assistant",
      text: "",
      tool: { name: payload.name, summary: typeof payload.input === "string" ? payload.input : safeJson(payload.input) },
    });
  } else if (payload.type === "function_call" && typeof payload.name === "string") {
    events.push({
      role: "assistant",
      text: "",
      tool: { name: payload.name, summary: typeof payload.arguments === "string" ? payload.arguments : safeJson(payload.arguments) },
    });
  }
}

/** 解析非空 JSON 行为 {rec, payload}（payload.type 非 string 的行跳过，与旧实现口径一致） */
function parseLines(content: string): Array<{ rec: Record<string, unknown>; payload: Record<string, unknown> }> {
  const out: Array<{ rec: Record<string, unknown>; payload: Record<string, unknown> }> = [];
  for (const line of content.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = rec.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload.type !== "string") continue;
    out.push({ rec, payload });
  }
  return out;
}

/** content 数组文本拼接（input_text/output_text/Text 条目取 text 字段；encrypted_content 等无 text 条目跳过） */
function joinContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
      text += (part as Record<string, unknown>).text as string;
    }
  }
  return text;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}
