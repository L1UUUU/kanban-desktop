// 用途：OpenCode Adapter —— 以 XDG 隔离 fixture 启动 opencode serve（provider 从用户全局 opencode.json 只读复制注入，密钥不落日志），经 POST /session/:id/command 真实执行项目级阶段 skill，并返回可观察信号（同步 HTTP + SSE turn 终态 + 文本），供构造 self_reported 事件（注入模式复制自 poc-3 已验证实现）
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const OC_FIXTURE = join(here, "..", "fixture", "opencode");
export const OC_CFG_DIR = join(OC_FIXTURE, "config");
export const OC_DATA_DIR = join(OC_FIXTURE, "data");
export const OC_WORKDIR = join(OC_FIXTURE, "workdir");

// 模型：magpie 的 modelID 自带斜杠（192-168-4-61-3000/asw_glm-5.3），provider/model 按第一个斜杠切分（poc-3 结论）
export const OC_MODEL = process.env.OC_MODEL || "magpie/192-168-4-61-3000/asw_glm-5.3";
const [PROV_ID, ...MODEL_REST] = OC_MODEL.split("/");

const PORT = Number(process.env.OC_PORT || 40104);
const BASE = `http://127.0.0.1:${PORT}`;
const TURN_TIMEOUT = Number(process.env.OC_TURN_TIMEOUT || 150000);

let cachedExe;
// 解析真实 opencode.exe（npm 全局包内 bin，避免 .cmd shim）
export function resolveOpencodeCommand() {
  if (cachedExe) return cachedExe;
  if (process.env.OC_BIN && existsSync(process.env.OC_BIN)) return (cachedExe = process.env.OC_BIN);
  try {
    const isWin = process.platform === "win32";
    const npmRoot = execFileSync(isWin ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8", shell: isWin }).trim();
    const exe = join(npmRoot, "opencode-ai", "bin", isWin ? "opencode.exe" : "opencode");
    if (existsSync(exe)) return (cachedExe = exe);
  } catch { /* 继续回退 */ }
  return (cachedExe = "opencode");
}

// 写隔离全局配置：provider（含 apiKey）从用户全局 opencode.json 只读复制注入；密钥不进日志、不进 dump
function writeIsolatedConfig() {
  const globalPath = join(process.env.HOME || process.env.USERPROFILE, ".config", "opencode", "opencode.json");
  const globalCfg = JSON.parse(readFileSync(globalPath, "utf8"));
  const prov = globalCfg.provider?.[PROV_ID];
  if (!prov) throw new Error(`provider ${PROV_ID} not found in global opencode.json (read-only check)`);
  const cfg = { $schema: "https://opencode.ai/config.json", provider: { [PROV_ID]: prov } };
  mkdirSync(join(OC_CFG_DIR, "opencode"), { recursive: true });
  writeFileSync(join(OC_CFG_DIR, "opencode", "opencode.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return { providerId: PROV_ID, modelCount: Object.keys(prov.models || {}).length, hasApiKey: !!(prov.apiKey ?? prov.options?.apiKey) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, ok: res.ok, json, text };
}

// opencode server 宿主：XDG_* 全部重定向到 fixture 内（隔离用户全局配置与数据，poc-3 已验证模式）
export class OpencodeServer {
  constructor() {
    this.proc = null;
    this.events = []; // SSE 事件（不含密钥，config 不在事件流中）
    this.handlers = [];
    this.abortCtl = null;
  }

  async start() {
    const injected = writeIsolatedConfig();
    mkdirSync(OC_DATA_DIR, { recursive: true });
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: OC_CFG_DIR,
      XDG_DATA_HOME: OC_DATA_DIR,
      XDG_STATE_HOME: join(OC_DATA_DIR, "state"),
      XDG_CACHE_HOME: join(OC_DATA_DIR, "cache"),
    };
    delete env.OPENCODE_CONFIG;
    delete env.OPENCODE_CONFIG_CONTENT;
    // 参数与 poc-3 已验证用法完全一致（--log-level 仅接受 DEBUG 等全量值；DEBUG 日志量大，stderr 只计数不回显）
    this.proc = spawn(resolveOpencodeCommand(), ["serve", "--port", String(PORT), "--hostname", "127.0.0.1", "--print-logs", "--log-level", "DEBUG"], {
      cwd: OC_WORKDIR, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", () => { this.stderrLines = (this.stderrLines ?? 0) + 1; });
    await this.waitUp();
    await this.connectEvents();
    return injected;
  }

  async waitHttp(path, timeoutMs = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const r = await fetch(`${BASE}${path}`);
        if (r.ok) return r;
      } catch { /* not up */ }
      await sleep(400);
    }
    throw new Error(`opencode server not reachable on ${BASE}${path} within ${timeoutMs}ms`);
  }

  async waitUp() { await this.waitHttp("/config"); }

  // 订阅全局 SSE 事件流（GET /event），解析 data 帧并回调（poc-3 结论：turn 终态以 session.idle 为准）
  async connectEvents() {
    const ctl = new AbortController();
    this.abortCtl = ctl;
    const res = await fetch(`${BASE}/event`, { signal: ctl.signal });
    if (!res.ok) throw new Error(`/event HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLines = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
            if (!dataLines.length) continue;
            let ev;
            try { ev = JSON.parse(dataLines.join("\n")); } catch { continue; }
            if (ev.type === "server.connected") continue;
            this.events.push({ t: Date.now(), ...ev });
            for (const h of this.handlers) h(ev);
          }
        }
      } catch { /* stream closed */ }
    })();
    await sleep(300); // 首帧缓冲
  }

  on(fn) { this.handlers.push(fn); }

  // 等 turn 终态：session.idle / session.error，或 assistant message status 终值（poc-3 校准结论）
  waitTurnDone(sessionID, timeoutMs = TURN_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.handlers = this.handlers.filter((h) => h !== on); reject(new Error(`opencode turn timeout after ${timeoutMs}ms for ${sessionID}`)); }, timeoutMs);
      let lastErr = null;
      let assistantDone = null;
      const on = (ev) => {
        const p = ev.properties || {};
        if (p.sessionID !== sessionID) return;
        if (ev.type === "session.error") lastErr = p.error;
        if (ev.type === "message.updated" && p.info?.role === "assistant" && ["completed", "errored", "canceled"].includes(p.info.status)) assistantDone = p.info.status;
        if (ev.type === "session.idle" || assistantDone) {
          clearTimeout(timer);
          this.handlers = this.handlers.filter((h) => h !== on);
          resolve({ status: assistantDone || (lastErr ? "errored" : "completed"), error: lastErr });
        }
      };
      this.on(on);
    });
  }

  // 收集该 session 的 text part 快照（part 为全量快照，取最后一次拼接）
  collectText(sessionID) {
    const parts = new Map();
    this.on((ev) => {
      if (ev.type === "message.part.updated" && ev.properties.sessionID === sessionID && ev.properties.part) {
        const p = ev.properties.part;
        parts.set(`${p.messageID}:${p.id}`, p);
      }
    });
    return () => [...parts.values()].filter((p) => p.type === "text").map((p) => p.text).join("");
  }

  stop() {
    try { this.abortCtl?.abort(); } catch { /* closed */ }
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill(); } catch { /* ignore */ }
    }
  }
}

// 真实执行一次阶段 skill command：发现校验 → 建 session → POST command → 等 turn 终态
// 返回 {sessionId, command, httpStatus, turnStatus, text, commandAt}；commandAt 为提交时刻（skill 实际发生时间）
export async function runSkillCommand(srv, { command, expectText, title }) {
  // 1) command 发现校验（零模型调用）
  const list = await api("GET", "/command");
  const cmds = list.json?.items || list.json || [];
  const found = cmds.find((c) => c.name === command);
  // 2) 原生 session
  const s = await api("POST", "/session", { title: title ?? `poc4-${command}` });
  if (!s.ok) throw new Error(`create session failed: ${s.status} ${s.text?.slice(0, 120)}`);
  const sessionId = s.json.id;
  // 3) 提交 command（可观察信号 1：同步 HTTP 结果）；commandAt 即 skill 实际发生时间
  const getText = srv.collectText(sessionId);
  const done = srv.waitTurnDone(sessionId);
  const commandAt = new Date().toISOString();
  const r = await api("POST", `/session/${sessionId}/command`, { command, arguments: "{}", model: OC_MODEL });
  // 4) 等待模型真实执行完成（可观察信号 2：turn 终态）
  const info = await done;
  await sleep(300);
  const text = getText();
  return {
    sessionId, command, discovered: !!found, source: found?.source ?? null,
    httpStatus: r.status, turnStatus: info.status, turnError: info.error ?? null,
    text, commandAt,
    textMatched: expectText ? text.includes(expectText) : null,
  };
}

// 清理运行数据目录（可重复复现；config 注入文件保留由 start 重建）
export function resetDataDir() {
  rmSync(join(OC_DATA_DIR), { recursive: true, force: true });
  mkdirSync(OC_DATA_DIR, { recursive: true });
}
