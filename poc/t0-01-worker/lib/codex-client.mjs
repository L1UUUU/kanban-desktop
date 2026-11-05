// 用途：Codex app-server 最小 JSON-RPC/stdio 客户端（自 poc/poc-1-codex-appserver/client.mjs 演进精简：spawn 直连 vendored codex.exe、LF 分帧、三形状解复用、turn 事件收集）
import { spawn } from "node:child_process";
import { resolveCodexExe } from "./exe-paths.mjs";

export class CodexClient {
  constructor({ cwd, log = () => {}, detached = false } = {}) {
    this.cwd = cwd;
    this.log = log;
    this.detached = detached; // detached=true：宿主死亡后 codex 成孤儿（T4 孤儿场景用）
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map(); // method -> Set<fn>
    this.dead = false;
  }

  start() {
    this.proc = spawn(resolveCodexExe(), ["app-server"], { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: this.detached });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (c) => this._onChunk(c));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (c) => this.log("stderr", c.trimEnd()));
    this.proc.on("exit", (code, signal) => {
      this.dead = true;
      this.exitInfo = { code, signal };
      for (const [, p] of this.pending) p.reject(new Error(`app-server exited: code=${code} signal=${signal}`));
      this.pending.clear();
      this._emit("dead", { code, signal });
    });
    return this;
  }

  get pid() { return this.proc?.pid ?? null; }
  get alive() { return !!this.proc && this.proc.exitCode === null && !this.dead; }

  _onChunk(chunk) {
    this.buf = (this.buf || "") + chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { this.log("parse-error", line.slice(0, 120)); continue; }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.method !== undefined && msg.id !== undefined) {
      // 服务端请求（审批等）——本 PoC 不触发审批，统一回空结果
      this._send({ id: msg.id, result: {} });
    } else if (msg.method !== undefined) {
      this._emit(msg.method, msg.params);
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(`rpc ${msg.error.code}: ${msg.error.message}`)) : p.resolve(msg.result);
    }
  }

  _send(obj) {
    if (this.dead) throw new Error("client is dead");
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this._send({ id, method, params: params ?? {} }); }
      catch (e) { this.pending.delete(id); reject(e); }
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method)?.delete(fn);
  }

  _emit(method, params) {
    for (const fn of this.listeners.get(method) ?? []) fn(params, method);
  }

  initialize() {
    return this.request("initialize", { clientInfo: { name: "kanban-desktop-t0-01", title: "Kanban Desktop T0-01", version: "0.1.0" }, capabilities: null });
  }

  // 发起 turn 并收集事件直到 turn/completed（含 interrupted 终态）；approvalPolicy 可选
  runTurn(threadId, text, { onDelta } = {}) {
    return new Promise((resolve) => {
      const collected = { deltas: 0, deltaText: "", agentText: "", turn: null, deltasAfterEnd: 0 };
      let done = false;
      const offs = [
        this.on("turn/completed", (p) => {
          if (p.threadId !== threadId || done) return;
          done = true;
          collected.turn = p.turn;
          offs.splice(0).forEach((off) => off());
          resolve(collected);
        }),
        this.on("error", (p) => {
          if (p.threadId !== threadId || done || p.willRetry) return;
          done = true;
          collected.errorEvent = p;
          offs.splice(0).forEach((off) => off());
          resolve(collected);
        }),
        this.on("dead", () => { if (!done) { done = true; offs.splice(0).forEach((off) => off()); resolve({ ...collected, dead: true }); } }),
      ];
      // delta 持续计数（在 resolve 后仍统计「结束后增量」由外层二次读取 collected.deltas 实现，这里保留引用）
      const offDelta = this.on("item/agentMessage/delta", (p) => {
        if (p.threadId !== threadId) return;
        collected.deltas++;
        collected.deltaText += p.delta;
        if (done) collected.deltasAfterEnd++;
        onDelta?.(p);
      });
      offs.push(offDelta);
      this.request("turn/start", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
        effort: "low",
      }).catch((e) => { if (!done) { done = true; collected.turnStartError = String(e.message); offs.splice(0).forEach((off) => off()); resolve(collected); } });
    });
  }

  stop() {
    if (this.proc && !this.proc.killed) { try { this.proc.kill(); } catch { /* ignore */ } }
  }
}
