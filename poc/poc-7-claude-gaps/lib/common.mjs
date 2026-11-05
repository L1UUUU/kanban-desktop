// 用途：PoC 7 公共设施 —— 解析真实 claude.exe、生成干净 CLAUDE_CONFIG_DIR（仅含从真实用户 settings 提取的 env 认证，无 hooks），保证 T5 的「项目与用户级均无 hook 配置」干净前提
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..");
export const FIXTURE_PROJ = join(ROOT, "fixture", "proj");
export const LOGS = join(ROOT, "logs");
export const HOOK_EVENTS = join(FIXTURE_PROJ, "hook-events.jsonl");

// 解析真实 claude.exe（npm 全局包内 bin/claude.exe；编程 spawn 直连可执行文件，不经 shell/.cmd shim）
export function resolveClaudeExe() {
  if (process.env.POC7_CLAUDE_EXE && existsSync(process.env.POC7_CLAUDE_EXE)) return process.env.POC7_CLAUDE_EXE;
  const npmRoot = execFileSync("npm.cmd", ["root", "-g"], { encoding: "utf8", shell: true }).trim();
  const exe = join(npmRoot, "@anthropic-ai", "claude-code", "bin", "claude.exe");
  if (!existsSync(exe)) throw new Error(`claude.exe not found at ${exe}`);
  return exe;
}

// 生成干净配置目录：settings.json 仅保留真实用户 settings 的 env（认证/网关）+ model，显式丢弃 hooks/permissions/skillOverrides/enabledPlugins/statusLine 等
// 说明：本机真实 ~/.claude/settings.json 自带 skill-hub telemetry 等 hook，不满足 T5 干净前提且绝不能改动用户文件；
//       用 CLAUDE_CONFIG_DIR 重定向到本函数生成的目录，等价于「用户级 settings 只提供认证 env」的目标形态（T6 的叠加基座）
export function prepareCleanHome({ label, keepEnv = true } = {}) {
  const dir = join(LOGS, `home-${label}`);
  mkdirSync(dir, { recursive: true });
  const real = JSON.parse(readFileSync(join(process.env.USERPROFILE, ".claude", "settings.json"), "utf8"));
  const clean = keepEnv ? { env: real.env, model: real.model } : { model: real.model };
  writeFileSync(join(dir, "settings.json"), JSON.stringify(clean, null, 2) + "\n", "utf8");
  return { dir, hasHooks: "hooks" in clean, keys: Object.keys(clean) };
}

// 生成 T5 的会话级注入 settings 文件（含 hook 配置 + 一个 env 探针，验证注入 settings 的 env 也参与合并）
export function writeInjectSettings({ outPath, hookScript }) {
  const inject = {
    env: { POC7_SESSION_INJECTED: "1" },
    hooks: {
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: `node "${hookScript}"`, timeout: 15 }] },
      ],
      PostToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: `node "${hookScript}"`, timeout: 15 }] },
      ],
    },
  };
  writeFileSync(outPath, JSON.stringify(inject, null, 2) + "\n", "utf8");
  return inject;
}

// 读 hook-events.jsonl 全部记录（无文件返回空数组）
export function readHookEvents() {
  if (!existsSync(HOOK_EVENTS)) return [];
  return readFileSync(HOOK_EVENTS, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}
