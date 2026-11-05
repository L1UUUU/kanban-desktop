// 用途：Claude Code stream-json 最小会话客户端（自 poc-7 lib/client.mjs 演进精简）—— spawn 直连 claude.exe、initialize 握手、单轮 turn、优雅收尾（stdin 关闭自然退出）
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolveClaudeExe } from "./exe-paths.mjs";

export class ClaudeSession {
  constructor({ cwd, env = {}, args = [], log = () => {} } = {}) {
    this.cwd = cwd;
    this.env = env;
    this.args = args;
    this.log = log;
    this.pendingControl = {};
    this.currentTurn = null;
    this.init = null;
    this.exited = null;
  }

  start() {
    const base = ["-p", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--include-partial-messages"];
    this.child = spawn(resolveClaudeExe(), [...base, ...this.args], {
      cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, ...this.env },
    });
    let buf = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (d) => {
      let idx;
      buf += d;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) { try { this.handle(JSON.parse(line)); } catch { /* 忽略非 JSON 行 */ } }
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d) => this.log("stderr", d.trimEnd().slice(0, 200)));
    this.child.on("exit", (code) => { this.exited = code; this.currentTurn?.settle("process_exit", null); });
    // initialize 握手
    return new Promise((resolve, reject) => {
      const initId = randomUUID();
      const timer = setTimeout(() => { reject(new Error("initialize timeout")); this.kill(); }, 60000);
      this.pendingControl[initId] = (resp) => {
        clearTimeout(timer);
        if (resp.response?.subtype !== "success") { reject(new Error(`initialize failed: ${JSON.stringify(resp).slice(0, 200)}`)); return; }
        resolve(true);
      };
      this.send({ request_id: initId, type: "control_request", request: { subtype: "initialize", options: {} } });
    });
  }

  get pid() { return this.child?.pid ?? null; }
  get alive() { return !!this.child && this.child.exitCode === null; }

  send(obj) {
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  handle(msg) {
    const respId = msg.request_id ?? msg.response?.request_id;
    if (msg.type === "control_response" && respId && this.pendingControl[respId]) {
      const fn = this.pendingControl[respId];
      delete this.pendingControl[respId];
      fn(msg);
      return;
    }
    if (msg.type === "control_request") { this.log("control_request_from_cli", msg.request?.subtype); return; } // 本 PoC 不触发审批
    if (msg.type === "system" && msg.subtype === "init") { this.init = msg; return; }
    if (msg.type === "result") {
      this.lastResult = { subtype: msg.subtype, is_error: msg.is_error, sessionId: msg.session_id, resultText: String(msg.result ?? "").slice(0, 300), costUsd: msg.total_cost_usd };
      this.currentTurn?.settle("result", this.lastResult);
    }
  }

  // 发一轮用户消息，等待 result
  sendTurn(text, { timeoutMs = 120000 } = {}) {
    return new Promise((resolve) => {
      const turn = { done: false, result: null, texts: [], settle(cause, r) { if (this.done) return; this.done = true; this.endedBy = cause; this.result = r; resolve(this); } };
      this.currentTurn = turn;
      const timer = setTimeout(() => turn.settle("timeout", null), timeoutMs);
      const orig = turn.settle.bind(turn);
      turn.settle = (c, r) => { clearTimeout(timer); orig(c, r); };
      this.send({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null });
    });
  }

  // 优雅收尾：关闭 stdin，CLI 处理完即自然退出；返回退出码
  gracefulEnd({ waitMs = 15000 } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const fin = (code) => { if (done) return; done = true; clearTimeout(timer); resolve(code); };
      const timer = setTimeout(() => { try { this.child.kill(); } catch { /* ignore */ } setTimeout(() => fin(-1), 2000); }, waitMs);
      this.child.on("exit", (code) => fin(code));
      try { this.child.stdin.end(); } catch { /* 已关闭 */ }
    });
  }

  kill() {
    try { this.child.stdin.end(); } catch { /* ignore */ }
    try { this.child.kill(); } catch { /* ignore */ }
  }
}
