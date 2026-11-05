// 用途：端到端回放演示 —— 把 PoC 真实捕获的 hook-events.jsonl 喂给 RequirementTracker，展示自动建卡与反例不误判
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RequirementTracker, transformHookEvents } from "../tracker/tracker.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, "..", "fixture", "proj", "hook-events.jsonl");
const OUT = join(here, "..", "runs", "b2-replay-result.json");

const lines = readFileSync(HOOK, "utf8").trim().split("\n").filter(Boolean);
const rawEvents = lines.map((l) => JSON.parse(l));

// 1) 归一化：PreToolUse(Skill) → verified skill 事件
const events = transformHookEvents(lines);
const sessionsWithSkill = new Set(events.map((e) => e.sessionId));
const allSessions = new Set(rawEvents.filter((e) => e.sessionId).map((e) => e.sessionId));

// 2) 回放进 tracker（保持原始捕获顺序，天然含乱序/并发）
const tr = new RequirementTracker();
const changes = [];
for (const ev of events) changes.push(...tr.process(ev));

const result = {
  hookEventLines: lines.length,
  sessionsObserved: allSessions.size,
  sessionsWithVerifiedSkill: sessionsWithSkill.size,
  verifiedSkillEvents: events.length,
  changes,
  requirements: tr.snapshot(),
  decisions: tr.log,
};
writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");
console.log(JSON.stringify(result, null, 2));
