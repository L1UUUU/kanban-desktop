// 用途：解析三个 CLI 的真实 .exe 路径与版本（spawn 直连目标，不经 .cmd shim）；全部经 npm root -g 动态探测 + 环境变量覆盖，不硬编码绝对路径
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// win32 下 npm 是 .cmd，经 ComSpec 执行避免 shell:true+args 的转义告警
function npmRootGlobal() {
  if (process.platform === "win32") {
    return execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm root -g"], { encoding: "utf8" }).trim();
  }
  return execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
}

// codex：npm shim 是 node 脚本（bin/codex.js），其按平台解析真实原生 exe（vendored codex.exe）
function resolveCodexExe() {
  if (process.env.T0_CODEX_BIN) return process.env.T0_CODEX_BIN;
  const root = npmRootGlobal();
  const exe = path.join(root, "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
  if (!existsSync(exe)) throw new Error(`codex.exe not found at ${exe}（可用 T0_CODEX_BIN 覆盖）`);
  return exe;
}

// claude：npm shim 直接指向包内原生 exe（bin/claude.exe，无 node 中间层）
function resolveClaudeExe() {
  if (process.env.T0_CLAUDE_BIN) return process.env.T0_CLAUDE_BIN;
  const root = npmRootGlobal();
  const exe = path.join(root, "@anthropic-ai", "claude-code", "bin", "claude.exe");
  if (!existsSync(exe)) throw new Error(`claude.exe not found at ${exe}（可用 T0_CLAUDE_BIN 覆盖）`);
  return exe;
}

// opencode：优先 npm 全局原生 exe（与 PoC 3 同源 1.19.5）；备选安装器版本（Local Programs，1.15.7）
function resolveOpencodeExe() {
  if (process.env.T0_OPENCODE_BIN) return process.env.T0_OPENCODE_BIN;
  const root = npmRootGlobal();
  const npmExe = path.join(root, "opencode-ai", "bin", "opencode.exe");
  if (existsSync(npmExe)) return npmExe;
  const local = path.join(process.env.LOCALAPPDATA || "", "Programs", "opencode", "opencode.exe");
  if (existsSync(local)) return local;
  throw new Error(`opencode.exe not found（尝试 ${npmExe} 与 ${local}；可用 T0_OPENCODE_BIN 覆盖）`);
}

function versionOf(exe) {
  try {
    return execFileSync(exe, ["--version"], { encoding: "utf8" }).trim();
  } catch (e) {
    return `unknown(${e.message.slice(0, 80)})`;
  }
}

// 一次解析全部（含版本记录，供 RESULT.md 引用）
export function resolveAllClis() {
  const codex = resolveCodexExe();
  const claude = resolveClaudeExe();
  const opencode = resolveOpencodeExe();
  return { codex, claude, opencode, versions: { codex: versionOf(codex), claude: versionOf(claude), opencode: versionOf(opencode) } };
}

export { resolveCodexExe, resolveClaudeExe, resolveOpencodeExe, npmRootGlobal };
