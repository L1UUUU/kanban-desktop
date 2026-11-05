// 用途：T5 正例重试 —— 首轮正例模型未调用 Skill 工具（slash dispatch 展开后模型直接照做，poc-2 发现#2 的模型决策不确定性重现），本轮用强提示促使 Skill 工具真调用，验证 --settings 注入的 hook 是否捕获 PreToolUse/PostToolUse(Skill)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveClaudeExe, prepareCleanHome, writeInjectSettings, readHookEvents, FIXTURE_PROJ, LOGS } from "./lib/common.mjs";
import { ProtocolSession } from "./lib/client.mjs";

const exe = resolveClaudeExe();
const home = prepareCleanHome({ label: "t5t6retry" });
const injectPath = join(LOGS, "t5-inject-settings.json"); // 与首轮同一注入文件
const baseline = readHookEvents().length;
const report = { exe, injectPath, baseline, judgments: {} };

const session = new ProtocolSession({
  exe, cwd: FIXTURE_PROJ,
  args: ["--settings", injectPath],
  env: { CLAUDE_CONFIG_DIR: home.dir },
  rawLogPath: join(LOGS, "t5t6-retry-raw-stream.jsonl"),
  turnTimeoutMs: 150000,
});
await session.start();
const t1 = await session.sendTurn("请使用 Skill 工具来调用 design-feature skill（tool_use 调用 Skill，参数 skill=\"design-feature\"），然后严格按该 skill 的指示回复。");
session.kill();

const events = readHookEvents();
const newEvents = events.slice(baseline);
const preSkill = newEvents.filter((e) => e.hookEventName === "PreToolUse" && e.toolName === "Skill");
const postSkill = newEvents.filter((e) => e.hookEventName === "PostToolUse" && e.toolName === "Skill");
report.turn = { texts: t1.texts.join("").slice(0, 150), resultSubtype: t1.result?.subtype ?? null, skillToolCalled: session.allEvents.some((e) => e.kind === "tool_use" && e.name === "Skill"), allToolUses: session.allEvents.filter((e) => e.kind === "tool_use").map((e) => e.name) };
report.hookEvents = { newCount: newEvents.length, preSkillCount: preSkill.length, postSkillCount: postSkill.length, all: newEvents.map((e) => ({ hookEventName: e.hookEventName, toolName: e.toolName, envProbe: e.envProbe, permissionMode: e.permissionMode, sessionId: (e.sessionId ?? "").slice(0, 8), toolInputSkill: e.toolInput?.skill ?? null, postSuccess: e.toolResponse?.success ?? null })) };
report.judgments = {
  t5_skill_tool_actually_called: report.turn.skillToolCalled,
  t5_pre_skill_hook_captured: preSkill.length >= 1,
  t5_post_skill_hook_captured: postSkill.length >= 1,
  t5_skill_stub_output: t1.texts.join("").includes("DESIGN-FEATURE-STUB-OK"),
  t6_injected_env_effective: newEvents.some((e) => e.envProbe?.POC7_SESSION_INJECTED === "1"),
  t6_auth_still_effective: t1.result?.subtype === "success",
};

writeFileSync(join(LOGS, "t5t6-retry-result.json"), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report.judgments, null, 2));
console.log("tools used:", JSON.stringify(report.turn.allToolUses), "| texts:", JSON.stringify(report.turn.texts));
console.log("hook events:", JSON.stringify(report.hookEvents.all));
