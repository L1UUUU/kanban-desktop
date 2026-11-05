// 用途：Claude Code stream-json 持久双向会话客户端（演进自 poc-2 protocol-client.mjs）——单进程多轮、interrupt 控制请求、CLI→host 控制请求（can_use_tool 审批）应答、原始流落盘取证
// wire 依据：poc-2 已验证 initialize/user 行协议；control_response 响应形状取自本机 claude-agent-sdk@0.3.318 源码（response.subtype=success + response.request_id + response.response 载荷）
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";

// 一个持久协议会话；事件经 onEvent 回调外送，原始 stdout 行写 rawLog
export class ProtocolSession {
  constructor({ exe, cwd, env = {}, args = [], rawLogPath, onControlRequest, turnTimeoutMs = 180000 }) {
    this.exe = exe;
    this.cwd = cwd;
    this.env = env;
    this.args = args;
    this.onControlRequest = onControlRequest ?? null;
    this.turnTimeoutMs = turnTimeoutMs;
    this.raw = rawLogPath ? createWriteStream(rawLogPath, { flags: "w" }) : null;
    this.init = null; // system/init 消息
    this.pendingControl = {}; // request_id -> resolver（我们发出的控制请求）
    this.currentTurn = null; // 进行中的轮次记录
    this.controlRequestsFromCli = []; // CLI 发来的全部控制请求（审批等）
    this.allEvents = []; // 归一化事件流水（证据）
  }

  start() {
    return new Promise((resolve, reject) => {
      const base = ["-p", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--include-partial-messages"];
      this.child = spawn(this.exe, [...base, ...this.args], {
        cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false, env: { ...process.env, ...this.env },
      });
      let buf = "";
      let settled = false;
      this.child.stdout.setEncoding("utf8");
      this.child.stdout.on("data", (d) => {
        buf += d;
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          this.raw?.write(line + "\n");
          let msg;
          try { msg = JSON.parse(line); } catch { this.allEvents.push({ kind: "unparseable", line: line.slice(0, 200) }); continue; }
          this.handle(msg);
        }
      });
      this.child.stderr.setEncoding("utf8");
      this.child.stderr.on("data", (d) => { this.allEvents.push({ kind: "stderr", text: d.slice(0, 500) }); process.stderr.write("[cli-stderr] " + d); });
      this.child.on("exit", (code) => {
        this.allEvents.push({ kind: "process_exit", code });
        if (!settled) { settled = true; reject(new Error(`cli exited before initialize, code=${code}`)); }
        this.currentTurn?.settle("process_exit", null);
      });
      this.child.on("error", (e) => { settled = true; reject(e); });
      // initialize 握手（等待 control_response）
      const initId = randomUUID();
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error("initialize handshake timeout")); this.kill(); } }, 90000);
      this.pendingControl[initId] = (resp) => {
        clearTimeout(timer);
        if (resp.response?.subtype !== "success") { settled = true; reject(new Error(`initialize failed: ${JSON.stringify(resp).slice(0, 300)}`)); return; }
        // control_response 可能先于 system/init 消息到达：轮询等待 init（session id 等字段以 init 为准）
        const waitInit = setInterval(() => {
          if (this.init) { clearInterval(waitInit); settled = true; resolve(this.init); }
        }, 20);
        setTimeout(() => { clearInterval(waitInit); if (!settled) { settled = true; resolve(null); } }, 10000).unref();
      };
      this.send({ request_id: initId, type: "control_request", request: { subtype: "initialize", options: {} } });
    });
  }

  handle(msg) {
    // 1) 我们发出的控制请求的响应
    const respId = msg.request_id ?? msg.response?.request_id;
    if (msg.type === "control_response" && respId && this.pendingControl[respId]) {
      this.pendingControl[respId](msg);
      delete this.pendingControl[respId];
      return;
    }
    // 2) CLI 发来的控制请求（审批 can_use_tool 等）——交回调决定响应；无回调则不响应（T3 由脚本显式控制）
    if (msg.type === "control_request") {
      this.controlRequestsFromCli.push(msg);
      this.allEvents.push({ kind: "control_request_from_cli", subtype: msg.request?.subtype, tool_name: msg.request?.tool_name, request_id: msg.request_id });
      this.onControlRequest?.(msg, this);
      return;
    }
    // 3) 会话生命周期
    if (msg.type === "system" && msg.subtype === "init") {
      this.init = msg;
      this.allEvents.push({ kind: "init", session_id: msg.session_id, cliVersion: msg.claude_code_version, permissionMode: msg.permissionMode, model: msg.model, cwd: msg.cwd, skills: (msg.skills ?? []).map((s) => s.name ?? s) });
      return;
    }
    if (msg.type === "assistant" && msg.message) {
      for (const c of msg.message.content ?? []) {
        if (c.type === "tool_use") this.allEvents.push({ kind: "tool_use", name: c.name, input: c.input, ts: new Date().toISOString() });
        else if (c.type === "text" && c.text?.trim()) this.currentTurn?.texts.push(c.text);
      }
      return;
    }
    if (msg.type === "user" && Array.isArray(msg.message?.content)) {
      for (const it of msg.message.content) {
        if (it.type === "tool_result") this.allEvents.push({ kind: "tool_result", tool_use_id: it.tool_use_id, is_error: it.is_error ?? false, content: String(JSON.stringify(it.content ?? "")).slice(0, 400) });
      }
      return;
    }
    // 4) 增量 delta（--include-partial-messages）：记录到当前轮，供 T2 观察 interrupt 后输出是否停止
    if (msg.type === "stream_event" && msg.event?.type === "content_block_delta" && msg.event.delta?.type === "text_delta") {
      this.currentTurn?.deltas.push({ ts: new Date().toISOString(), text: msg.event.delta.text });
      return;
    }
    // 5) 轮次终止
    if (msg.type === "result") {
      const rec = { kind: "result", subtype: msg.subtype, is_error: msg.is_error, num_turns: msg.num_turns, costUsd: msg.total_cost_usd, result: String(msg.result ?? "").slice(0, 300), durationMs: msg.duration_ms };
      this.allEvents.push(rec);
      this.currentTurn?.settle("result", msg);
    }
  }

  send(obj) {
    const line = JSON.stringify(obj) + "\n";
    this.raw?.write(JSON.stringify({ __sent: obj }) + "\n");
    this.child.stdin.write(line);
  }

  // 发一轮用户消息，返回该轮记录（promise 在 result 到达、进程退出或超时后落定）
  sendTurn(text, { timeoutMs = this.turnTimeoutMs } = {}) {
    return new Promise((resolve) => {
      const turn = {
        prompt: text, sentAt: new Date().toISOString(),
        texts: [], deltas: [], toolUses: [], result: null, endedBy: null,
        settle(cause, resultMsg) { if (this.done) return; this.done = true; this.endedBy = cause; this.result = resultMsg ? { subtype: resultMsg.subtype, is_error: resultMsg.is_error, num_turns: resultMsg.num_turns, costUsd: resultMsg.total_cost_usd, resultText: String(resultMsg.result ?? "").slice(0, 300), durationMs: resultMsg.duration_ms, sessionId: resultMsg.session_id ?? null } : null; resolve(this); },
        done: false,
      };
      this.currentTurn = turn;
      const timer = setTimeout(() => turn.settle("timeout", null), timeoutMs);
      const origSettle = turn.settle.bind(turn);
      turn.settle = (cause, r) => { clearTimeout(timer); origSettle(cause, r); };
      this.send({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null });
    });
  }

  // 发 interrupt 控制请求并等待 CLI 的 control_response（确认中断被接受）
  interrupt({ waitMs = 15000 } = {}) {
    return new Promise((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => { delete this.pendingControl[id]; resolve({ acknowledged: false, reason: "timeout" }); }, waitMs);
      this.pendingControl[id] = (resp) => { clearTimeout(timer); resolve({ acknowledged: resp.response?.subtype === "success", raw: resp }); };
      this.interruptSentAt = new Date().toISOString();
      this.send({ request_id: id, type: "control_request", request: { subtype: "interrupt" } });
    });
  }

  // 按已验证的 SDK wire 形状回 control_response（decision = {behavior:'allow'|'deny', ...}）
  respondToControlRequest(requestId, decision) {
    this.send({ type: "control_response", response: { subtype: "success", request_id: requestId, response: decision } });
    this.allEvents.push({ kind: "control_response_sent", request_id: requestId, decision });
  }

  // 优雅收尾：关闭 stdin 让 CLI 自然退出（T4 需要「进程正常退出」语义），超时强杀；resolve 退出码
  gracefulEnd({ waitMs = 30000 } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const fin = (code) => { if (done) return; done = true; clearTimeout(timer); this.raw?.end(); resolve(code); };
      const timer = setTimeout(() => { this.child.kill(); setTimeout(() => fin(-1), 2000); }, waitMs);
      this.child.on("exit", (code) => fin(code));
      try { this.child.stdin.end(); } catch { /* 已关闭 */ }
    });
  }

  kill() {
    try { this.child.stdin.end(); } catch { /* 已关闭 */ }
    try { this.child.kill(); } catch { /* 已退出 */ }
    setTimeout(() => this.raw?.end(), 300).unref();
  }
}
