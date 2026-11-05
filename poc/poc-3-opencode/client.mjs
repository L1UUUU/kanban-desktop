// PoC 3 统一驱动客户端：以隔离配置启动 opencode server，按 PoC 1 矩阵执行聊天/工具/审批/取消/并发/恢复/异常测试
import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync, mkdirSync, readFileSync, existsSync, rmSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(ROOT, 'fixture');
const WORKDIR = path.join(FIXTURE, 'workdir');
const CFG_DIR = path.join(FIXTURE, 'config');
const DATA_DIR = path.join(FIXTURE, 'data');
const LOGS = path.join(ROOT, 'logs');
const PID_FILE = path.join(LOGS, 'server.pid');
const PORT = Number(process.env.OC_PORT || 40101);
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = process.env.OC_MODEL || 'openai/gpt-5.4-mini-fast';
const EXE = process.env.OC_BIN || 'C:\\Users\\liuy\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe';
const TURN_TIMEOUT = Number(process.env.OC_TURN_TIMEOUT || 120000);

mkdirSync(LOGS, { recursive: true });
mkdirSync(WORKDIR, { recursive: true });

// ---------- 日志工具 ----------
const logName = (process.env.OC_LOG || 'client');
const logFile = path.join(LOGS, `${logName}.log`);
function log(line) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ${line}`;
  console.log(msg);
  appendFileSync(logFile, msg + '\n', 'utf8');
}
function dump(name, obj) {
  writeFileSync(path.join(LOGS, name), JSON.stringify(obj, null, 2), 'utf8');
}

// ---------- server 进程管理 ----------
// XDG_* 全部重定向到 fixture 内，隔离用户全局 ~/.config/opencode 与 ~/.local/share/opencode
function serverEnv() {
  const env = { ...process.env };
  env.XDG_CONFIG_HOME = CFG_DIR;
  env.XDG_DATA_HOME = DATA_DIR;
  env.XDG_STATE_HOME = path.join(DATA_DIR, 'state');
  env.XDG_CACHE_HOME = path.join(DATA_DIR, 'cache');
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_CONTENT;
  // 与用户全局 opencode-proxy.cmd 一致：经本地代理访问 OpenAI（OC_PROXY=off 可关闭）
  if (process.env.OC_PROXY !== 'off') {
    env.HTTPS_PROXY = 'http://127.0.0.1:7897';
    env.HTTP_PROXY = 'http://127.0.0.1:7897';
    env.NO_PROXY = 'localhost,127.0.0.1';
  }
  return env;
}
// 按模式写隔离全局配置：default = 无 permission 设置；ask = bash/edit 显式 "ask"
function writeConfig(mode) {
  const cfg = { $schema: 'https://opencode.ai/config.json' };
  if (mode === 'ask') cfg.permission = { bash: 'ask', edit: 'ask' };
  writeFileSync(path.join(CFG_DIR, 'opencode', 'opencode.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  log(`config written mode=${mode}: ${JSON.stringify(cfg)}`);
}
async function waitHttpOk(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/config`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`server not reachable on ${BASE} within ${timeoutMs}ms`);
}
function startServer(mode) {
  if (existsSync(PID_FILE)) { console.error('server.pid exists; run stop-server first'); process.exit(2); }
  writeConfig(mode);
  const fd = openSync(path.join(LOGS, 'server.log'), 'a');
  const child = spawn(EXE, ['serve', '--port', String(PORT), '--hostname', '127.0.0.1', '--print-logs', '--log-level', 'DEBUG'], {
    cwd: WORKDIR,
    env: serverEnv(),
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid), 'utf8');
  log(`server spawned mode=${mode} pid=${child.pid} cwd=${WORKDIR}`);
}
function readPid() { return Number(readFileSync(PID_FILE, 'utf8').trim()); }
async function stopServer(force = false) {
  if (!existsSync(PID_FILE)) { console.log('no pid file'); return; }
  const pid = readPid();
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    log(`server pid=${pid} ${force ? 'SIGKILL' : 'SIGTERM'} sent`);
  } catch (e) {
    log(`server pid=${pid} kill failed: ${e.message}`);
  }
  await sleep(1500);
  rmSync(PID_FILE, { force: true });
}

// ---------- SSE 事件订阅 ----------
class EventClient {
  constructor() { this.events = []; this.handlers = []; this.abort = null; this.connected = false; }
  on(fn) { this.handlers.push(fn); return this; }
  // 订阅全局事件流 GET /event，解析 SSE data 行并回调
  async connect() {
    const ctl = new AbortController();
    this.abort = ctl;
    const res = await fetch(`${BASE}/event`, { signal: ctl.signal });
    if (!res.ok) throw new Error(`/event HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const dataLines = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
            if (!dataLines.length) continue;
            const raw = dataLines.join('\n');
            let ev; try { ev = JSON.parse(raw); } catch { continue; }
            if (ev.type === 'server.connected') { this.connected = true; log(`SSE server.connected: ${JSON.stringify(ev.properties)}`); }
            else {
              this.events.push({ t: Date.now(), ...ev });
              for (const h of this.handlers) h(ev, this.events);
            }
          }
        }
      } catch { /* stream closed */ }
    })();
    // 等到 server.connected 确认链路建立
    const t0 = Date.now();
    while (!this.connected && Date.now() - t0 < 10000) await sleep(100);
    if (!this.connected) throw new Error('SSE not connected in 10s');
    return this;
  }
  close() { try { this.abort.abort(); } catch { /* already closed */ } }
}

// ---------- HTTP API 封装 ----------
async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, ok: res.ok, json, text };
}
async function createSession(title) {
  const r = await api('POST', '/session', { title });
  if (!r.ok) throw new Error(`create session failed: ${r.status} ${r.text}`);
  return r.json;
}
async function promptAsync(sessionID, text) {
  const r = await api('POST', `/session/${sessionID}/prompt_async`, {
    model: { providerID: 'openai', modelID: MODEL.split('/')[1] },
    parts: [{ type: 'text', text }],
  });
  return r;
}

// ---------- 等待工具 ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 等待某 session 的 turn 到达终态：以 session.idle / session.error / assistant status 为准
// （实测 1.19.5：message.updated 的 info 不含 status 字段，可靠终态信号是 session.idle）
function waitTurnDone(ec, sessionID, timeoutMs = TURN_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ec.handlers = ec.handlers.filter(h => h !== on); reject(new Error(`turn timeout after ${timeoutMs}ms for ${sessionID}`)); }, timeoutMs);
    let lastErr = null; let assistantDone = null;
    const on = (ev) => {
      const p = ev.properties || {};
      if (p.sessionID !== sessionID) return;
      if (ev.type === 'session.error') lastErr = p.error;
      if (ev.type === 'message.updated' && p.info?.role === 'assistant' && ['completed', 'errored', 'canceled'].includes(p.info.status)) assistantDone = p.info.status;
      if (ev.type === 'session.idle' || assistantDone) {
        clearTimeout(timer); ec.handlers = ec.handlers.filter(h => h !== on);
        resolve({ status: assistantDone || (lastErr ? 'errored' : 'completed'), error: lastErr });
      }
    };
    ec.on(on);
  });
}
// 收集 session 相关的文本/工具 part 快照，用于校验流式与工具事件
function collectParts(ec, sessionID) {
  const parts = new Map();
  ec.on((ev) => {
    if (ev.type === 'message.part.updated' && ev.properties.info?.sessionID === sessionID && ev.properties.part) {
      const p = ev.properties.part;
      const key = `${p.messageID}:${p.id}`;
      parts.set(key, p);
    }
    if (ev.type === 'message.part.removed' && ev.properties.part) {
      const p = ev.properties.part;
      parts.delete(`${p.messageID}:${p.id}`);
    }
  });
  return parts;
}
// 等待下一次 permission 事件（含 permissionID），可指定等待时长
function waitPermission(ec, timeoutMs = TURN_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setTimeout(() => { ec.handlers = ec.handlers.filter(h => h !== on); reject(new Error(`no permission event in ${timeoutMs}ms`)); }, timeoutMs);
    const on = (ev) => {
      if (ev.type === 'permission') {
        clearTimeout(timer); ec.handlers = ec.handlers.filter(h => h !== on);
        resolve(ev.properties);
      }
    };
    ec.on(on);
  });
}
// assistant 最终文本（从 parts 快照取 text part 拼接）
function assistantText(parts) {
  return [...parts.values()].filter(p => p.type === 'text').map(p => p.text).join('');
}
// 工具调用摘要（名称/输入/输出/状态）
function toolParts(parts) {
  return [...parts.values()].filter(p => p.type === 'tool').map(p => ({
    tool: p.tool,
    state: p.state?.status,
    input: p.state?.input,
    output: typeof p.state?.output === 'string' ? p.state.output.slice(0, 300) : p.state?.output,
    error: p.state?.error,
  }));
}

// ---------- 测试步骤 ----------
const steps = {};

// 步骤：启动/停止 server
steps['start-server'] = async (mode = 'ask') => { startServer(mode); const cfg = await waitHttpOk(); log(`server up, resolved config: ${JSON.stringify(cfg)}`); };
steps['stop-server'] = async () => { await stopServer(false); };
steps['kill-server'] = async () => { await stopServer(true); };

// 关键验证一：默认配置（无 permission 设置）下触发 bash 工具，观察是否出现 permission 事件
steps['perm-default'] = async () => {
  const ec = await new EventClient().connect();
  const s = await createSession('poc3-perm-default');
  log(`session=${s.id}`);
  const parts = collectParts(ec, s.id);
  const done = waitTurnDone(ec, s.id);
  const r = await promptAsync(s.id, '请用 bash 工具执行命令 echo poc3-default 然后原样告诉我输出内容。');
  log(`prompt_async status=${r.status}`);
  const info = await done;
  await sleep(1000);
  const perm = ec.events.find(e => e.type === 'permission') || null;
  log(`turn status=${info.status}`);
  log(`permission event=${perm ? JSON.stringify({ id: perm.properties.id, tool: perm.properties.part?.tool }) : 'NONE (auto-approved)'}`);
  log(`tools=${JSON.stringify(toolParts(parts))}`);
  log(`assistant=${assistantText(parts)}`);
  dump('perm-default.json', { session: s.id, turnStatus: info.status, permissionEvent: perm, tools: toolParts(parts), text: assistantText(parts), events: ec.events });
  ec.close();
};

// 关键验证二 A：bash=ask 配置下触发工具 -> 收到 permission 事件 -> 批准(once) -> 工具执行完成
steps['perm-ask-approve'] = async () => {
  const ec = await new EventClient().connect();
  const s = await createSession('poc3-ask-approve');
  log(`session=${s.id}`);
  const parts = collectParts(ec, s.id);
  const done = waitTurnDone(ec, s.id);
  const perm = await waitPermission(ec);
  log(`permission arrived id=${perm.id} tool=${perm.part?.tool} title=${perm.part?.title}`);
  const resp = await api('POST', `/session/${s.id}/permissions/${perm.id}`, { response: 'once' });
  log(`approve(once) -> HTTP ${resp.status} ${resp.text.slice(0, 200)}`);
  const info = await done;
  await sleep(500);
  log(`turn status=${info.status}`);
  log(`tools=${JSON.stringify(toolParts(parts))}`);
  log(`assistant=${assistantText(parts)}`);
  dump('perm-ask-approve.json', { session: s.id, permission: perm, approveStatus: resp.status, turnStatus: info.status, tools: toolParts(parts), text: assistantText(parts), events: ec.events });
  ec.close();
};

// 关键验证二 B：bash=ask 配置下触发工具 -> 收到 permission 事件 -> 拒绝 -> 观察模型行为
steps['perm-ask-deny'] = async () => {
  const ec = await new EventClient().connect();
  const s = await createSession('poc3-ask-deny');
  log(`session=${s.id}`);
  const parts = collectParts(ec, s.id);
  const done = waitTurnDone(ec, s.id);
  const perm = await waitPermission(ec);
  log(`permission arrived id=${perm.id} tool=${perm.part?.tool}`);
  const resp = await api('POST', `/session/${s.id}/permissions/${perm.id}`, { response: 'reject' });
  log(`reject -> HTTP ${resp.status} ${resp.text.slice(0, 200)}`);
  const info = await done;
  await sleep(500);
  log(`turn status=${info.status}`);
  log(`tools=${JSON.stringify(toolParts(parts))}`);
  log(`assistant=${assistantText(parts)}`);
  dump('perm-ask-deny.json', { session: s.id, permission: perm, rejectStatus: resp.status, turnStatus: info.status, tools: toolParts(parts), text: assistantText(parts), events: ec.events });
  ec.close();
};

// 多轮流式聊天：两轮短消息，校验流式增量（text part 多次更新）与上下文延续（暗号回读）
steps['chat'] = async () => {
  const ec = await new EventClient().connect();
  const s = await createSession('poc3-chat');
  log(`session=${s.id}`);
  // 轮 1：设定暗号
  const parts1 = collectParts(ec, s.id);
  const done1 = waitTurnDone(ec, s.id);
  await promptAsync(s.id, '请记住暗号：蓝鲸42号。只回复：收到。');
  const info1 = await done1; await sleep(300);
  log(`turn1 status=${info1.status} text="${assistantText(parts1)}" textPartUpdates=${ec.events.filter(e => e.type === 'message.part.updated' && e.properties.part?.type === 'text' && e.properties.info?.sessionID === s.id).length}`);
  // 轮 2：回读暗号（验证上下文延续 + 流式）
  const updatesBefore = ec.events.filter(e => e.type === 'message.part.updated' && e.properties.part?.type === 'text' && e.properties.info?.sessionID === s.id).length;
  const done2 = waitTurnDone(ec, s.id);
  await promptAsync(s.id, '暗号是什么？只回答暗号本身。');
  const info2 = await done2; await sleep(300);
  const textUpdates = ec.events.filter(e => e.type === 'message.part.updated' && e.properties.part?.type === 'text' && e.properties.info?.sessionID === s.id).length - updatesBefore;
  log(`turn2 status=${info2.status} text="${assistantText(parts1)}" turn2TextPartUpdates=${textUpdates}`);
  dump('chat.json', { session: s.id, turn1: { status: info1.status, text: assistantText(parts1) }, turn2TextUpdates: textUpdates, events: ec.events });
  writeFileSync(path.join(LOGS, 'chat.session.id'), s.id, 'utf8');
  ec.close();
};

// 取消当前 turn：prompt_async 后立即 abort，校验 turn 进入 canceled 且 session 可继续
steps['cancel'] = async () => {
  const ec = await new EventClient().connect();
  const s = await createSession('poc3-cancel');
  log(`session=${s.id}`);
  const parts = collectParts(ec, s.id);
  const done = waitTurnDone(ec, s.id);
  const r = await promptAsync(s.id, '从 1 数到 20，每个数字一行，不要省略。');
  log(`prompt_async status=${r.status}`);
  await sleep(2500); // 让流式开始产出，再取消
  const ab = await api('POST', `/session/${s.id}/abort`);
  log(`abort -> HTTP ${ab.status}`);
  const info = await done;
  await sleep(300);
  const partial = assistantText(parts);
  log(`turn status=${info.status} partialText="${partial.slice(0, 120)}..."`);
  // 取消后继续同一 session
  const done2 = waitTurnDone(ec, s.id);
  await promptAsync(s.id, '只回复：继续OK。');
  const info2 = await done2; await sleep(300);
  log(`after-cancel turn status=${info2.status} text="${assistantText(parts).slice(-40)}"`);
  dump('cancel.json', { session: s.id, canceledStatus: info.status, partialText: partial, afterCancelStatus: info2.status, events: ec.events });
  ec.close();
};

// 并发：3 个 session 同时 prompt_async，全部完成
steps['concurrent'] = async () => {
  const ec = await new EventClient().connect();
  const sessions = [];
  for (let i = 0; i < 3; i++) {
    const s = await createSession(`poc3-conc-${i}`);
    sessions.push(s);
  }
  log(`sessions=${sessions.map(s => s.id).join(',')}`);
  const dones = sessions.map(s => waitTurnDone(ec, s.id));
  const partsMap = new Map(sessions.map(s => [s.id, collectParts(ec, s.id)]));
  // 第 3 个 session 存暗号，供恢复测试复用
  const prompts = ['只回复：OK1', '只回复：OK2', '请记住暗号：绿豚7号。只回复：已记住。'];
  const t0 = Date.now();
  const rs = await Promise.all(sessions.map((s, i) => promptAsync(s.id, prompts[i])));
  log(`prompt_async statuses=${rs.map(r => r.status).join(',')}`);
  const infos = await Promise.all(dones);
  await sleep(500);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(`all turns done in ${elapsed}s statuses=${infos.map(i => i.status).join(',')}`);
  for (const s of sessions) log(`  ${s.id} -> "${assistantText(partsMap.get(s.id))}"`);
  dump('concurrent.json', { sessions: sessions.map(s => s.id), statuses: infos.map(i => i.status), elapsedSec: Number(elapsed), texts: sessions.map(s => assistantText(partsMap.get(s.id))), events: ec.events });
  writeFileSync(path.join(LOGS, 'concurrent.sessions.json'), JSON.stringify(sessions.map(s => s.id)), 'utf8');
  ec.close();
};

// 恢复：server 已重启后，读取历史 + 继续上下文（问依赖上一轮的暗号）
steps['resume'] = async () => {
  const chatID = readFileSync(path.join(LOGS, 'chat.session.id'), 'utf8').trim();
  const list = await api('GET', '/session');
  const items = list.json?.items || list.json || [];
  log(`session list count=${items.length}`);
  const hist = await api('GET', `/session/${chatID}/message?limit=50`);
  const msgs = hist.json?.items || hist.json || [];
  log(`history msgs for chat=${msgs.length}`);
  // 历史中应能找到暗号相关文本
  const histText = JSON.stringify(msgs);
  const hasSecret = histText.includes('蓝鲸42号');
  log(`history contains secret(蓝鲸42号)=${hasSecret}`);
  // 继续上下文：问上一轮的暗号
  const ec = await new EventClient().connect();
  const parts = collectParts(ec, chatID);
  const done = waitTurnDone(ec, chatID);
  await promptAsync(chatID, '暗号是什么？只回答暗号本身。');
  const info = await done; await sleep(300);
  const text = assistantText(parts);
  log(`resume turn status=${info.status} answer="${text}"`);
  // 并发 session 的暗号也顺带验证历史可读
  const concIDs = JSON.parse(readFileSync(path.join(LOGS, 'concurrent.sessions.json'), 'utf8'));
  const hist2 = await api('GET', `/session/${concIDs[2]}/message?limit=50`);
  const hasSecret2 = JSON.stringify(hist2.json).includes('绿豚7号');
  log(`concurrent session history contains secret(绿豚7号)=${hasSecret2}`);
  dump('resume.json', { chatSession: chatID, historyCount: msgs.length, hasSecretInHistory: hasSecret, resumeAnswer: text, concurrentHistoryHasSecret: hasSecret2, sessionListCount: items.length });
  ec.close();
};

// 异常退出：不重新发 turn，校验客户端在 server 被 kill 后的错误行为（不崩溃、无自动重放）
steps['crash'] = async () => {
  const ec = await new EventClient().connect();
  const s = await createSession('poc3-crash');
  log(`session=${s.id}`);
  // 先做一个轻量请求确认链路正常
  const before = await api('GET', '/session');
  log(`pre-kill GET /session ok=${before.ok} count=${(before.json?.items || before.json || []).length}`);
  // SIGKILL server（= Windows TerminateProcess），观察 SSE 断开与后续请求行为
  await stopServer(true);
  await sleep(1500);
  // 事件流应已断开或停止
  log(`SSE connected flag after kill=${ec.connected}, total events=${ec.events.length}`);
  let afterErr = null;
  try {
    await api('GET', '/session');
  } catch (e) {
    afterErr = `${e.cause?.code || e.cause?.errno || ''} ${e.message}`.trim();
  }
  log(`post-kill GET /session error=${afterErr || '(no error?)'}`);
  // 客户端进程本身仍在运行且未重放任何 prompt（本步骤从未发送模型请求）
  dump('crash.json', { preKillOk: before.ok, sessionCount: (before.json?.items || before.json || []).length, crashSession: s.id, sseConnectedAfterKill: ec.connected, postKillError: afterErr, events: ec.events.length, replayedPrompts: 0 });
  ec.close();
};

// 异常退出数据完整性：kill 后重启 server，校验 session 与历史仍可读（不消耗模型调用）
steps['crash-recover'] = async () => {
  const pre = JSON.parse(readFileSync(path.join(LOGS, 'crash.json'), 'utf8'));
  const list = await api('GET', '/session');
  const items = list.json?.items || list.json || [];
  log(`after kill+restart, session count=${items.length} (pre-kill=${pre.sessionCount})`);
  // 读取 kill 前创建的 crash session 的历史，验证数据未丢
  let historyCount = -1; let historyReadable = false;
  if (pre.crashSession) {
    const hist = await api('GET', `/session/${pre.crashSession}/message?limit=50`);
    const msgs = hist.json?.items || hist.json || [];
    historyCount = msgs.length;
    historyReadable = hist.ok;
    log(`crash session history readable=${historyReadable} msgs=${historyCount}`);
  }
  dump('crash-recover.json', { preKillSessionCount: pre.sessionCount, postKillSessionCount: items.length, crashSessionHistoryReadable: historyReadable, crashSessionHistoryCount: historyCount });
};

// 原生 command：GET /command 发现 + POST /session/:id/command 执行自定义 command
steps['commands'] = async () => {
  const list = await api('GET', '/command');
  const cmds = list.json?.items || list.json || [];
  log(`command count=${cmds.length}`);
  for (const c of cmds) log(`  command: ${c.name} (template len ${String(c.template || '').length})`);
  dump('commands-list.json', cmds);
  // 若预算允许（OC_RUN_COMMAND=1）执行 poc3-hello command
  if (process.env.OC_RUN_COMMAND === '1') {
    const target = cmds.find(c => c.name === 'poc3-hello');
    if (!target) { log('poc3-hello command not found; skip run'); return; }
    const ec = await new EventClient().connect();
    const s = await createSession('poc3-command-run');
    const parts = collectParts(ec, s.id);
    const done = waitTurnDone(ec, s.id);
    const r = await api('POST', `/session/${s.id}/command`, { command: 'poc3-hello' });
    log(`command exec HTTP ${r.status} ${r.text.slice(0, 200)}`);
    const info = await done; await sleep(300);
    log(`command turn status=${info.status} text="${assistantText(parts)}"`);
    dump('command-run.json', { session: s.id, httpStatus: r.status, status: info.status, text: assistantText(parts), events: ec.events });
    ec.close();
  } else {
    log('OC_RUN_COMMAND!=1, command execution skipped (budget control)');
  }
};

// ---------- 入口 ----------
const [step, ...args] = process.argv.slice(2);
if (!step || !steps[step]) {
  console.error(`usage: node client.mjs <${Object.keys(steps).join('|')}> [args]`);
  console.error(`steps: start-server <default|ask> | perm-default | perm-ask-approve | perm-ask-deny | chat | cancel | concurrent | resume | crash | crash-recover | commands | stop-server | kill-server`);
  process.exit(2);
}
steps[step](...args).then(() => { log(`step ${step} DONE`); }).catch(e => { log(`step ${step} FAILED: ${e.stack || e.message}`); process.exitCode = 1; });
