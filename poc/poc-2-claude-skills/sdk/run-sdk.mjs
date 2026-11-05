// 用途：用 Claude Agent SDK 发起会话触发 /design-feature，验证 SDK 消息流、进程内 hook 回调与外部 settings hook 的一致性
import { query } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixture", "proj");

// SDK 进程内 hook 回调捕获（与 fixture settings.json 的外部脚本 hook 双路对照）
const sdkHookEvents = [];
const streamSummary = [];

const q = query("/design-feature", {
  cwd: FIXTURE,
  permissionMode: "default",
  settingSources: ["user", "project", "local"],
  // 禁掉调查类工具，让模型唯一有意义的动作是调用 Skill 工具
  disallowedTools: ["Bash", "Read", "Glob", "Grep", "PowerShell", "ToolSearch", "WebFetch", "WebSearch", "NotebookEdit"],
  stderr: (data) => {
    process.stderr.write("[cli-stderr] " + data);
  },
  hooks: {
    PreToolUse: [
      {
        matcher: "*",
        hooks: [
          async (input) => {
            sdkHookEvents.push({ event: "PreToolUse", tool: input.tool_name, toolInput: input.tool_input, capturedAt: new Date().toISOString() });
            return {};
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "*",
        hooks: [
          async (input) => {
            sdkHookEvents.push({ event: "PostToolUse", tool: input.tool_name, toolInput: input.tool_input, capturedAt: new Date().toISOString() });
            return {};
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          async (input) => {
            sdkHookEvents.push({ event: "UserPromptSubmit", prompt: input.prompt, capturedAt: new Date().toISOString() });
            return {};
          },
        ],
      },
    ],
  },
});

let sessionId = null;
for await (const msg of q) {
  if (msg.type === "system" && msg.subtype === "init") {
    sessionId = msg.session_id;
    streamSummary.push({ kind: "init", skills: (msg.skills ?? []).filter((s) => /design|implement/.test(s)), permissionMode: msg.permissionMode, cliVersion: msg.claude_code_version });
  } else if (msg.type === "assistant" && msg.message) {
    for (const c of msg.message.content ?? []) {
      if (c.type === "tool_use") streamSummary.push({ kind: "tool_use", name: c.name, input: c.input });
      else if (c.type === "text" && c.text?.trim()) streamSummary.push({ kind: "text", text: c.text.slice(0, 200) });
    }
  } else if (msg.type === "result") {
    streamSummary.push({ kind: "result", subtype: msg.subtype, isError: msg.is_error, costUsd: msg.total_cost_usd, result: String(msg.result ?? "").slice(0, 200) });
  }
}

const out = { sessionId, cli: "claude-agent-sdk", streamSummary, sdkHookEvents };
writeFileSync(join(here, "..", "runs", "b1-sdk-slash-events.json"), JSON.stringify(out, null, 2), "utf8");
console.log(JSON.stringify(out, null, 2));
