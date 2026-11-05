// 复制自 poc/poc-1-codex-appserver/client.mjs（Wave 1 已提交成果，本 PoC 只读复用不修改）
// Codex app-server 最小 JSON-RPC/stdio 客户端：spawn 二进制、LF 行分帧、请求/通知/服务端请求解复用、按 thread 串行化 turn。
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

let cachedExe;
// 解析 codex 真实 .exe（优先直连，避免 shell 链导致 kill 后残留孤儿进程）
export function resolveCodexCommand() {
  if (cachedExe) return { cmd: cachedExe, shell: false };
  // 1) 本地 node_modules / 全局 require 可达
  try {
    const req = createRequire(import.meta.url);
    const exe = tryExe(path.dirname(req.resolve("@openai/codex/package.json")));
    if (exe) return { cmd: (cachedExe = exe), shell: false };
  } catch { /* 继续探测 */ }
  // 2) npm root -g 探测（win32 下 npm 是 .cmd，execFileSync 必须带 shell 才能执行）
  try {
    const isWin = process.platform === "win32";
    const npmRoot = execFileSync(isWin ? "npm.cmd" : "npm", ["root", "-g"], {
      encoding: "utf8",
      shell: isWin,
    }).trim();
    const exe = tryExe(path.join(npmRoot, "@openai", "codex"));
    if (exe) return { cmd: (cachedExe = exe), shell: false };
  } catch { /* 继续回退 */ }
  // 3) 回退 .cmd shim（shell 链，kill 可能残留子进程——已知限制）
  return { cmd: process.platform === "win32" ? "codex.cmd" : "codex", shell: process.platform === "win32" };
}

function tryExe(pkgRoot) {
  const exe = path.join(pkgRoot, "node_modules", "@openai", "codex-win32-x64", "vendor",
    "x86_64-pc-windows-msvc", "bin", process.platform === "win32" ? "codex.exe" : "codex");
  return existsSync(exe) ? exe : null;
}

export class CodexAppServerClient extends EventTarget {
  constructor({ log } = {}) {
    super();
    this.log = log || (() => {});
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve,reject}
    this.serverHandlers = new Map(); // method -> fn(params) => result
    this.proc = null;
    this.buf = "";
    this.dead = false;
    this.exitInfo = null;
    // 每 thread 的 turn 串行化：threadId -> Promise 链尾
    this.threadQueues = new Map();
  }

  // 启动 app-server 子进程
  start() {
    const { cmd, shell } = resolveCodexCommand();
    this.proc = spawn(cmd, ["app-server"], { shell, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (c) => this._onChunk(c));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (c) => this.log("stderr", c.trimEnd()));
    this.proc.on("error", (e) => this._die(new Error(`spawn error: ${e.message}`)));
    this.proc.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      this._die(new Error(`app-server exited unexpectedly: code=${code} signal=${signal}`));
    });
  }

  _onChunk(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        this.log("parse-error", line.slice(0, 200), String(e));
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.method !== undefined && msg.id !== undefined) {
      // 服务端发起的请求（审批/问询）
      this.log("server-request", msg.method, JSON.stringify(msg.params).slice(0, 300));
      const handler = this.serverHandlers.get(msg.method);
      Promise.resolve()
        .then(() => (handler ? handler(msg.params) : Promise.reject(new Error(`no handler for ${msg.method}`))))
        .then(
          (result) => this._send({ id: msg.id, result: result ?? {} }),
          (error) =>
            this._send({
              id: msg.id,
              error: { code: -32000, message: error.message || String(error) },
            }),
        );
    } else if (msg.method !== undefined) {
      // 服务端通知（事件）
      this.dispatchEvent(new CustomEvent(msg.method, { detail: msg.params }));
      this.dispatchEvent(new CustomEvent("*", { detail: { method: msg.method, params: msg.params } }));
    } else if (msg.id !== undefined) {
      // 我方请求的响应
      const p = this.pending.get(msg.id);
      if (!p) return this.log("orphan-response", JSON.stringify(msg).slice(0, 200));
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(`rpc error ${msg.error.code}: ${msg.error.message}`)) : p.resolve(msg.result);
    } else {
      this.log("unknown-shape", JSON.stringify(msg).slice(0, 200));
    }
  }

  _send(obj) {
    if (this.dead) throw new Error("client is dead: app-server not running");
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  _die(err) {
    if (this.dead) return;
    this.dead = true;
    for (const [, p] of this.pending) p.reject(new Error(`${err.message} (pending rpc aborted)`));
    this.pending.clear();
    this.dispatchEvent(new CustomEvent("dead", { detail: err }));
  }

  // 发 JSON-RPC 请求
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this._send({ id, method, params: params ?? {} });
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  onServerRequest(method, fn) {
    this.serverHandlers.set(method, fn);
  }

  // 订阅通知：fn(detail, method)；off(fn) 用同一引用精确取消（内部维护 fn→包装函数映射）
  on(method, fn) {
    if (!this._onWrappers) this._onWrappers = new Map();
    const wrapped = (e) => fn(e.detail, method);
    this._onWrappers.set(fn, wrapped);
    this.addEventListener(method, wrapped);
  }

  off(method, fn) {
    const wrapped = this._onWrappers?.get(fn);
    if (wrapped) {
      this.removeEventListener(method, wrapped);
      this._onWrappers.delete(fn);
    }
  }

  async initialize() {
    return this.request("initialize", {
      clientInfo: { name: "kanban-desktop-poc1", title: "Kanban Desktop PoC 1", version: "0.1.0" },
      capabilities: null,
    });
  }

  // 同一 thread 的 turn 串行排队，避免并发 turn/start 交错事件
  async enqueueTurn(threadId, fn) {
    const prev = this.threadQueues.get(threadId) || Promise.resolve();
    const run = prev.then(fn, fn); // 前面失败也要继续跑后续
    this.threadQueues.set(
      threadId,
      run.catch(() => {}),
    );
    return run;
  }

  async threadStart(opts = {}) {
    const res = await this.request("thread/start", opts);
    return res;
  }

  // 发起一个 turn 并等到 turn/completed（事件驱动），返回 {turn, deltas, items...}
  runTurn(threadId, text, { approvalPolicy } = {}) {
    return this.enqueueTurn(threadId, () => this._runTurnInner(threadId, text, approvalPolicy));
  }

  _runTurnInner(threadId, text, approvalPolicy) {
    const collected = {
      deltas: [], // {itemId, delta} 按到达顺序
      agentItems: new Map(), // itemId -> item snapshot (item/completed)
      cmdItems: new Map(),
      reasonings: [],
      errors: [],
    };
    return new Promise((resolve, reject) => {
      const done = (value) => {
        cleanup();
        resolve({ ...value, collected });
      };
      const fail = (err) => {
        cleanup();
        reject(err);
      };
      const handlers = {
        "turn/started": (p) => {
          collected.turnStarted = p.turn;
        },
        "turn/completed": (p) => {
          collected.turnCompleted = p.turn;
          done({ turn: p.turn });
        },
        "error": (p) => {
          collected.errors.push(p);
          if (!p.willRetry) done({ turn: null });
        },
        "item/agentMessage/delta": (p) => {
          collected.deltas.push({ itemId: p.itemId, delta: p.delta });
        },
        "item/started": (p) => {
          collected.itemStarted = collected.itemStarted || [];
          const it = p.item;
          if (it.type === "commandExecution") collected.cmdItems.set(it.id, { started: it });
        },
        "item/completed": (p) => {
          const it = p.item;
          if (it.type === "agentMessage") collected.agentItems.set(it.id, it);
          if (it.type === "commandExecution") {
            const slot = collected.cmdItems.get(it.id) || {};
            slot.completed = it;
            collected.cmdItems.set(it.id, slot);
          }
        },
        "item/reasoning/summaryTextDelta": (p) => {
          collected.reasonings.push(p.delta);
        },
      };
      const wrapped = {};
      for (const [m, fn] of Object.entries(handlers)) {
        wrapped[m] = (p) => {
          if (p.threadId !== threadId) return; // 并发 thread 过滤
          fn(p);
        };
        this.on(m, wrapped[m]);
      }
      const deadHandler = (err) => fail(err);
      this.on("dead", deadHandler);
      const cleanup = () => {
        for (const [m, fn] of Object.entries(wrapped)) this.off(m, fn);
        this.off("dead", deadHandler);
      };
      const params = {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
        effort: "low", // 一句话级短任务用低推理档，避免全局 max 拖慢测试（仅 turn 级覆盖）
      };
      if (approvalPolicy) params.approvalPolicy = approvalPolicy;
      this.request("turn/start", params).catch(fail);
    });
  }

  // 优雅停止：结束进程（kill；Windows 下 TerminateProcess）
  stop() {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
    }
  }
}
