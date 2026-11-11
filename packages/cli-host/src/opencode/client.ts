// 用途：OpenCode server HTTP+SSE 客户端（演进自 poc-3 client.mjs EventClient/api）—— api 带陈旧连接重试（t0-01 发现 9）、SSE 帧解析与事件分发、进程/连接死亡上报；Adapter 与 ServerHost 的共同底层
import type { LogKind } from "@kanban/ipc-schema";
import { spawnSync, type ChildProcess } from "node:child_process";

/** HTTP API 响应（json 尽力解析，text 保留原文） */
export interface OpenCodeApiResponse {
  status: number;
  ok: boolean;
  json: unknown;
  text: string;
}

/** SSE 总线事件帧形状（data 行 JSON：{id,type,properties}） */
export interface OpenCodeSseEvent {
  type: string;
  properties: Record<string, unknown>;
}

/** 一个运行中 opencode server 的客户端面（生产 OpenCodeHttpServerClient；测试 Fake 手动驱动事件/响应） */
export interface OpenCodeServerClientLike {
  readonly port: number;
  readonly pid: number | null;
  dead: boolean;
  api(method: string, path: string, body?: unknown): Promise<OpenCodeApiResponse>;
  onEvent(fn: (ev: OpenCodeSseEvent) => void): () => void;
  onDead(fn: (err: Error) => void): () => void;
  /** 受控终止（接管进程无子进程句柄时为 no-op） */
  stop(): void;
}

export interface OpenCodeHttpClientOptions {
  /** server 监听端口（含 spawn 或接管自孤儿） */
  port: number;
  /** 我方 spawn 的子进程（接管孤儿时为 null，死亡以 HTTP/SSE 失败判定） */
  proc?: ChildProcess | null;
  /** 接管孤儿的进程 pid（proc 为 null 时 stop() 按 pid taskkill；缺省取 proc.pid） */
  pid?: number | null;
  /** SSE 断开后重连前的等待（缺省 1s；进程死亡不重连） */
  reconnectDelayMs?: number;
  /** 单次 HTTP 请求超时（缺省 15s；防对端不响应永久挂起） */
  apiTimeoutMs?: number;
  /** 诊断日志 */
  log?: (kind: LogKind, detail: string) => void;
}

/**
 * HTTP+SSE 客户端：单 server 连接。
 * 死亡判定：① 我方子进程 exit；② 接管进程的 SSE 断开且 HTTP 健康检查失败。
 * api() 对 keep-alive 陈旧连接的 fetch failed 重试一次（t0-01 发现 9）。
 */
export class OpenCodeHttpServerClient implements OpenCodeServerClientLike {
  readonly port: number;
  readonly pid: number | null;
  dead = false;
  private readonly proc: ChildProcess | null;
  private readonly base: string;
  private readonly reconnectDelayMs: number;
  private readonly apiTimeoutMs: number;
  private readonly log: (kind: LogKind, detail: string) => void;
  private readonly eventFns = new Set<(ev: OpenCodeSseEvent) => void>();
  private readonly deadFns = new Set<(err: Error) => void>();
  private sseAbort: AbortController | null = null;
  private sseRunning = false;

  constructor(options: OpenCodeHttpClientOptions) {
    this.port = options.port;
    this.proc = options.proc ?? null;
    this.pid = this.proc?.pid ?? options.pid ?? null;
    this.base = `http://127.0.0.1:${options.port}`;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
    this.apiTimeoutMs = options.apiTimeoutMs ?? 15_000;
    this.log = options.log ?? (() => {});
    if (this.proc) {
      this.proc.on("exit", (code, signal) => {
        this.die(new Error(`opencode server 进程已退出：code=${code} signal=${signal}`));
      });
      this.proc.on("error", (e) => {
        this.die(new Error(`opencode server 进程启动失败：${e.message}`));
      });
    }
    void this.runSse();
  }

  /** HTTP 调用（15s 超时防挂起；陈旧连接重试一次；server 已死时抛错） */
  async api(method: string, path: string, body?: unknown): Promise<OpenCodeApiResponse> {
    if (this.dead) throw new Error("opencode server 已断开");
    const doFetch = (): Promise<Response> =>
      fetch(`${this.base}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.apiTimeoutMs),
      });
    let res: Response;
    try {
      try {
        res = await doFetch();
      } catch (first) {
        // undici keep-alive 复用被对端关闭的空闲连接 → "fetch failed"：重试一次新建连接
        this.log("api-retry", `${method} ${path} ${first instanceof Error ? first.message : String(first)}`);
        res = await doFetch();
      }
    } catch (e) {
      const err = new Error(`opencode server 请求失败（${method} ${path}）：${e instanceof Error ? e.message : String(e)}`);
      // 接管进程死亡形态：请求不可达 → 宣告死亡（我方 spawn 的进程由 exit 事件宣告）
      if (!this.proc) this.die(err);
      throw err;
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* 非 JSON 响应体 */
    }
    return { status: res.status, ok: res.ok, json, text };
  }

  onEvent(fn: (ev: OpenCodeSseEvent) => void): () => void {
    this.eventFns.add(fn);
    return () => {
      this.eventFns.delete(fn);
    };
  }

  onDead(fn: (err: Error) => void): () => void {
    this.deadFns.add(fn);
    return () => {
      this.deadFns.delete(fn);
    };
  }

  /** 受控终止：我方 spawn 的进程走 kill；接管的孤儿进程无句柄 → taskkill 按 pid 终止（Windows 单进程，poc-3 §8） */
  stop(): void {
    if (this.dead) return;
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* 已退出 */
      }
      return;
    }
    if (this.pid && this.pid > 0) {
      try {
        spawnSync("taskkill.exe", ["/F", "/PID", String(this.pid)], { stdio: "ignore" });
      } catch {
        /* 已退出或无权限（best effort） */
      }
    }
  }

  /* ---------------- 内部：SSE 消费 ---------------- */

  /** SSE 主循环：断开后按需重连（我方进程存活时）；server.connected 前的帧也照常分发 */
  private async runSse(): Promise<void> {
    if (this.sseRunning) return;
    this.sseRunning = true;
    while (!this.dead) {
      const ctl = new AbortController();
      this.sseAbort = ctl;
      try {
        const res = await fetch(`${this.base}/event`, { signal: ctl.signal });
        if (!res.ok || !res.body) throw new Error(`/event HTTP ${res.status}`);
        await this.pumpSseBody(res.body, ctl);
      } catch (e) {
        if (this.dead || ctl.signal.aborted) break;
        this.log("sse-error", e instanceof Error ? e.message : String(e));
      }
      this.sseAbort = null;
      if (this.dead) break;
      // 我方 spawn 的进程：等它自己宣告死亡或复活（短暂等待后重试）；接管进程：健康探测失败即死亡
      if (!this.proc) {
        const healthy = await this.healthCheck();
        if (!healthy) {
          this.die(new Error("opencode server（接管）SSE 断开且健康检查失败"));
          break;
        }
      }
      await new Promise((r) => setTimeout(r, this.reconnectDelayMs));
    }
    this.sseRunning = false;
  }

  /** 读取并分帧分发 SSE body（data: 行 JSON → {type,properties}） */
  private async pumpSseBody(body: ReadableStream<Uint8Array>, ctl: AbortController): Promise<void> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLines = chunk
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());
        if (dataLines.length === 0) continue;
        try {
          const ev = JSON.parse(dataLines.join("\n")) as { type?: string; properties?: Record<string, unknown> };
          if (typeof ev.type !== "string") continue;
          for (const fn of this.eventFns) fn({ type: ev.type, properties: ev.properties ?? {} });
        } catch {
          this.log("sse-parse", dataLines.join("\n").slice(0, 120));
        }
      }
      void ctl; // signal 仅用于整体取消
    }
  }

  /** GET /config 健康探测 */
  private async healthCheck(): Promise<boolean> {
    try {
      const r = await this.api("GET", "/config");
      return r.ok;
    } catch {
      return false;
    }
  }

  private die(err: Error): void {
    if (this.dead) return;
    this.dead = true;
    try {
      this.sseAbort?.abort();
    } catch {
      /* 已关闭 */
    }
    for (const fn of this.deadFns) fn(err);
    this.deadFns.clear();
    this.eventFns.clear();
  }
}
