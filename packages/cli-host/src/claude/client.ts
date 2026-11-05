// 用途：Claude Code stream-json 行协议持久客户端（演进自 poc-7 lib/client.mjs + poc-2 protocol-client.mjs 谱系，t0-02 裁决为唯一传输层）—— 单进程单会话：spawn 直连、initialize 握手、多轮 user 行、interrupt 控制请求、CLI→host 控制请求（can_use_tool 审批）应答、进程死亡明确报错
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

/** spawn 基础参数（poc-2/7 实证；--permission-prompt-tool=stdio 必带——漏带=非交互静默全拒绝，PoC 7 T3） */
export const CLAUDE_BASE_ARGS = [
  "--print",
  "--output-format",
  "stream-json",
  "--verbose",
  "--input-format",
  "stream-json",
  "--include-partial-messages",
  "--permission-prompt-tool",
  "stdio",
] as const;

/** 审批 flag 的自检键（fail-fast 断言用；参数与值成对出现） */
export const APPROVAL_FLAG = "--permission-prompt-tool";
export const APPROVAL_FLAG_VALUE = "stdio";

export interface ClaudeStreamOptions {
  /** resolveClaudeExe 产物（真实 .exe，不经 .cmd shim / PATH）；测试注入工厂可不传 */
  exe?: string;
  /** 会话工作目录（transcript 归档与 hook 相对 cwd 均由此派生） */
  cwd: string;
  /** 额外 spawn 参数（--settings/--model/--resume/--dangerously-skip-permissions 等） */
  args?: string[];
  /** 诊断日志 */
  log?: (kind: string, detail: string) => void;
  /** initialize 握手超时（缺省 90s，poc-7 同款） */
  initTimeoutMs?: number;
  /** interrupt 确认等待上限（缺省 15s；超时按已尽力处理不报错——中断效果以流为准） */
  interruptAckTimeoutMs?: number;
}

/** 启动自检 fail-fast：审批 flag 未成对出现即抛错（spec G：默认非交互=静默全拒绝，宁可启动失败不留静默路径） */
export function assertApprovalFlag(args: readonly string[]): void {
  const idx = args.indexOf(APPROVAL_FLAG);
  if (idx === -1 || args[idx + 1] !== APPROVAL_FLAG_VALUE) {
    throw new Error(
      `启动自检失败：spawn 参数缺少 ${APPROVAL_FLAG} ${APPROVAL_FLAG_VALUE}（非交互 stream-json 默认把审批静默全拒绝，PoC 7 T3 实证）。这属于实现缺陷，请报告。`,
    );
  }
}

/**
 * 单会话 stream-json 客户端。生命周期：start() 完成 initialize 握手并返回 native session id；
 * 进程退出后 dead=true、消息监听器保留（Adapter 据死讯发 session_exit；resume 由 Adapter 换新实例完成）。
 * wire 备注（PoC 7 发现，防踩坑）：CLI→host 的 control_request 的 request_id 在顶层；
 * host→CLI 的 control_response 的 request_id 嵌套在 response 对象内。
 */
export class ClaudeStreamClient {
  private proc: ChildProcess | null = null;
  private buf = "";
  dead = false;
  exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private readonly pendingControl = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly messageListeners = new Set<(msg: Record<string, unknown>) => void>();
  private readonly deadListeners = new Set<(err: Error) => void>();
  private readonly log: (kind: string, detail: string) => void;

  constructor(private readonly options: ClaudeStreamOptions) {
    this.log = options.log ?? (() => {});
  }

  /** spawn + initialize 握手（control_response success 即完成）；system/init 由 CLI 懒发射（首条 user 消息后才到，实测 2.1.317），native session id 经 --session-id 由 Adapter 预指定，不依赖 init */
  async start(): Promise<void> {
    const exePath = this.options.exe;
    if (!exePath) throw new Error("ClaudeStreamClient 缺少 exe（须经 resolveClaudeExe 显式解析，不走 PATH 兜底）");
    assertApprovalFlag([...CLAUDE_BASE_ARGS, ...(this.options.args ?? [])]);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finishOk = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };
      const child: ChildProcess = spawn(exePath, [...CLAUDE_BASE_ARGS, ...(this.options.args ?? [])], {
        cwd: this.options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        env: { ...process.env }, // 认证 env（用户级 settings 注入的网关配置）不切断（PoC 7 T6 叠加语义）
      });
      this.proc = child;
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (d: string) => this.onChunk(d));
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (d: string) => this.log("stderr", d.trimEnd().slice(0, 400)));
      child.on("error", (e) => fail(new Error(`claude 进程启动失败：${e.message}`)));
      child.on("exit", (code, signal) => {
        this.exitInfo = { code, signal };
        this.die(new Error(`claude 进程已退出：code=${code} signal=${signal}`));
        if (!settled) fail(new Error(`claude 进程在握手前退出：code=${code}`));
      });
      // initialize 控制请求（等 control_response success；poc-7 同款 wire）
      const initId = randomUUID();
      const timer = setTimeout(
        () => fail(new Error("claude initialize 握手超时")),
        this.options.initTimeoutMs ?? 90_000,
      );
      this.pendingControl.set(initId, {
        resolve: (resp) => {
          const subtype = (resp as { response?: { subtype?: string } })?.response?.subtype;
          if (subtype !== "success") {
            fail(new Error(`initialize 失败：${JSON.stringify(resp).slice(0, 300)}`));
            return;
          }
          finishOk();
        },
        reject: fail,
      });
      this.send({ request_id: initId, type: "control_request", request: { subtype: "initialize", options: {} } });
    });
  }

  /** 发送一行 JSON（user 消息 / control_response 等） */
  send(obj: unknown): void {
    if (!this.proc?.stdin) throw new Error("claude 进程未运行");
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  /** 发一轮用户消息（行协议 user 消息；内容一律经事件流返回，Adapter 侧不等回包） */
  sendUser(text: string): void {
    this.send({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null });
  }

  /** 发 interrupt 控制请求并等确认（超时不抛错：中断效果以流上 result(error_during_execution) 为准） */
  interrupt(): Promise<void> {
    if (this.dead) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pendingControl.delete(id);
        resolve();
      }, this.options.interruptAckTimeoutMs ?? 15_000);
      this.pendingControl.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: () => {
          clearTimeout(timer);
          resolve();
        },
      });
      this.send({ request_id: id, type: "control_request", request: { subtype: "interrupt" } });
    });
  }

  /** 回应 CLI 的控制请求（can_use_tool 审批）：request_id 嵌套在 response 内（SDK wire 形状，PoC 7 发现 1） */
  respondControlRequest(requestId: string, response: unknown): void {
    this.send({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
  }

  /** 订阅 stdout 全部已解析消息（system/assistant/user/stream_event/result/control_request/control_response） */
  onMessage(fn: (msg: Record<string, unknown>) => void): () => void {
    this.messageListeners.add(fn);
    return () => {
      this.messageListeners.delete(fn);
    };
  }

  /** 订阅进程死亡（一次性语义） */
  onDead(fn: (err: Error) => void): () => void {
    this.deadListeners.add(fn);
    return () => {
      this.deadListeners.delete(fn);
    };
  }

  /** 受控终止（Session 粒度；孤儿治理由 Job Object 兜底） */
  stop(): void {
    if (this.dead || !this.proc || this.proc.killed) return;
    try {
      this.proc.stdin?.end();
    } catch {
      /* 已关闭 */
    }
    try {
      this.proc.kill();
    } catch {
      /* 已退出 */
    }
  }

  /* ---------------- 内部：分帧与解复用 ---------------- */

  private onChunk(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch (e) {
        this.log("parse-error", `${line.slice(0, 200)} ${e instanceof Error ? e.message : ""}`);
        continue;
      }
      // 1) 我方控制请求的响应（request_id 顶层或嵌套均兼容）
      if (msg.type === "control_response") {
        const respId = (msg.request_id as string | undefined) ?? (msg.response as { request_id?: string } | undefined)?.request_id;
        if (respId && this.pendingControl.has(respId)) {
          const p = this.pendingControl.get(respId)!;
          this.pendingControl.delete(respId);
          p.resolve(msg);
          continue;
        }
      }
      // 2) 其余消息（含 CLI 发起的 control_request）全部外送
      for (const fn of this.messageListeners) fn(msg);
    }
  }

  private die(err: Error): void {
    if (this.dead) return;
    this.dead = true;
    for (const [, p] of this.pendingControl) p.reject(err);
    this.pendingControl.clear();
    for (const fn of this.deadListeners) fn(err);
    this.deadListeners.clear();
  }
}
