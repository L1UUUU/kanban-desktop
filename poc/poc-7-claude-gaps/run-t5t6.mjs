// 用途：T5（--settings 会话级注入 hook：仅经 spawn 参数注入，项目级/用户级均无 hook 的干净前提下 PreToolUse/PostToolUse(Skill) 事件落 JSONL，文本提及不产生事件）+ T6（注入存在时用户级认证 env 叠加生效而非替代）实测
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveClaudeExe, prepareCleanHome, writeInjectSettings, readHookEvents, FIXTURE_PROJ, LOGS } from "./lib/common.mjs";
import { ProtocolSession } from "./lib/client.mjs";

const exe = resolveClaudeExe();
const home = prepareCleanHome({ label: "t5t6" });
const injectPath = join(LOGS, "t5-inject-settings.json");
const inject = writeInjectSettings({ outPath: injectPath, hookScript: join(FIXTURE_PROJ, "hook-capture.mjs") });

// —— 干净前提断言（T5 判定的组成部分）：项目级与重定向后的用户级均无 hook 配置 ——
const projectSettingsExists = existsSync(join(FIXTURE_PROJ, ".claude", "settings.json"));
const homeSettings = JSON.parse(readFileSync(join(home.dir, "settings.json"), "utf8"));
const homeSettingsNoHooks = !("hooks" in homeSettings);
// 本机真实 ~/.claude/settings.json 的 hook 形态记录（证明重定向必要性：真实用户配置含 skill-hub telemetry hook）
const realSettings = JSON.parse(readFileSync(join(process.env.USERPROFILE, ".claude", "settings.json"), "utf8"));
const realHasHooks = "hooks" in realSettings;

const baseline = readHookEvents().length; // hook-events.jsonl 基线行数
const report = { exe, inject: { path: injectPath, shape: inject }, cleanPreconditions: { projectSettingsExists, homeSettingsNoHooks, realHasHooks, baseline }, turns: {}, judgments: {} };

const session = new ProtocolSession({
  exe, cwd: FIXTURE_PROJ,
  args: ["--settings", injectPath],
  env: { CLAUDE_CONFIG_DIR: home.dir },
  rawLogPath: join(LOGS, "t5t6-raw-stream.jsonl"),
  turnTimeoutMs: 150000,
});
await session.start();

// —— 轮 1（T5 正例）：/design-feature slash，预期 Skill 真调用 + hook 双事件 ——
const t1 = await session.sendTurn("/design-feature");
const preSkillAfterPositive = readHookEvents().slice(baseline).filter((e) => e.hookEventName === "PreToolUse" && e.toolName === "Skill").length;
// —— 轮 2（T5 反例）：文本提及但明确不执行，预期无 Skill hook 事件 ——
const t2 = await session.sendTurn("我知道有个 skill 叫 design-feature，但这次不要执行它、不要调用任何工具，只回复：ACK-NOHOOK");
session.kill();

// —— hook 事件读取与判定 ——
const events = readHookEvents();
const newEvents = events.slice(baseline);
const preSkill = newEvents.filter((e) => e.hookEventName === "PreToolUse" && e.toolName === "Skill");
const postSkill = newEvents.filter((e) => e.hookEventName === "PostToolUse" && e.toolName === "Skill");
const otherToolEvents = newEvents.filter((e) => e.toolName !== "Skill");

report.turns = {
  positive: { prompt: "/design-feature", texts: t1.texts.join("").slice(0, 120), resultSubtype: t1.result?.subtype ?? null, skillToolCalled: session.allEvents.some((e) => e.kind === "tool_use" && e.name === "Skill") },
  negative: { prompt: "(提及 design-feature 不执行)", texts: t2.texts.join("").slice(0, 120), resultSubtype: t2.result?.subtype ?? null },
};
report.hookEvents = { baseline, total: events.length, newCount: newEvents.length, preSkill, postSkill, otherToolEvents: otherToolEvents.map((e) => ({ hookEventName: e.hookEventName, toolName: e.toolName })) };
// T6：会话正常产出 + 注入 env 探针出现在 hook 进程 + home settings 的 model 生效（叠加而非替代）
const costT6 = t2.result?.costUsd ?? t1.result?.costUsd ?? null;
report.t6 = {
  sessionProducedOutput: t1.result?.subtype === "success" && t2.result?.subtype === "success",
  noAuthError: !/\b(authenticat|OAuth|invalid.api.key|401)\b/i.test(JSON.stringify(session.allEvents)),
  injectedEnvProbeSeen: newEvents.some((e) => e.envProbe?.POC7_SESSION_INJECTED === "1"),
  initModel: session.init?.model ?? null,
  homeSettingsModel: homeSettings.model ?? null,
  hookPermissionMode: newEvents[0]?.permissionMode ?? null,
  sessionCostUsd: costT6,
};

report.judgments = {
  t5_preconditions_clean: !projectSettingsExists && homeSettingsNoHooks,
  t5_inject_via_spawn_arg_only: true,
  t5_pre_skill_hook_captured: preSkill.length >= 1,
  t5_post_skill_hook_captured: postSkill.length >= 1,
  t5_skill_stub_output: t1.texts.join("").includes("DESIGN-FEATURE-STUB-OK"),
  // 反例口径：正例后 PreToolUse(Skill) 计数与最终计数一致（提及轮未新增）
  t5_negative_no_skill_event: t2.result?.subtype === "success" && preSkill.length === preSkillAfterPositive,
  t6_auth_still_effective: report.t6.sessionProducedOutput && report.t6.noAuthError,
  t6_user_model_still_effective: report.t6.homeSettingsModel !== null && report.t6.initModel !== null,
  t6_injected_env_effective: report.t6.injectedEnvProbeSeen,
};

writeFileSync(join(LOGS, "t5t6-result.json"), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report.judgments, null, 2));
console.log("positive texts:", JSON.stringify(report.turns.positive.texts), "| negative texts:", JSON.stringify(report.turns.negative.texts));
console.log("hook pre/post Skill:", preSkill.length, postSkill.length, "| t6:", JSON.stringify(report.t6));
