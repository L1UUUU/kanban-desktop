// 用途：CodexAdapter —— C1 契约的真实 Codex 实现：spawn 直连 vendored codex.exe app-server（JSON-RPC/stdio，单进程多 thread），通知流映射 ChatEvent（poc-1/t0-01 实证 wire 行为）+ readTranscript rollout 落盘双视角（#28）+ listModels 常驻 app-server 目录查询（#76）+ summarizeTitle 一次性 codex exec 标题摘要（#95）
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { LogKind, AdapterEvent, ApprovalSuggestion, ChatEvent, ChatEventSeed, CommandEntry, ModelEntry, PermMode, SessionStatus, TranscriptEvent } from "@kanban/ipc-schema";
import { AdapterError, ExeNotFoundError, type AdoptSessionInput, type AdapterCapabilities, type CliAdapter, type CreateSessionInput, type DisposeInput, type ListCommandsInput, type ListModelsInput, type ResolveApprovalInput, type SendTurnInput, type SetModelInput } from "./adapter";
import { mapSpawnFailure } from "./exe-chain";
import { resolveCodexExe } from "./codex/exe";
import { listCodexPromptCommands } from "./codex/prompt-commands";
import { CodexRpcClient } from "./codex/rpc";
import { parseRolloutTranscript } from "./codex/rollout";
import { createDefaultModelResolver, type ModelResolver } from "./codex/model-probe";
import { isAuthFailureText } from "./session-error";
import { buildSummaryPrompt, DEFAULT_SUMMARIZE_TIMEOUT_MS, runTitleOneShot, toTitleLine } from "./title-summarize";

/** 可注入的 rpc 客户端面（生产 CodexRpcClient；测试 Fake 手动驱动协议消息） */
export interface CodexRpcClientLike {
  start(): void;
  request(method: string, params?: unknown): Promise<unknown>;
  onServerRequest(method: string, handler: (params: unknown, id: number | string) => Promise<unknown> | unknown): void;
  on(method: string, fn: (params: unknown, method: string) => void): () => void;
  onDead(fn: (err: Error) => void): () => void;
  stop(): void;
  dead: boolean;
  exitInfo?: { code: number | null; signal: string | null } | null;
  /** 子进程 pid（listChildPids 用；无进程/已退出的实现为 null） */
  pid?: number | null;
}

export interface CodexAdapterOptions {
  /** 手动覆盖 exe 路径（config cliExe.codex）；缺省走探测链 */
  exe?: string | null;
  /** turn 级推理档（"low"/"medium"/"high"；缺省不传用账号默认；e2e 用 low 控成本） */
  effort?: string;
  /** 模型解析器（缺省内置探测链：显式直试探绕缓存→[未指定]缓存→rollout 扫描→model/list→试探） */
  resolveModel?: ModelResolver;
  /** 测试注入 rpc 客户端工厂 */
  clientFactory?: () => CodexRpcClientLike;
  /** 用户主目录覆盖（listCommands #89：~/.codex/prompts 解析基准；缺省 os.homedir()；测试注入 fixture） */
  homeDir?: string | null;
  /** #95：标题摘要一次性进程超时 ms（缺省 60s，独立设定不沿用 run-once 300s） */
  summarizeTimeoutMs?: number;
  /** 诊断日志 */
  log?: (kind: LogKind, detail: string) => void;
}

/**
 * 统一权限档位 → Codex sandbox+approvalPolicy（spec B 权限映射表意图；按当前协议枚举实测对位）。
 * 注：spec 表原文 ask=on-request/auto=on-failure，但 codex 0.144.1 wire 枚举仅 untrusted/on-request/granular/never
 * （e2e 实测 rpc -32600 拒绝 on-failure）。按三档语义对位：ask=非只读都问（untrusted）、
 * auto=沙箱内放行+风险才问（on-request）、full=全放行（never）。shortcut: codex 未来恢复 on-failure 枚举时复查此映射。
 */
const PERM_MAP: Record<PermMode, { approvalPolicy: string; sandbox: string }> = {
  ask: { approvalPolicy: "untrusted", sandbox: "workspace-write" },
  auto: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  full: { approvalPolicy: "never", sandbox: "danger-full-access" },
};

/** 统一审批决定 → Codex wire decision（spec B 审批映射表：语义不换写） */
const DECISION_MAP: Record<string, string> = {
  "allow-once": "accept",
  "allow-always": "acceptForSession",
  deny: "declined",
};

/** 全能力 Codex（approval/interrupt/resume/readHistory 均实证；skillSignal 阶段 2 接 Tracker）；runOnce 为托管形态能力（worker RunOnceRunner），adapter 单元恒 false（arch C13） */
const CODEX_CAPABILITIES: AdapterCapabilities = {
  approval: true,
  interrupt: true,
  resume: true,
  readHistory: true,
  skillSignal: false,
  adoptSession: true,
  runOnce: false,
  listChildPids: true,
};

/** model/list 分页保护上限（nextCursor 续拉；防异常游标死循环，issue #76） */
const MODEL_LIST_MAX_PAGES = 20;

/** 待决审批：respond 挂起 wire 响应直到用户决定或服务端终决 */
interface PendingApproval {
  requestId: string;
  itemId: string;
  decided: boolean;
  respond: (value: { decision: string }) => void;
}

interface SessionState {
  sessionId: string;
  threadId: string;
  cwd: string;
  model?: string;
  permMode?: PermMode;
  seq: number;
  log: ChatEvent[];
  status: SessionStatus;
  /** 当前 turn 提交中/进行中（busy 判定：排队依据） */
  turnActive: boolean;
  currentTurnId: string | null;
  /** 用户已请求中断（幂等 + 提交窗口竞态兜底） */
  interruptRequested: boolean;
  interruptSent: boolean;
  /** 本 turn 的 error 通知已发 session_error（防 failed 终态重复报错） */
  turnErrorSent: boolean;
  queue: string[];
  pendingApprovals: Map<string, PendingApproval>;
  /** #97：deny 决策已本地合成 tool_completed(denied) 的 itemId（0.167.0 起服务端不再回发 item/completed(declined)，防 0.144 双发） */
  deniedItemIds: Set<string>;
  /** agentMessage delta 累计（终文自愈依据） */
  agentAcc: Map<string, string>;
  dead: boolean;
  /** 收养会话（#13）：历史权威在原生 thread（本地 log 仅含登记事件），readHistory/resume 驱动原生回填 */
  adopted: boolean;
  /** 已从原生 thread 历史回填过（防重复回填） */
  backfilled: boolean;
  /** #95：本会话各轮 user 文本（startTurn 记录；原生 transcript 不可读时的摘要回退素材） */
  userTexts: string[];
}

export class CodexAdapter implements CliAdapter {
  readonly capabilities = CODEX_CAPABILITIES;
  private client: CodexRpcClientLike | null = null;
  private readonly sessions = new Map<string, SessionState>();
  private readonly byThread = new Map<string, SessionState>();
  private readonly handlers = new Set<(event: AdapterEvent) => void>();
  private readonly effort?: string;
  private readonly modelResolver: ModelResolver;
  private readonly clientFactory: () => CodexRpcClientLike;
  private readonly homeDir: string | null;
  private readonly log: (kind: LogKind, detail: string) => void;
  /** #95：config 手动覆盖 exe（summarizeTitle 的 exe 解析复用同链）与摘要一次性超时 */
  private readonly manualExe: string | null;
  private readonly summarizeTimeoutMs: number;

  constructor(options: CodexAdapterOptions = {}) {
    this.effort = options.effort;
    this.log = options.log ?? (() => {});
    this.homeDir = options.homeDir ?? null;
    this.manualExe = options.exe ?? null;
    this.summarizeTimeoutMs = options.summarizeTimeoutMs ?? DEFAULT_SUMMARIZE_TIMEOUT_MS;
    this.modelResolver = options.resolveModel ?? createDefaultModelResolver(options);
    const factory = options.clientFactory;
    if (factory) {
      this.clientFactory = factory;
    } else {
      // 生产：解析 vendored exe（config 手动覆盖 → env → npm 全局 → 本地）
      this.clientFactory = () =>
        new CodexRpcClient({ exe: resolveCodexExe({ manualOverride: this.manualExe }), log: this.log }) as unknown as CodexRpcClientLike;
    }
  }

  async createSession(init: CreateSessionInput): Promise<{ sessionId: string; nativeSessionId?: string | null; model?: string | null }> {
    this.ensureStarted();
    const perm = PERM_MAP[init.permMode ?? "auto"];
    let model: string;
    try {
      model = await this.modelResolver(init.model, this.client!);
    } catch (e) {
      throw new AdapterError("E_INTERNAL", e instanceof Error ? e.message : String(e));
    }
    let res: { thread?: { id?: string } };
    try {
      res = (await this.client!.request("thread/start", {
        cwd: init.cwd,
        model,
        approvalPolicy: perm.approvalPolicy,
        sandbox: perm.sandbox,
      })) as { thread?: { id?: string } };
    } catch (e) {
      throw new AdapterError("E_INTERNAL", `创建 Codex 会话失败：${e instanceof Error ? e.message : String(e)}`);
    }
    const threadId = res.thread?.id;
    if (!threadId) throw new AdapterError("E_INTERNAL", "thread/start 未返回 thread id（协议异常）");
    const s: SessionState = {
      sessionId: `s-${randomUUID().slice(0, 8)}`,
      threadId,
      cwd: init.cwd,
      model,
      permMode: init.permMode,
      seq: 0,
      log: [],
      status: "idle",
      turnActive: false,
      currentTurnId: null,
      interruptRequested: false,
      interruptSent: false,
      turnErrorSent: false,
      queue: [],
      pendingApprovals: new Map(),
      deniedItemIds: new Set(),
      agentAcc: new Map(),
      dead: false,
      adopted: false,
      backfilled: false,
      userTexts: [],
    };
    this.sessions.set(s.sessionId, s);
    this.byThread.set(threadId, s);
    this.emit(s, { type: "session_status", status: "idle" });
    return { sessionId: s.sessionId, nativeSessionId: threadId, model }; // model = resolver 结果（issue #76：本会话实际采用）
  }

  /** 模型目录（issue #76 / spec #75）：常驻 app-server 发 model/list（hidden 项不进目录；nextCursor 分页续拉），映射 displayName/description/isDefault */
  async listModels(_input: ListModelsInput): Promise<ModelEntry[]> {
    void _input; // 单实现忽略 cli/cwd（Router 分发用）
    this.ensureStarted();
    const entries: ModelEntry[] = [];
    let cursor: string | undefined;
    try {
      for (let page = 0; page < MODEL_LIST_MAX_PAGES; page += 1) {
        const res = (await this.client!.request("model/list", cursor ? { cursor } : {})) as {
          data?: Array<{ id?: string; displayName?: string; description?: string; hidden?: boolean; isDefault?: boolean } | null>;
          nextCursor?: string | null;
        };
        const data = Array.isArray(res.data) ? res.data : [];
        for (const m of data) {
          if (!m?.id || m.hidden) continue; // hidden 项对用户不可见（spec #75）
          entries.push({ id: m.id, displayName: m.displayName ?? m.id, description: m.description ?? "", isDefault: m.isDefault ?? false });
        }
        cursor = typeof res.nextCursor === "string" && res.nextCursor ? res.nextCursor : undefined;
        if (!cursor) break;
      }
    } catch (e) {
      throw new AdapterError("E_INTERNAL", `拉取 Codex 模型目录失败：${e instanceof Error ? e.message : String(e)}`);
    }
    return entries;
  }

  /** 命令列举（issue #89 / spec #82 E 块）：扫描用户级+项目级 prompts 目录（纯目录读取不触 app-server；任何读取失败在扫描模块内安全降级） */
  async listCommands(input: ListCommandsInput): Promise<CommandEntry[]> {
    return listCodexPromptCommands(input.cwd, this.homeDir ?? homedir());
  }

  /** 会话中途切换模型（issue #79 / spec #75）：更新会话态——此后每次 turn/start 携带 model 覆盖参数（协议语义「本 turn 及后续 turn 生效」，幂等） */
  async setModel(input: SetModelInput): Promise<{ model: string }> {
    const s = this.requireSession(input.sessionId);
    s.model = input.model;
    return { model: input.model };
  }

  /**
   * 一次性标题摘要（#95 / ADR 0003 决策 3）：spawn 独立 `codex exec` 一次性进程——--ephemeral 不落会话文件（上下文零污染）、
   * prompt 经 stdin（`-`）、会话当前模型经 -m、-o 临时文件取最终 agent 消息（stdout 不解析，免 banner 干扰）；
   * 超时独立设定；断开/收养会话亦可摘要（readTranscript 按需拉起 app-server 读原生历史）。
   */
  async summarizeTitle(sessionId: string): Promise<string | null> {
    const s = this.requireKnownSession(sessionId);
    const transcript = await this.readTranscript(sessionId);
    // 原生 transcript 为空（如 CLI 版本漂移下 thread/read 无内容）时回退本地素材：user 文本（startTurn 记录）+ assistant 终文（delta 累计）
    const material = transcript.length > 0 ? transcript : this.localSummaryMaterial(s);
    if (material.length === 0) return null;
    // CODING_STANDARDS「路径分隔符」：传给子进程的参数用 posix 形态（Windows 平台感知 join 的 \ 可能被对端静默拒绝）；fs 读/删同串通用（Node 在 Windows 接受 /）
    const out = path.posix.join(tmpdir().replace(/\\/g, "/"), `kb-codex-title-${randomUUID().slice(0, 8)}.txt`);
    const args = ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "--output-last-message", out];
    if (s.model) args.push("--model", s.model);
    args.push("-"); // prompt 经 stdin
    try {
      const r = await runTitleOneShot({
        exe: resolveCodexExe({ manualOverride: this.manualExe }),
        args,
        cwd: s.cwd,
        stdin: buildSummaryPrompt(material),
        timeoutMs: this.summarizeTimeoutMs,
        log: this.log,
      });
      if (r.exitCode !== 0) {
        throw new AdapterError("E_INTERNAL", `Codex 标题摘要失败（exit ${r.exitCode}）：${r.stderr.trim().slice(0, 200)}`);
      }
      // 最终消息由 -o 文件承载（0.167.0 实测 flag：--output-last-message）；缺文件/空文件按空产出降级 null
      let text = "";
      try {
        text = readFileSync(out, "utf8");
      } catch {
        /* 未写出：按空产出处理（下方统一留痕） */
      }
      const title = toTitleLine(text);
      // review S2：exit 0 但空产出（文件缺失/为空）降级 null 前留 warn——失败可定位（ADR 0003：摘要失败不阻塞对话）
      if (!title) this.log("title-empty", `Codex 标题摘要 exit 0 但输出文件缺失或为空：${out}`);
      return title || null;
    } catch (e) {
      // #46 对齐 ensureStarted：spawn 阶段失败协议映射单点；启动/超时/exit 非零包装均为 AdapterError 原样透传
      throw mapSpawnFailure(e, "Codex 标题摘要失败");
    } finally {
      rmSync(out, { force: true }); // 临时文件即用即清
    }
  }

  /** #95 摘要回退素材：本地已知对话（user 文本按轮序 + assistant 终文；标题摘要只需主题素材，顺序粗粒度可接受） */
  private localSummaryMaterial(s: SessionState): TranscriptEvent[] {
    const out: TranscriptEvent[] = [];
    for (const text of s.userTexts) {
      if (text.trim()) out.push({ role: "user", text });
    }
    for (const text of s.agentAcc.values()) {
      if (text.trim()) out.push({ role: "assistant", text });
    }
    return out;
  }

  /** 应用重启后的会话收养（#13 恢复编排）：按 DB thread id 重建状态（无进程；readHistory 拉起进程读原生历史，resume 后可续问） */
  async adoptSession(input: AdoptSessionInput): Promise<void> {
    if (this.sessions.has(input.sessionId)) throw new AdapterError("E_INTERNAL", `会话已存在：${input.sessionId}`);
    if (!input.nativeSessionId) throw new AdapterError("E_INTERNAL", "收养 Codex 会话需要 native thread id");
    const s: SessionState = {
      sessionId: input.sessionId,
      threadId: input.nativeSessionId,
      cwd: input.cwd,
      model: input.model,
      permMode: input.permMode,
      seq: 0,
      log: [],
      status: "disconnected",
      turnActive: false,
      currentTurnId: null,
      interruptRequested: false,
      interruptSent: false,
      turnErrorSent: false,
      queue: [],
      pendingApprovals: new Map(),
      deniedItemIds: new Set(),
      agentAcc: new Map(),
      dead: true,
      adopted: true,
      backfilled: false,
      userTexts: [],
    };
    this.sessions.set(s.sessionId, s);
    this.byThread.set(input.nativeSessionId, s);
    this.emit(s, { type: "session_status", status: "disconnected" });
  }

  async sendTurn(input: SendTurnInput): Promise<void> {
    const s = this.requireSession(input.sessionId);
    // 不变量 6：忙态（turn 进行中/审批待决）排队
    if (s.turnActive || s.pendingApprovals.size > 0) {
      s.queue.push(input.text);
      return;
    }
    await this.startTurn(s, input.text);
  }

  async interruptTurn(sessionId: string): Promise<void> {
    const s = this.requireSession(sessionId);
    // 幂等：无活动 turn 时 no-op
    if (!s.turnActive && s.pendingApprovals.size === 0) return;
    if (s.interruptSent || s.interruptRequested) return;
    s.interruptRequested = true;
    // wire 必须带 turnId（t0-01 发现 4）；提交窗口内 turn/started 未到则到达后补发
    if (s.currentTurnId && this.client && !this.client.dead) {
      s.interruptSent = true;
      this.client.request("turn/interrupt", { threadId: s.threadId, turnId: s.currentTurnId }).catch(() => {
        /* 竞态：turn 已终态时服务端报错——状态以通知为准 */
      });
    }
  }

  async resolveApproval(input: ResolveApprovalInput): Promise<void> {
    const s = this.requireSession(input.sessionId);
    const entry = s.pendingApprovals.get(input.requestId);
    // 非法时序：无待决或已决/服务端已终决 → E_APPROVAL_EXPIRED
    if (!entry || entry.decided) {
      throw new AdapterError("E_APPROVAL_EXPIRED", `审批请求不存在或已终结：${input.requestId}`);
    }
    entry.decided = true;
    s.pendingApprovals.delete(input.requestId);
    entry.respond({ decision: DECISION_MAP[input.decision] });
    if (input.decision === "deny") {
      // #97：codex 0.167.0 起 deny 后服务端不再回发 item/completed(declined)（0.144.1 会）——deny 即本地合成工具终态，deniedItemIds 防旧版双发
      s.deniedItemIds.add(entry.itemId);
      this.emit(s, { type: "tool_completed", itemId: entry.itemId, status: "denied", durationMs: 0, output: "" });
    }
    this.emit(s, { type: "session_status", status: "running" });
  }

  async readHistory(sessionId: string): Promise<ChatEvent[]> {
    const s = this.requireKnownSession(sessionId);
    // 跨进程恢复（#13）：收养会话无本地日志 → 拉起 app-server 读原生 thread 历史（poc-1 g1：thread/read 无需 resume）
    if (s.adopted && !s.backfilled) await this.backfillFromNative(s);
    return [...s.log];
  }

  /**
   * readTranscript（#28）：只读拉取（不 resume、不发 turn）。
   * 主路径：thread/read 拿 thread.path → rollout 落盘文件解析（0.144.1 实测 thread/read 归档剥离 commandExecution 工具条目，
   * rollout 含全部事件；与本地事件日志无关，原生历史为权威源；0.167.0 起 rollout 行形态改版，双版本口径见 codex/rollout.ts，#97）。
   * 回退：path 缺失/读失败 → thread/read turns 的 userMessage/agentMessage/归档工具条目映射。
   */
  async readTranscript(sessionId: string): Promise<TranscriptEvent[]> {
    const s = this.requireKnownSession(sessionId);
    this.ensureStarted(); // 断开/收养会话按需拉起 app-server（仅进程，不动 thread 状态）
    let thread: { path?: string | null; turns?: unknown };
    try {
      thread = await this.readNativeThread(s, true);
    } catch {
      // 无 turn 会话未 materialized（t0-01 发现 5）：无 includeTurns 的 read 兜底；仍失败则明确报错（不冒充完整）
      thread = await this.readNativeThread(s, false).catch((e) => {
        throw new AdapterError("E_INTERNAL", `读取 Codex 原生历史失败：${e instanceof Error ? e.message : String(e)}`);
      });
    }
    const rolloutPath = typeof thread.path === "string" && thread.path.length > 0 ? thread.path : null;
    if (rolloutPath) {
      try {
        return parseRolloutTranscript(readFileSync(rolloutPath, "utf8"));
      } catch (e) {
        this.log("readTranscript", `rollout 读取失败，回退 thread/read turns：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // 回退映射：归档 turns（工具条目有无取决于 CLI 版本归档行为）
    const turns = Array.isArray(thread.turns) ? (thread.turns as Array<Record<string, unknown>>) : [];
    const out: TranscriptEvent[] = [];
    for (const turn of turns) {
      const items = Array.isArray(turn.items) ? (turn.items as Array<Record<string, unknown>>) : [];
      for (const item of items) {
        if (item.type === "userMessage") {
          const text = nativeItemText(item.content ?? item.text);
          if (text.length > 0) out.push({ role: "user", text });
          continue;
        }
        if (item.type === "agentMessage") {
          const text = typeof item.text === "string" ? item.text : "";
          if (text.length > 0) out.push({ role: "assistant", text });
          continue;
        }
        // 工具条目复用实时流映射（name/summary 与 readHistory 同源）
        const started = this.mapToolStarted(item);
        if (started?.type === "tool_started") {
          out.push({ role: "assistant", text: "", tool: { name: started.tool, summary: started.argsSummary } });
        }
      }
    }
    return out;
  }

  async resume(sessionId: string): Promise<void> {
    const s = this.requireKnownSession(sessionId);
    if (s.dead) {
      // 跨进程恢复（t0-01 T4 实证）：新进程 thread/resume 同 id → 上下文延续、已完成的 turn 全部在场、无重放
      this.ensureStarted();
      try {
        await this.client!.request("thread/resume", { threadId: s.threadId });
      } catch (e) {
        throw new AdapterError("E_INTERNAL", `恢复 Codex 会话失败：${e instanceof Error ? e.message : String(e)}`);
      }
      if (!s.backfilled) {
        // 历史回填 best-effort（resume 已成功；thread/read 失败不阻断恢复）
        await this.backfillFromNative(s).catch((e) => this.log("restore", `历史回填失败：${e instanceof Error ? e.message : String(e)}`));
      }
      s.dead = false;
      this.emit(s, { type: "session_status", status: "idle" });
      return;
    }
    // 进程内存活期间状态连续；仅复位活动残留并通知空闲
    s.turnActive = false;
    s.currentTurnId = null;
    s.queue.length = 0;
    this.emit(s, { type: "session_status", status: "idle" });
  }

  async dispose(input?: DisposeInput): Promise<void> {
    if (input?.sessionId) {
      // Session 粒度：仅丢弃本地会话状态（进程保留供其他 thread 使用；t0-01 T3 实证）
      const s = this.sessions.get(input.sessionId);
      if (s) {
        this.sessions.delete(input.sessionId);
        this.byThread.delete(s.threadId);
      }
      return;
    }
    // 全局：受控终止并等待进程实际退出（onDead 链发 session_exit/disconnected；有限等待防挂）
    const client = this.client;
    if (!client || client.dead) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      client.onDead(() => {
        clearTimeout(timer);
        resolve();
      });
      client.stop();
    });
  }

  subscribe(handler: (event: AdapterEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** C5 演进（#44）：共享单进程模型 —— app-server 存活时报一份 pid；未启动/已死亡为空集（不报陈旧 pid，防 pid 复用误判） */
  async listChildPids(): Promise<number[]> {
    const c = this.client;
    const pid = c && !c.dead ? c.pid : null;
    return pid ? [pid] : [];
  }

  /* ---------------- 内部：启动与协议挂接 ---------------- */

  private ensureStarted(): void {
    if (this.client && !this.client.dead) return;
    let client: CodexRpcClientLike;
    try {
      client = this.clientFactory();
    } catch (e) {
      // #46：exe 解析失败协议级映射（mapSpawnFailure 单点 → E_SPAWN_NOT_FOUND → renderer spawn 卡）；其余原样抛出
      if (e instanceof ExeNotFoundError) throw mapSpawnFailure(e);
      throw e;
    }
    client.onDead((err) => this.handleProcessDeath(err));
    client.start();
    this.wireNotifications(client);
    this.client = client;
    // initialize 握手（同步等待由调用方 ensure 后首请求前完成——app-server 首请求前容错）
    void client.request("initialize", {
      clientInfo: { name: "kanban-desktop", title: "Kanban Desktop", version: "0.1.0" },
      capabilities: null,
    }).catch((e) => this.log("init-error", e instanceof Error ? e.message : String(e)));
  }

  /** 挂接全部所需通知与服务端请求（threadId 路由到 session） */
  private wireNotifications(client: CodexRpcClientLike): void {
    client.on("turn/started", (p) => {
      const s = this.byThread.get((p as { threadId: string }).threadId);
      if (!s || s.dead) return;
      const turn = (p as { turn: { id: string } }).turn;
      s.currentTurnId = turn.id;
      // 中断竞态兜底：提交后、started 前用户已按停止
      if (s.interruptRequested && !s.interruptSent) {
        s.interruptSent = true;
        client.request("turn/interrupt", { threadId: s.threadId, turnId: turn.id }).catch(() => {});
      }
    });

    client.on("turn/completed", (p) => {
      const { threadId, turn } = p as { threadId: string; turn: { id: string; status: string; error?: { message?: string } | null } };
      const s = this.byThread.get(threadId);
      if (!s || s.dead) return;
      if (s.currentTurnId && turn.id !== s.currentTurnId) return; // 陈旧通知防护
      // failed 且 error 通知未覆盖 → 此处兜底报错（#41 枚举映射：认证类文本 → AUTH_EXPIRED，其余 INTERNAL）
      if (turn.status === "failed" && !s.turnErrorSent) {
        s.turnErrorSent = true;
        const msg = turn.error?.message ?? "turn 失败";
        this.emit(s, { type: "session_error", code: isAuthFailureText(msg) ? "AUTH_EXPIRED" : "INTERNAL", message: msg });
      }
      this.finishTurn(s, turn.status);
    });

    client.on("error", (p) => {
      const { threadId, error, willRetry } = p as { threadId: string; error: { message?: string; type?: string }; willRetry: boolean };
      const s = this.byThread.get(threadId);
      if (!s || s.dead || willRetry) return;
      if (s.turnErrorSent) return;
      s.turnErrorSent = true;
      // #41 枚举映射：error 通知为 turn 级服务错误，认证类文本归 AUTH_EXPIRED，其余 INTERNAL
      const msg = error?.message ?? "Codex 服务错误";
      this.emit(s, { type: "session_error", code: isAuthFailureText(msg) ? "AUTH_EXPIRED" : "INTERNAL", message: msg });
    });

    client.on("item/agentMessage/delta", (p) => {
      const { threadId, itemId, delta } = p as { threadId: string; itemId: string; delta: string };
      const s = this.byThread.get(threadId);
      if (!s || s.dead) return;
      s.agentAcc.set(itemId, (s.agentAcc.get(itemId) ?? "") + delta);
      this.emit(s, { type: "message_delta", itemId, partId: "0", delta });
    });

    client.on("item/started", (p) => {
      const { threadId, item } = p as { threadId: string; item: Record<string, unknown> };
      const s = this.byThread.get(threadId);
      if (!s || s.dead) return;
      const started = this.mapToolStarted(item);
      if (started) this.emit(s, started);
    });

    client.on("item/completed", (p) => {
      const { threadId, item } = p as { threadId: string; item: Record<string, unknown> };
      const s = this.byThread.get(threadId);
      if (!s || s.dead) return;
      if (item.type === "agentMessage") {
        this.completeAgentMessage(s, String(item.id), typeof item.text === "string" ? item.text : "");
        return;
      }
      const done = this.mapToolCompleted(item);
      // #97：deny 已本地合成 denied 终态时，服务端后到的 declined 条目（0.144.1 行为）不再重复发
      if (done && !(done.type === "tool_completed" && done.status === "denied" && s.deniedItemIds.has(done.itemId))) this.emit(s, done);
    });

    client.on("item/commandExecution/outputDelta", (p) => {
      const { threadId, itemId, delta } = p as { threadId: string; itemId: string; delta: string };
      const s = this.byThread.get(threadId);
      if (!s || s.dead) return;
      this.emit(s, { type: "tool_update", itemId, outputDelta: delta });
    });

    client.on("serverRequest/resolved", (p) => {
      const { threadId, requestId } = p as { threadId: string; requestId: string | number };
      const s = this.byThread.get(threadId);
      if (!s) return;
      const entry = s.pendingApprovals.get(String(requestId));
      if (!entry) return; // 客户端已响应的正常回执
      s.pendingApprovals.delete(String(requestId));
      entry.respond({ decision: "cancel" }); // 释放挂起响应（服务端已终决，忽略内容）
      this.emit(s, { type: "approval_expired", requestId: entry.requestId, reason: "server_resolved" });
      s.deniedItemIds.add(entry.itemId); // #97：与 deny 决策同防——服务端终决后旧版仍可能回发 declined 条目
      this.emit(s, { type: "tool_completed", itemId: entry.itemId, status: "denied", durationMs: 0, output: "" });
      if (s.turnActive) this.emit(s, { type: "session_status", status: "running" });
    });

    // 审批服务端请求：挂起 wire 响应直到用户决定（原生审批直通，spec B 语义不换写）
    client.onServerRequest("item/commandExecution/requestApproval", (params, id) => {
      return this.handleApprovalRequest(client, params, id, {
        kind: "command",
        commandOf: (p) => (typeof p.command === "string" && p.command ? p.command : "(未知命令)"),
      });
    });
    client.onServerRequest("item/fileChange/requestApproval", (params, id) => {
      return this.handleApprovalRequest(client, params, id, {
        kind: "fileChange",
        commandOf: (p) => `文件修改：${typeof p.reason === "string" && p.reason ? p.reason : "apply patch"}`,
      });
    });
    // 其余服务端请求（userInput/elicitation 等）：能力未开放，明确拒绝不阻塞
    for (const method of [
      "item/tool/requestUserInput",
      "mcpServer/elicitation/request",
      "item/permissions/requestApproval",
      "item/tool/call",
    ]) {
      client.onServerRequest(method, () => {
        throw new Error(`kanban-desktop 暂不支持该交互：${method}`);
      });
    }
  }

  /** 审批请求共性：发 approval_requested + waiting，挂起响应等用户决定 */
  private handleApprovalRequest(
    _client: CodexRpcClientLike,
    params: unknown,
    id: number | string,
    shape: { kind: "command" | "fileChange"; commandOf: (p: Record<string, unknown>) => string },
  ): Promise<{ decision: string }> {
    const p = params as Record<string, unknown>;
    const s = this.byThread.get(String(p.threadId));
    if (!s || s.dead) throw new Error("会话不可用");
    return new Promise<{ decision: string }>((respond) => {
      const requestId = String(id);
      const itemId = typeof p.itemId === "string" ? p.itemId : `ap-${requestId}`;
      this.emit(s, {
        type: "approval_requested",
        requestId,
        itemId,
        command: shape.commandOf(p),
        suggestions: approvalSuggestions(p),
      });
      this.emit(s, { type: "session_status", status: "waiting" });
      s.pendingApprovals.set(requestId, { requestId, itemId, decided: false, respond });
    });
  }

  /* ---------------- 内部：turn 驱动与终态 ---------------- */

  private async startTurn(s: SessionState, text: string): Promise<void> {
    s.userTexts.push(text); // #95：摘要回退素材（原生 transcript 不可读时）
    s.turnActive = true;
    s.interruptRequested = false;
    s.interruptSent = false;
    s.turnErrorSent = false;
    this.emit(s, { type: "session_status", status: "running" });
    this.emit(s, { type: "turn_started", turnId: `t-${randomUUID().slice(0, 8)}` });
    const params: Record<string, unknown> = {
      threadId: s.threadId,
      input: [{ type: "text", text, text_elements: [] }],
    };
    if (this.effort) params.effort = this.effort;
    // 会话模型随每次 turn/start 携带（issue #79）：协议注释 "Override the model for this turn and subsequent turns"（poc-1 TurnStartParams）——
    // 创建期同值幂等；setModel 更新 s.model 后本 turn 及后续全部生效
    if (s.model) params.model = s.model;
    try {
      await this.client!.request("turn/start", params);
    } catch (e) {
      // 提交失败：turn 回滚到空闲并明确报错（不进入事件流重放）；#41 rpc 401/登录态失效 → AUTH_EXPIRED
      s.turnActive = false;
      s.currentTurnId = null;
      const msg = e instanceof Error ? e.message : String(e);
      this.emit(s, { type: "session_error", code: isAuthFailureText(msg) ? "AUTH_EXPIRED" : "INTERNAL", message: msg });
      this.emit(s, { type: "session_status", status: "idle" });
      throw new AdapterError("E_INTERNAL", `turn 提交失败：${msg}`);
    }
  }

  /** turn 终态统一收尾：终态事件 + 状态 + 队列策略（interrupted/failed 丢弃排队，completed 续发） */
  private finishTurn(s: SessionState, status: string): void {
    s.turnActive = false;
    s.currentTurnId = null;
    s.interruptRequested = false;
    s.interruptSent = false;
    // 防护：turn 终态后残留审批强制失效（正常流审批先于 turn 终态解决）
    for (const entry of s.pendingApprovals.values()) {
      entry.respond({ decision: "cancel" });
    }
    s.pendingApprovals.clear();
    if (status === "interrupted") {
      s.queue.length = 0;
      this.emit(s, { type: "turn_interrupted", reason: "user" });
      this.emit(s, { type: "session_status", status: "interrupted" });
      return;
    }
    if (status === "failed") {
      s.queue.length = 0; // 明确报错不重放（spec H）
      this.emit(s, { type: "session_status", status: "idle" });
      return;
    }
    this.emit(s, { type: "turn_completed" });
    this.emit(s, { type: "session_status", status: "idle" });
    const next = s.queue.shift();
    if (next) void this.startTurn(s, next).catch(() => {});
  }

  /** agentMessage 终文自愈：delta 累计与终文不等时补发缺失部分（无重复无丢失，不变量 3） */
  private completeAgentMessage(s: SessionState, itemId: string, finalText: string): void {
    const acc = s.agentAcc.get(itemId) ?? "";
    if (finalText.startsWith(acc) && finalText.length > acc.length) {
      this.emit(s, { type: "message_delta", itemId, partId: "0", delta: finalText.slice(acc.length) });
    } else if (!finalText.startsWith(acc)) {
      // 理论不可达（服务端 delta 流与终文应严格一致，poc-1 实证）；保守不补发只记录
      this.log("text-mismatch", `itemId=${itemId} acc(${acc.length})!=final(${finalText.length})`);
    }
    this.emit(s, { type: "message_completed", itemId, partId: "0" });
  }

  /** 跨进程历史回填（#13）：thread/read 原生 turns → ChatEvent 日志（复用实时流映射器，同键同格式；仅收养会话，一次） */
  private async backfillFromNative(s: SessionState): Promise<void> {
    if (s.backfilled || !s.adopted) return;
    this.ensureStarted();
    let turns: Array<Record<string, unknown>>;
    try {
      turns = await this.readNativeTurns(s, true);
    } catch {
      // 无 turn 会话未 materialized（t0-01 发现 5）：无 includeTurns 的 read 仅验证可用性，历史为空
      turns = await this.readNativeTurns(s, false);
    }
    for (const turn of turns) {
      const items = Array.isArray(turn.items) ? (turn.items as Array<Record<string, unknown>>) : [];
      for (const item of items) {
        if (item.type === "agentMessage") {
          this.completeAgentMessage(s, String(item.id ?? ""), typeof item.text === "string" ? item.text : "");
          continue;
        }
        // userMessage 不入 ChatEvent（renderer 本地回显，与实时流口径一致）
        const started = this.mapToolStarted(item);
        if (started) this.emit(s, started);
        const done = this.mapToolCompleted(item);
        if (done) this.emit(s, done);
      }
      const status = typeof turn.status === "string" ? turn.status : "completed";
      // 中断/失败 turn 以 interrupted 终态在场（t0-01 发现 6：恢复历史应预期 interrupted 条目，不重放）
      this.emit(s, status === "completed" ? { type: "turn_completed" } : { type: "turn_interrupted", reason: status });
    }
    s.backfilled = true;
  }

  /** thread/read（includeTurns 开关）→ thread 对象（path/turns）；失败抛原始错误由调用方分流 */
  private async readNativeThread(s: SessionState, includeTurns: boolean): Promise<{ path?: string | null; turns?: unknown }> {
    const params: Record<string, unknown> = { threadId: s.threadId };
    if (includeTurns) params.includeTurns = true;
    const r = (await this.client!.request("thread/read", params)) as { thread?: { path?: string | null; turns?: unknown } };
    if (!r?.thread) throw new AdapterError("E_INTERNAL", "thread/read 未返回 thread（协议异常）");
    return r.thread;
  }

  /** thread/read（includeTurns 开关）→ turns 数组；失败抛原始错误由调用方分流 */
  private async readNativeTurns(s: SessionState, includeTurns: boolean): Promise<Array<Record<string, unknown>>> {
    const thread = await this.readNativeThread(s, includeTurns);
    return Array.isArray(thread.turns) ? (thread.turns as Array<Record<string, unknown>>) : [];
  }

  /** item/started → tool_started（commandExecution/fileChange/mcpToolCall） */
  private mapToolStarted(item: Record<string, unknown>): ChatEventSeed | null {
    const id = String(item.id ?? "");
    switch (item.type) {
      case "commandExecution":
        return { type: "tool_started", itemId: id, tool: "commandExecution", argsSummary: String(item.command ?? "") };
      case "fileChange": {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const paths = changes.map((c) => String((c as Record<string, unknown>).path ?? "")).filter(Boolean).join(", ");
        return { type: "tool_started", itemId: id, tool: "fileChange", argsSummary: paths || "apply patch" };
      }
      case "mcpToolCall":
        return {
          type: "tool_started",
          itemId: id,
          tool: `mcp:${String(item.server ?? "")}/${String(item.tool ?? "")}`,
          argsSummary: safeJson(item.arguments),
        };
      default:
        return null;
    }
  }

  /** item/completed → tool_completed（declined→denied；failed→completed 且输出带退出码标记） */
  private mapToolCompleted(item: Record<string, unknown>): ChatEventSeed | null {
    const id = String(item.id ?? "");
    const durationMs = typeof item.durationMs === "number" ? item.durationMs : 0;
    switch (item.type) {
      case "commandExecution": {
        const status = item.status === "declined" ? "denied" : "completed";
        const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
        const output = String(item.aggregatedOutput ?? "");
        const marked = exitCode !== null && exitCode !== 0 ? `[exit ${exitCode}] ${output}` : output;
        return { type: "tool_completed", itemId: id, status, durationMs, output: marked };
      }
      case "fileChange": {
        const status = item.status === "declined" ? "denied" : "completed";
        const changes = Array.isArray(item.changes) ? item.changes : [];
        return { type: "tool_completed", itemId: id, status, durationMs, output: safeJson(changes) };
      }
      case "mcpToolCall": {
        const status = item.status === "failed" || item.status === "declined" ? "denied" : "completed";
        return { type: "tool_completed", itemId: id, status, durationMs, output: safeJson(item.result ?? item.error) };
      }
      default:
        return null;
    }
  }

  /** 进程死亡：全部会话明确报错（session_exit + disconnected），后续操作拒绝（不重放） */
  private handleProcessDeath(err: Error): void {
    this.log("dead", err.message);
    const exitCode = this.client?.exitInfo?.code ?? 1;
    for (const s of this.sessions.values()) {
      if (s.dead) continue;
      s.dead = true;
      s.queue.length = 0;
      for (const entry of s.pendingApprovals.values()) entry.respond({ decision: "cancel" });
      s.pendingApprovals.clear();
      this.emit(s, { type: "session_exit", exitCode: typeof exitCode === "number" ? exitCode : 1, reason: err.message });
      this.emit(s, { type: "session_status", status: "disconnected" });
    }
  }

  /* ---------------- 内部：事件与工具 ---------------- */

  /** 事件唯一出口：写日志（seq 单调）+ 广播 —— readHistory 与实时流零分叉 */
  private emit(s: SessionState, ev: ChatEventSeed): void {
    s.seq += 1;
    const full = { ...ev, sessionId: s.sessionId, seq: s.seq, at: new Date().toISOString() } as ChatEvent;
    s.log.push(full);
    for (const h of this.handlers) h(full);
  }

  private requireSession(sessionId: string): SessionState {
    const s = this.sessions.get(sessionId);
    if (!s) throw new AdapterError("E_SESSION_NOT_FOUND", `会话不存在：${sessionId}`);
    if (s.dead) {
      throw new AdapterError("E_INTERNAL", "Codex 进程已退出，会话已断开（请读取原生历史恢复或新建会话）");
    }
    return s;
  }

  /** 只查存在性（允许 dead）：readHistory/resume 是断开会话的恢复入口（#13） */
  private requireKnownSession(sessionId: string): SessionState {
    const s = this.sessions.get(sessionId);
    if (!s) throw new AdapterError("E_SESSION_NOT_FOUND", `会话不存在：${sessionId}`);
    return s;
  }
}

/** 审批建议项：exec-policy 修正（规则）/ network 主机 / 写入根目录（spec I-5 建议行） */
function approvalSuggestions(p: Record<string, unknown>): ApprovalSuggestion[] {
  const out: ApprovalSuggestion[] = [];
  const amend = p.proposedExecpolicyAmendment;
  if (Array.isArray(amend) && amend.length > 0) {
    out.push({
      kind: "exec-policy",
      label: "允许同类命令（本会话）",
      detail: amend.map(String).join(" "),
    });
  }
  const net = p.proposedNetworkPolicyAmendments;
  if (Array.isArray(net)) {
    for (const r of net) {
      const rec = r as Record<string, unknown>;
      out.push({ kind: "network", label: String(rec.host ?? ""), detail: String(rec.action ?? "") });
    }
  }
  if (typeof p.grantRoot === "string" && p.grantRoot) {
    out.push({ kind: "grant-root", label: p.grantRoot, detail: "允许在此目录写入（本会话）" });
  }
  return out;
}

/** 原生条目文本：string 直出 / content 数组拼 text 块（userMessage 两种 wire 形态兼容） */
function nativeItemText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Record<string, unknown>[])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
  }
  return "";
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}
