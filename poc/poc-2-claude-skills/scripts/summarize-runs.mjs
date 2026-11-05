// 用途：把 runs 下的大体积 stream-json 原始输出压缩为关键事件摘要（供 RESULT 引用），控制仓库体积
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const RUNS = join(here, "..", "runs");

// 需要摘要后删除原始文件的轮次（>300KB）
const BIG = ["a1-cli-slash-native.jsonl", "a1-cli-slash-stdin.jsonl", "a2-cli-slash-clean.jsonl", "a4-cli-implementspec.jsonl"];

for (const f of BIG) {
  const p = join(RUNS, f);
  if (!existsSync(p)) continue;
  const lines = readFileSync(p, "utf8").trim().split("\n");
  const summary = { file: f, events: [] };
  for (const l of lines) {
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    if (j.type === "system" && j.subtype === "init") {
      summary.events.push({ kind: "init", session_id: j.session_id, cwd: j.cwd, permissionMode: j.permissionMode, cliVersion: j.claude_code_version, skills: (j.skills ?? []).filter((s) => /design-feature|implement-spec/.test(s)) });
    } else if (j.type === "assistant" && j.message) {
      for (const c of j.message.content ?? []) {
        if (c.type === "tool_use") summary.events.push({ kind: "tool_use", name: c.name, input: c.input });
        else if (c.type === "text" && c.text?.trim()) summary.events.push({ kind: "assistant_text", text: c.text.slice(0, 200) });
      }
    } else if (j.type === "user" && Array.isArray(j.message?.content)) {
      for (const it of j.message.content) {
        if (it.type === "text") summary.events.push({ kind: "skill_expansion_or_user", text: it.text.slice(0, 200) });
      }
    } else if (j.type === "result") {
      summary.events.push({ kind: "result", subtype: j.subtype, isError: j.is_error, costUsd: j.total_cost_usd, result: String(j.result ?? "").slice(0, 200) });
    }
  }
  writeFileSync(join(RUNS, f.replace(".jsonl", "-summary.json")), JSON.stringify(summary, null, 2), "utf8");
  unlinkSync(p);
  console.log("已摘要:", f, "->", summary.events.length, "个关键事件");
}
