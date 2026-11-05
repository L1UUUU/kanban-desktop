// 用途：Codex app-server JSON-RPC/stdio 客户端（自 poc/poc-1-codex-appserver/client.mjs 演进）：spawn 直连 exe、LF 行分帧、三形状解复用（响应/通知/服务端请求）、进程死亡明确报错
import { spawn, type ChildProcess } from "node:child_process";

/** JSON-RPC 消息三形状（app-server v2 协议，LF 分帧每行一条） */
export interface RpcRequest {
  id: number | string;
  method: string;
  params?: unknown;
}
export interface RpcNotification {
  method: string;
  params?: unknown;
}
export interface RpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface RpcClientOptions {
  /** vendored codex.exe 绝对路径（resolveCodexExe 产物） */
  exe: string;
  /** 子进程 cwd（会话工作目录；缺省继承当前进程） */
  cwd?: string;
  /** 诊断日志（stderr/解析错误等；缺省丢弃） */
  log?: (kind: string, detail: string) => void;
  /** 进程退出（含异常）回调 —— Adapter 据此发 session_exit */
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

/** JSON-RPC 错误（rpc error code + message 透传） */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/**
 * 单连接 app-server 客户端。生命周期约定：
 * start() 前 request 抛错；进程退出后 dead=true，pending 全部 reject、新请求抛错（明确报错不重试，spec H）。
 */
export class CodexRpcClient {
  private proc: ChildProcess | null = null;
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly serverHandlers = new Map<string, (params: unknown, id: number | string) => Promise<unknown> | unknown>();
  private readonly listeners = new Map<string, Set<(params: unknown, method: string) => void>>();
  private readonly deadListeners = new Set<(err: Error) => void>();
  dead = false;
  exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  constructor(private readonly options: RpcClientOptions) {}

  /** spawn app-server 并等待 stdout 就绪（首字节或进程启动成功即返回） */
  start(): void {
    if (this.proc) throw new Error("CodexRpcClient 已启动");
    const proc = spawn(this.options.exe, ["app-server"], {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onChunk(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (c: string) => this.options.log?.("stderr", c.trimEnd()));
    proc.on("error", (e) => this.die(new Error(`codex app-server 启动失败：${e.message}`)));
    proc.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      this.die(new Error(`codex app-server 已退出：code=${code} signal=${signal}`));
      this.options.onExit?.({ code, signal });
    });
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  /** 发 JSON-RPC 请求并等响应（error 透传 RpcError；进程死亡抛错） */
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.dead || !this.proc?.stdin) {
      return Promise.reject(new Error("codex app-server 未运行（进程已退出）"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ id, method, params: params ?? {} });
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** 注册服务端请求处理器（审批等带 id 的请求；返回值作为 result 回给服务端；id 供审批路由） */
  onServerRequest(method: string, handler: (params: unknown, id: number | string) => Promise<unknown> | unknown): void {
    this.serverHandlers.set(method, handler);
  }

  /** 订阅服务端通知；返回退订函数（同一引用精确配对，防静默泄漏——poc-1 发现 5） */
  on(method: string, fn: (params: unknown, method: string) => void): () => void {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method)!.add(fn);
    return () => {
      this.listeners.get(method)?.delete(fn);
    };
  }

  /** 订阅进程死亡（一次性语义，触发后自动清理） */
  onDead(fn: (err: Error) => void): () => void {
    this.deadListeners.add(fn);
    return () => {
      this.deadListeners.delete(fn);
    };
  }

  /** 停止进程（受控终止：TerminateProcess；孤儿治理由 Job Object 兜底） */
  stop(): void {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill();
      } catch {
        /* 进程已死则忽略 */
      }
    }
  }

  /* ---------------- 内部：分帧与解复用 ---------------- */

  private send(obj: RpcRequest | RpcResponse): void {
    if (!this.proc?.stdin) throw new Error("codex app-server 未运行");
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  private onChunk(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        this.options.log?.("parse-error", `${line.slice(0, 200)} ${e instanceof Error ? e.message : ""}`);
        continue;
      }
      this.dispatch(msg as Record<string, unknown>);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (msg.method !== undefined && msg.id !== undefined) {
      // 服务端发起的请求（审批/问询）——必须有 handler，否则回错误
      const handler = this.serverHandlers.get(String(msg.method));
      Promise.resolve()
        .then(() => {
          if (!handler) throw new Error(`未注册的服务端请求：${String(msg.method)}`);
          return handler(msg.params, msg.id as number | string);
        })
        .then(
          (result) => this.send({ id: msg.id as number | string, result: result ?? {} }),
          (error) =>
            this.send({
              id: msg.id as number | string,
              error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
            }),
        );
      return;
    }
    if (msg.method !== undefined) {
      const fns = this.listeners.get(String(msg.method));
      if (fns) for (const fn of fns) fn(msg.params, String(msg.method));
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id as number | string);
      if (!p) {
        this.options.log?.("orphan-response", JSON.stringify(msg).slice(0, 200));
        return;
      }
      this.pending.delete(msg.id as number | string);
      const err = msg.error as RpcResponse["error"] | undefined;
      if (err) p.reject(new RpcError(err.code, `rpc ${err.code}: ${err.message}`));
      else p.resolve(msg.result);
      return;
    }
    this.options.log?.("unknown-shape", JSON.stringify(msg).slice(0, 200));
  }

  private die(err: Error): void {
    if (this.dead) {
      // 已 dead：只补发 onExit（exit 事件在 die 之后仍要到达 Adapter）
      return;
    }
    this.dead = true;
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    for (const fn of this.deadListeners) fn(err);
    this.deadListeners.clear();
  }
}
