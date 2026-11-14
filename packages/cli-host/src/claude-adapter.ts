// 用途：ClaudeAdapter —— C1 契约的真实 Claude 实现：stream-json 行协议直连（每会话一进程，poc-7 client 演进）、stdio 审批（can_use_tool 控制请求）、interrupt 归类已取消、--resume 跨重启恢复、--settings 会话级 hook 注入产生 verified SkillObservation（t0-02 裁决：无 SDK 备选路径）、listModels spawn 临时进程 initialize 握手读 models 数组（#78）、setModel 活进程 set_model 控制请求 + 实际模型名回写会话态（#79）、summarizeTitle 一次性 claude -p 标题摘要（#95）；arch C1 起回合状态机（排队/终态/幂等中断/emit/死亡收尾）为 turn-kernel 消费方，本文件保留 wire 层（stream-json 解析）与审批应答形状
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { LogKind, AdapterEvent, ApprovalSuggestion, ChatEvent, ChatEventSeed, CommandEntry, ModelEntry, PermMode, SessionStatus, SkillObservation, TranscriptEvent } from "@kanban/ipc-schema";
import { transformHookEvents } from "@kanban/tracker";
import { AdapterError, type AdoptSessionInput, type AdapterCapabilities, type CliAdapter, type CliDirectory, type CreateSessionInput, type CreateSessionResult, type DisposeInput, type ListCommandsInput, type ListModelsInput, type ResolveApprovalInput, type SendTurnInput, type SetModelInput } from "./adapter";
import { ExeResolveCache, mapSpawnFailure } from "./exe-chain";
import { CLAUDE_EXE_CHAIN } from "./claude/exe";
import { listClaudeSkillCommands } from "./claude/skill-commands";
import { ClaudeSetModelError, ClaudeStreamClient, type ClaudeStreamOptions } from "./claude/client";
import { prepareSessionHookDir, resolveHookNodeBin, tailJsonl, writeSessionSettings, type SessionHookFiles } from "./claude/hook-inject";
import { findTranscriptFile, parseTranscriptEvents, parseTranscriptItems } from "./claude/transcript";
import { resolveUserClaudeDir } from "./skill-conflicts";
import { isAuthFailureStatus, isAuthFailureText } from "./session-error";
import { buildSummaryPrompt, DEFAULT_SUMMARIZE_TIMEOUT_MS, runTitleOneShot, toTitleLine } from "./title-summarize";
import { DEFAULT_STOP_TIMEOUT_MS, requireLiveSessionEntry, requireSessionEntry, stopAndAwaitExit, TurnKernel, type KernelApproval, type TurnState } from "./turn-kernel";

/** 可注入的流客户端面（生产 ClaudeStreamClient；测试 Fake 手动驱动协议消息） */
export interface ClaudeStreamClientLike {
  /** spawn + initialize 握手；返回初始化响应内层载荷（含 models 目录，listModels #78 数据源） */
  start(): Promise<Record<string, unknown>>;
  sendUser(text: string): void;
  interrupt(): Promise<void>;
  /** set_model 控制请求（#79）：成功回传下一 turn 实际模型名；失败抛 ClaudeSetModelError（CLI 错误码透传） */
  setModel(model: string): Promise<string>;
  respondControlRequest(requestId: string, response: unknown): void;
  onMessage(fn: (msg: Record<string, unknown>) => void): () => void;
  onDead(fn: (err: Error) => void): () => void;
  stop(): void;
  dead: boolean;
  exitInfo?: { code: number | null; signal: NodeJS.Signals | null } | null;
  /** 子进程 pid（listChildPids 用；无进程/已退出的实现为 null） */
  pid?: number | null;
}

export interface ClaudeAdapterOptions {
  /** 手动覆盖 exe 路径（config cliExe.claude）；缺省走探测链 */
  exe?: string | null;
  /** hook 临时目录基座（缺省 <tmp>/kanban-claude-hooks；不硬编码） */
  hookDir?: string;
  /** hook 命令使用的 node 可执行覆盖（缺省 resolveHookNodeBin 探测） */
  hookNodeBin?: string;
  /** 用户级 Claude 基准目录覆盖（listCommands #89：~/.claude/skills 扫描基准；缺省 resolveUserClaudeDir=CLAUDE_CONFIG_DIR 优先，否则 ~/.claude；测试注入 fixture） */
  userClaudeDir?: string;
  /** 测试注入客户端工厂 */
  clientFactory?: (options: ClaudeStreamOptions) => ClaudeStreamClientLike;
  /** #95：标题摘要一次性进程超时 ms（缺省 60s，独立设定不沿用 run-once 300s） */
  summarizeTimeoutMs?: number;
  /** 受控终止（dispose）等待进程实际退出的兜底上限 ms（缺省 3s；注入缩小使超时分支可密封直测，arch C1） */
  stopTimeoutMs?: number;
  /** 诊断日志 */
  log?: (kind: LogKind, detail: string) => void;
}

/** 权限三档映射（spec B 表 Claude 列）：请求=default+permissions.ask 严格工具配置；自动=default（读自动写/Bash 问）；完全访问=--dangerously-skip-permissions（bypassPermissions） */
const PERM_MAP: Record<PermMode, { extraArgs: string[]; strictAsk: boolean }> = {
  ask: { extraArgs: [], strictAsk: true },
  auto: { extraArgs: [], strictAsk: false },
  full: { extraArgs: ["--dangerously-skip-permissions"], strictAsk: false },
};

/** 全能力（approval/interrupt/resume/readHistory 实证于 PoC 7；skillSignal 双信号自本 Adapter 落地）；runOnce 为托管形态能力（worker RunOnceRunner），adapter 单元恒 false（arch C13） */
const CLAUDE_CAPABILITIES: AdapterCapabilities = {
  approval: true,
  interrupt: true,
  resume: true,
  readHistory: true,
  skillSignal: true,
  adoptSession: true,
  runOnce: false,
  listChildPids: true,
};

/** 待决审批：挂起 wire 响应直到用户决定（onControlRequest 挂起 Promise 模式，#8 同款）；KernelApproval 基类之外携带 addRules 规则建议 */
interface PendingApproval extends KernelApproval {
  /** CLI 建议的 addRules 规则（allow-always 原样回传，语义不换写） */
  addRules: Record<string, unknown> | null;
  respond: (wire: unknown) => void;
}

/** 会话状态：TurnState 回合字段（内核单源持有）+ claude wire 层专属字段 */
interface SessionState extends TurnState<PendingApproval> {
  nativeSessionId: string;
  cwd: string;
  model?: string;
  permMode?: PermMode;
  status: SessionStatus;
  /** deny 决定的工具 id（tool_result 到达时映射 denied 而非 failed） */
  deniedToolIds: Set<string>;
  /** 文本增量累计（终文自愈依据；键 `${apiMessageId}:${blockIndex}`） */
  parts: Map<string, string>;
  /** tool_started 时间（durationMs 近似） */
  toolStartedAt: Map<string, number>;
  client: ClaudeStreamClientLike | null;
  hookFiles: SessionHookFiles;
  hookOffset: number;
  dead: boolean;
}

export class ClaudeAdapter implements CliAdapter, CliDirectory {
  readonly capabilities = CLAUDE_CAPABILITIES;
  private readonly sessions = new Map<string, SessionState>();
  private readonly byNative = new Map<string, SessionState>();
  private readonly handlers = new Set<(event: AdapterEvent) => void>();
  private readonly hookDir: string;
  private readonly hookNodeBin: string;
  private readonly userClaudeDir: string | null;
  private readonly clientFactory: (options: ClaudeStreamOptions) => ClaudeStreamClientLike;
  private readonly log: (kind: LogKind, detail: string) => void;
  /** #95：config 手动覆盖 exe（summarizeTitle 的 exe 解析复用同链）与摘要一次性超时 */
  private readonly manualExe: string | null;
  private readonly summarizeTimeoutMs: number;
  /** 受控终止等死兜底上限（可注入；arch C1） */
  private readonly stopTimeoutMs: number;
  /** exe 解析结果缓存（成功才记忆；实现单源在 exe-chain，arch C4） */
  private readonly exeCache = new ExeResolveCache();
  /** 模型目录缓存（listModels #78：握手成功结果复用，进程生命周期内不重复握手；失败清空可重试） */
  private modelsPromise: Promise<ModelEntry[]> | null = null;
  /** 回合内核（arch C1）：emit/排队/终态/幂等中断/死亡收尾单源 */
  private readonly kernel = new TurnKernel<PendingApproval>({
    broadcast: (ev) => {
      for (const h of this.handlers) h(ev);
    },
  });

  constructor(options: ClaudeAdapterOptions = {}) {
    this.log = options.log ?? (() => {});
    this.hookDir = options.hookDir ?? path.join(tmpdir(), "kanban-claude-hooks");
    this.hookNodeBin = resolveHookNodeBin(options.hookNodeBin);
    this.userClaudeDir = options.userClaudeDir ?? null;
    this.manualExe = options.exe ?? null;
    this.summarizeTimeoutMs = options.summarizeTimeoutMs ?? DEFAULT_SUMMARIZE_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    const factory = options.clientFactory;
    if (factory) {
      this.clientFactory = factory;
    } else {
      // 生产：exe 显式解析（手动覆盖 → env → npm 全局 → where/which；缓存成功结果）
      this.clientFactory = (opts) =>
        new ClaudeStreamClient({ ...opts, exe: this.resolveExe(this.manualExe) }) as unknown as ClaudeStreamClientLike;
    }
  }

  private resolveExe(manualOverride: string | null): string {
    return this.exeCache.resolve(CLAUDE_EXE_CHAIN, { manualOverride });
  }

  /** 目录级命令句柄（arch D2）：单实现只服务自身 CLI 身份，直接返回自身目录面 */
  forCli(): CliDirectory {
    return this;
  }

  async createSession(init: CreateSessionInput): Promise<CreateSessionResult> {
    const sessionId = `s-${randomUUID().slice(0, 8)}`;
    // native session id 由我方预生成并经 --session-id 强制指定（CLI 2.x 的 system/init 懒发射——首条 user 消息后才到，实测 2.1.317；不能等 init 拿 id）
    const nativeSessionId = randomUUID();
    const files = prepareSessionHookDir(this.hookDir, sessionId);
    const settingsPath = writeSessionSettings(files, {
      nodeBin: this.hookNodeBin,
      strictAsk: PERM_MAP[init.permMode ?? "auto"].strictAsk,
    });
    try {
      // 先登记（dead=true 占位），spawn 成功后翻转存活；失败则回滚移除
      const s: SessionState = this.newState(sessionId, nativeSessionId, init, files, null);
      s.dead = true;
      this.sessions.set(sessionId, s);
      this.byNative.set(nativeSessionId, s);
      try {
        await this.spawnClient({ owner: s, model: init.model, permMode: init.permMode, settingsPath, sessionArg: ["--session-id", nativeSessionId] });
      } catch (e) {
        this.sessions.delete(sessionId);
        this.byNative.delete(nativeSessionId);
        throw e;
      }
      this.emit(s, { type: "session_status", status: "idle" });
    } catch (e) {
      // #46：spawn 阶段失败协议映射单点（exe 解析失败 → E_SPAWN_NOT_FOUND → renderer spawn 卡）；其余包装为创建失败
      throw mapSpawnFailure(e, "创建 Claude 会话失败");
    }
    return { sessionId, nativeSessionId, model: init.model }; // model 透传（--model spawn 参数；未指定 undefined=账号默认未知，issue #76）
  }

  /** 模型目录（issue #78 / spec #75）：spawn 临时进程 initialize 握手读响应 models 数组（映射规则见 mapInitModels），握手完成进程立即退出；结果 adapter 内缓存（失败不缓存可重试） */
  async listModels(input: ListModelsInput): Promise<ModelEntry[]> {
    if (!this.modelsPromise) {
      this.modelsPromise = this.fetchModelCatalog(input.cwd).catch((e: unknown) => {
        this.modelsPromise = null; // 失败不缓存：下次调用重新握手
        throw e;
      });
    }
    return this.modelsPromise;
  }

  /** 命令列举（issue #89 / spec #82 E 块）：扫描用户级+项目级 skill 目录（纯目录读取不触 CLI 进程；任何读取失败在扫描模块内安全降级） */
  async listCommands(input: ListCommandsInput): Promise<CommandEntry[]> {
    const userDir = this.userClaudeDir ?? resolveUserClaudeDir(process.env, homedir());
    return listClaudeSkillCommands(input.cwd, userDir);
  }

  /** 临时握手进程拉目录：无会话状态（不带 --session-id/--resume/--settings）；finally 确保进程退出不残留 */
  private async fetchModelCatalog(cwd: string): Promise<ModelEntry[]> {
    let wire: ClaudeStreamClientLike;
    try {
      wire = this.clientFactory({ cwd, args: [], log: this.log });
    } catch (e) {
      // #46 对齐 createSession：spawn 阶段失败协议映射单点；其余包装目录拉取失败
      throw mapSpawnFailure(e, "拉取 Claude 模型目录失败");
    }
    try {
      return mapInitModels(await wire.start());
    } catch (e) {
      if (e instanceof AdapterError) throw e;
      throw new AdapterError("E_INTERNAL", `拉取 Claude 模型目录失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      wire.stop(); // 成功/失败 alike：临时进程立即退出
    }
  }

  /** 应用重启后的会话收养（#13 恢复编排的接入点）：按 DB 持久化的 native session id 重建状态（无进程；readHistory 直读 transcript，resume 后可续问） */
  async adoptSession(input: AdoptSessionInput): Promise<void> {
    if (this.sessions.has(input.sessionId)) throw new AdapterError("E_INTERNAL", `会话已存在：${input.sessionId}`);
    const files = prepareSessionHookDir(this.hookDir, input.sessionId);
    const s = this.newState(input.sessionId, input.nativeSessionId, input, files, null);
    s.dead = true; // 无进程：sendTurn 前须 resume
    this.sessions.set(input.sessionId, s);
    this.byNative.set(input.nativeSessionId, s);
    this.emit(s, { type: "session_status", status: "disconnected" });
  }

  async sendTurn(input: SendTurnInput): Promise<void> {
    const s = this.requireLiveSession(input.sessionId);
    // 不变量 6：忙态（turn 进行中/审批待决）排队（内核单源判定）
    if (this.kernel.enqueueIfBusy(s, input.text)) return;
    this.startTurn(s, input.text);
  }

  async interruptTurn(sessionId: string): Promise<void> {
    const s = this.requireLiveSession(sessionId);
    // 幂等闸门（内核单源）：无活动 turn 或已请求过为 no-op
    if (!this.kernel.requestInterrupt(s)) return;
    // 待决审批先拒绝（否则 CLI 停在等应答，interrupt 语义不完整）
    for (const entry of s.pendingApprovals.values()) {
      entry.decided = true;
      s.deniedToolIds.add(entry.itemId);
      entry.respond({ behavior: "deny", message: "用户取消了本轮" });
    }
    s.pendingApprovals.clear();
    if (s.client && !s.client.dead) void s.client.interrupt().catch(() => {});
  }

  /**
   * 会话中途切换模型（issue #79 / spec #75）：向会话活进程发 set_model 控制请求并等确认；
   * 成功以响应 payload 实际模型名回写会话态（进程重启后 resume 以 --model 携带，防静默回退旧模型）；
   * CLI 错误码（invalid_request/catalog_unknown/not_found）与超时/进程异常统一映射 AdapterError，失败不回写。
   */
  async setModel(input: SetModelInput): Promise<{ model: string }> {
    const s = this.requireLiveSession(input.sessionId);
    let actual: string;
    try {
      actual = await s.client!.setModel(input.model);
    } catch (e) {
      if (e instanceof ClaudeSetModelError) {
        throw new AdapterError("E_INTERNAL", `切换 Claude 模型失败（${e.wireCode}）：${e.message}（模型：${input.model}）`);
      }
      throw new AdapterError("E_INTERNAL", `切换 Claude 模型失败：${e instanceof Error ? e.message : String(e)}`);
    }
    s.model = actual; // 回写实际名：resume 重 spawn 以 --model 携带（spec #75：切换不因进程重启丢失）
    return { model: actual };
  }

  /**
   * 一次性标题摘要（#95 / ADR 0003 决策 3）：spawn 独立 `claude -p` 一次性进程——prompt（截断最近对话文本）经 stdin、
   * 会话当前模型经 --model、全新 --session-id（不触碰会话 transcript，上下文零污染）；超时独立设定；断开会话亦可摘要
   * （transcript 落盘为权威源）。无对话素材返回 null；失败/超时抛 AdapterError（调用方静默不重试）。
   */
  async summarizeTitle(sessionId: string): Promise<string | null> {
    const s = this.requireSession(sessionId);
    const transcript = await this.readTranscript(sessionId);
    if (transcript.length === 0) return null;
    const args = ["-p", "--output-format", "text", "--session-id", randomUUID()];
    if (s.model) args.push("--model", s.model);
    try {
      const r = await runTitleOneShot({
        exe: this.resolveExe(this.manualExe),
        args,
        cwd: s.cwd,
        stdin: buildSummaryPrompt(transcript),
        timeoutMs: this.summarizeTimeoutMs,
        log: this.log,
      });
      if (r.exitCode !== 0) {
        throw new AdapterError("E_INTERNAL", `Claude 标题摘要失败（exit ${r.exitCode}）：${r.stderr.trim().slice(0, 200)}`);
      }
      return toTitleLine(r.stdout) || null;
    } catch (e) {
      // #46 对齐 createSession：spawn 阶段失败协议映射单点；runTitleOneShot 的启动/超时错误与 exit 非零包装均为 AdapterError 原样透传
      throw mapSpawnFailure(e, "Claude 标题摘要失败");
    }
  }

  async resolveApproval(input: ResolveApprovalInput): Promise<void> {
    const s = this.requireLiveSession(input.sessionId);
    const entry = s.pendingApprovals.get(input.requestId);
    if (!entry || entry.decided) {
      throw new AdapterError("E_APPROVAL_EXPIRED", `审批请求不存在或已终结：${input.requestId}`);
    }
    entry.decided = true;
    s.pendingApprovals.delete(input.requestId);
    entry.respond(approvalWire(input.decision, entry));
    if (input.decision === "deny") s.deniedToolIds.add(entry.itemId);
    // 仍有待决审批（CLI 并行工具调用多控制请求）时保持 waiting——回 running 会掩盖待决卡并误导空闲等待（issue #39）
    if (s.turnActive && s.pendingApprovals.size === 0) this.emit(s, { type: "session_status", status: "running" });
  }

  async readHistory(sessionId: string): Promise<ChatEvent[]> {
    const s = this.requireSession(sessionId);
    this.tailHookEvents(s); // 断开期间迟到的 hook 行（verified 信号）先消费
    this.backfillFromTranscript(s);
    return [...s.log];
  }

  /** readTranscript（#28）：transcript 文件即权威原生历史 —— 直读解析为 user/assistant 双视角（不依赖进程状态，不与实时流去重） */
  async readTranscript(sessionId: string): Promise<TranscriptEvent[]> {
    const s = this.requireSession(sessionId);
    const file = findTranscriptFile(s.nativeSessionId, s.cwd);
    if (!file) return []; // 尚无 turn 的会话：无落盘历史，空数组为诚实行为
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch (e) {
      // 读失败不冒充完整（spec #27「缺失会话明确列出」）：报错由提取管线记为缺失
      throw new AdapterError("E_INTERNAL", `读取 Claude transcript 失败：${e instanceof Error ? e.message : String(e)}`);
    }
    return parseTranscriptEvents(content);
  }

  async resume(sessionId: string): Promise<void> {
    const s = this.requireSession(sessionId);
    if (s.client && !s.client.dead && !s.dead) {
      // 进程内存活：复位活动残留（与 Codex 同语义；内核单源复位）
      this.kernel.resetForResume(s);
      this.emit(s, { type: "session_status", status: "idle" });
      return;
    }
    // 进程死亡/收养会话：spawn 新进程 --resume（poc-7 T4：session id 不变、上下文无损续问）
    const settingsPath = writeSessionSettings(s.hookFiles, {
      nodeBin: this.hookNodeBin,
      strictAsk: PERM_MAP[s.permMode ?? "auto"].strictAsk,
    });
    try {
      this.kernel.resetForResume(s); // 丢弃死亡期残留排队/闸门再续进程
      await this.spawnClient({ owner: s, model: s.model, permMode: s.permMode, settingsPath, sessionArg: ["--resume", s.nativeSessionId] });
      this.emit(s, { type: "session_status", status: "idle" });
    } catch (e) {
      throw new AdapterError("E_INTERNAL", `恢复 Claude 会话失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async dispose(input?: DisposeInput): Promise<void> {
    if (input?.sessionId) {
      // Session 粒度：停止本会话进程并移除状态（每会话一进程，无共享）
      const s = this.sessions.get(input.sessionId);
      if (!s) return;
      await this.stopClient(s.client);
      this.sessions.delete(input.sessionId);
      this.byNative.delete(s.nativeSessionId);
      return;
    }
    // 全局：受控终止全部进程并等待实际退出（onDead 链发 session_exit/disconnected；状态保留供 resume；有限等待防挂）
    await Promise.all([...this.sessions.values()].map((s) => this.stopClient(s.client)));
  }

  /** 受控终止单个客户端：等待实际退出（兜底上限可注入），保证 dispose 返回时 session_exit 已入事件流 */
  private async stopClient(client: ClaudeStreamClientLike | null): Promise<void> {
    if (!client || client.dead) return;
    await stopAndAwaitExit(client, this.stopTimeoutMs);
  }

  subscribe(handler: (event: AdapterEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** C5 演进（#44）：单进程单会话模型 —— 每个存活会话的客户端各报一份 pid；死亡/断开不报陈旧 pid（防 pid 复用误判） */
  async listChildPids(): Promise<number[]> {
    const pids = new Set<number>();
    for (const s of this.sessions.values()) {
      const pid = s.client && !s.client.dead ? s.client.pid : null;
      if (pid) pids.add(pid);
    }
    return [...pids];
  }

  /* ---------------- 内部：进程与协议挂接 ---------------- */

  /** spawn 客户端并完成 initialize 握手，挂接消息/死亡处理后翻转会话存活（--session-id/--resume 经 sessionArg 传入） */
  private async spawnClient(input: {
    owner: SessionState;
    model?: string;
    permMode?: PermMode;
    settingsPath: string;
    sessionArg: string[];
  }): Promise<void> {
    const s = input.owner;
    const args = ["--settings", input.settingsPath, ...PERM_MAP[input.permMode ?? "auto"].extraArgs, ...input.sessionArg];
    if (input.model) args.push("--model", input.model);
    const wire = this.clientFactory({ cwd: s.cwd, args, log: this.log });
    wire.onDead((err) => this.handleProcessDeath(s, err));
    await wire.start();
    wire.onMessage((msg) => this.onStreamMessage(s, msg));
    s.client = wire;
    s.dead = false;
  }

  private newState(
    sessionId: string,
    nativeSessionId: string,
    init: { cwd: string; model?: string; permMode?: PermMode },
    files: SessionHookFiles,
    wire: ClaudeStreamClientLike | null,
  ): SessionState {
    return {
      sessionId,
      nativeSessionId,
      cwd: init.cwd,
      model: init.model,
      permMode: init.permMode,
      seq: 0,
      log: [],
      status: "idle",
      turnActive: false,
      interruptRequested: false,
      queue: [],
      pendingApprovals: new Map(),
      deniedToolIds: new Set(),
      parts: new Map(),
      toolStartedAt: new Map(),
      client: wire,
      hookFiles: files,
      hookOffset: 0,
      dead: false,
    };
  }

  /** 全部 stdout 消息分发（system/assistant/user/stream_event/result/control_request） */
  private onStreamMessage(s: SessionState, msg: Record<string, unknown>): void {
    if (s.dead) return;
    switch (msg.type) {
      case "system":
        // 防御：init 懒到达时校验实报 id 与 --session-id 预指定一致；不一致以实报为准重挂索引
        if (msg.subtype === "init" && typeof msg.session_id === "string" && msg.session_id !== s.nativeSessionId) {
          this.log("session-id-mismatch", `${s.nativeSessionId} -> ${msg.session_id}`);
          this.byNative.delete(s.nativeSessionId);
          s.nativeSessionId = msg.session_id;
          this.byNative.set(s.nativeSessionId, s);
        }
        break;
      case "stream_event":
        this.handleStreamEvent(s, msg);
        break;
      case "assistant":
        this.handleAssistant(s, msg);
        break;
      case "user":
        this.handleUserMessage(s, msg);
        break;
      case "result":
        this.handleResult(s, msg);
        break;
      case "control_request":
        this.handleControlRequest(s, msg);
        break;
      default:
        break;
    }
    // 消息驱动的 hook JSONL 增量消费（stream_event 高频不触发，assistant/user/result 才可能伴随 hook）
    if (msg.type !== "stream_event") this.tailHookEvents(s);
  }

  /** 文本增量（--include-partial-messages）：content_block_delta(text_delta) → message_delta（thinking 不映射） */
  private handleStreamEvent(s: SessionState, msg: Record<string, unknown>): void {
    const event = msg.event as Record<string, unknown> | undefined;
    if (!event || event.type !== "content_block_delta") return;
    const delta = event.delta as Record<string, unknown> | undefined;
    if (!delta || delta.type !== "text_delta" || typeof delta.text !== "string") return;
    const itemId = String(msg.api_message_id ?? "");
    const partId = String(event.index ?? 0);
    if (!itemId) return;
    const key = `${itemId}:${partId}`;
    s.parts.set(key, (s.parts.get(key) ?? "") + delta.text);
    this.emit(s, { type: "message_delta", itemId, partId, delta: delta.text });
  }

  /** assistant 消息：text 块终文自愈补 delta + message_completed；tool_use 块 → tool_started + Skill 流内 self_reported。
   *  Claude 2.1.317 把一轮回复按块拆成多行 assistant（thinking/text 各一行）：流式 content_block_delta 的 index 是
   *  API 消息 content 的绝对下标（thinking 占 0、text 占 1），而终文 assistant 行的 content 内 text 块重新编号到 0。
   *  直接用 content 数组下标当 partId 会与流式键错位生成两个气泡——按 itemId 找已有文本增量、以内容前缀对齐复用其 partId。 */
  private handleAssistant(s: SessionState, msg: Record<string, unknown>): void {
    const message = msg.message as { id?: string; content?: unknown } | undefined;
    if (!message || !Array.isArray(message.content) || !message.id) return;
    const blocks = message.content as Record<string, unknown>[];
    const itemId = String(message.id);
    blocks.forEach((block, index) => {
      if (block.type === "text" && typeof block.text === "string") {
        // 同一 itemId 下已有流式文本增量时复用其 partId（按累计内容前缀匹配，容忍终文补齐/拆分行）
        const partId = this.matchTextPart(s, itemId, block.text) ?? String(index);
        const key = `${itemId}:${partId}`;
        const acc = s.parts.get(key) ?? "";
        if (block.text.startsWith(acc) && block.text.length > acc.length) {
          this.emit(s, { type: "message_delta", itemId, partId, delta: block.text.slice(acc.length) });
        } else if (!block.text.startsWith(acc)) {
          this.log("text-mismatch", `itemId=${itemId} acc(${acc.length})!=final(${block.text.length})`);
        }
        s.parts.set(key, block.text);
        this.emit(s, { type: "message_completed", itemId, partId });
      } else if (block.type === "tool_use" && typeof block.id === "string") {
        const name = String(block.name ?? "tool");
        s.toolStartedAt.set(block.id, Date.now());
        this.emit(s, { type: "tool_started", itemId: block.id, tool: name, argsSummary: safeJson(block.input) });
        // SkillObservation 流内信号（spec B：stream 中 tool_use:Skill → self_reported；verified 由 hook 升级）
        if (name === "Skill") {
          const input = (block.input ?? {}) as Record<string, unknown>;
          const skill = (input.skill as string | undefined) ?? (input.command as string | undefined);
          if (skill) {
            this.emitObservation(s, {
              eventId: `claude-stream:${s.sessionId}:${block.id}`,
              skill,
              evidenceLevel: "self_reported",
              source: "claude-stream",
              occurredAt: new Date().toISOString(),
            });
          }
        }
      }
    });
  }

  /** 终文 text 块对齐流式归并键：同 itemId 下找累计增量是终文前缀的 part（若无流式增量返回 null，沿用 content 下标） */
  private matchTextPart(s: SessionState, itemId: string, finalText: string): string | null {
    const prefix = `${itemId}:`;
    let best: string | null = null;
    for (const [key, acc] of s.parts) {
      if (!key.startsWith(prefix) || !finalText.startsWith(acc)) continue;
      // 多个候选（异常重复流）取累计最长者，避免短前缀误匹配
      if (best === null || acc.length > (s.parts.get(`${prefix}${best}`) ?? "").length) best = key.slice(prefix.length);
    }
    return best;
  }

  /** user 消息（tool_result）：→ tool_completed（deny 决定的 id → denied） */
  private handleUserMessage(s: SessionState, msg: Record<string, unknown>): void {
    const message = msg.message as { content?: unknown } | undefined;
    if (!message || !Array.isArray(message.content)) return;
    for (const it of message.content as Record<string, unknown>[]) {
      if (it.type !== "tool_result" || typeof it.tool_use_id !== "string") continue;
      const itemId = it.tool_use_id;
      const started = s.toolStartedAt.get(itemId);
      const durationMs = started ? Date.now() - started : 0;
      s.toolStartedAt.delete(itemId);
      const denied = s.deniedToolIds.delete(itemId);
      this.emit(s, {
        type: "tool_completed",
        itemId,
        status: denied ? "denied" : "completed",
        durationMs,
        output: flattenToolResult(it.content),
      });
    }
  }

  /** result 轮终态：success 且无错 → completed；error_during_execution+已请求中断 → 已取消（GUI 非报错，PoC 7 T2）；
   *  success+is_error → API 级失败（认证失效在此形态到达，claude 2.1.317 实证 subtype 仍为 success，#41）；
   *  其余 → session_error（#41 枚举映射：401/403 或认证文本 → AUTH_EXPIRED，否则 INTERNAL） */
  private handleResult(s: SessionState, msg: Record<string, unknown>): void {
    const subtype = String(msg.subtype ?? "");
    if (subtype === "success" && msg.is_error === true) {
      const apiStatus = typeof msg.api_error_status === "number" ? msg.api_error_status : null;
      this.emitTurnError(s, String(msg.result ?? `claude turn 失败（api error）`), apiStatus);
      this.finishTurn(s, "failed");
      this.scheduleLateHookScan(s);
      return;
    }
    if (subtype === "success") {
      this.finishTurn(s, "completed");
      this.scheduleLateHookScan(s);
      return;
    }
    if (subtype === "error_during_execution" && s.interruptRequested) {
      this.finishTurn(s, "interrupted");
      return;
    }
    this.emitTurnError(s, String(msg.result ?? `claude turn 失败（${subtype || "unknown"}）`), null);
    this.finishTurn(s, "failed");
    this.scheduleLateHookScan(s);
  }

  /** turn 失败报错发射（#41）：结构化 api_error_status 优先（401/403 → AUTH_EXPIRED），无结构化状态时按协议错误文本归类 */
  private emitTurnError(s: SessionState, message: string, apiStatus: number | null): void {
    const code = apiStatus !== null ? (isAuthFailureStatus(apiStatus) ? "AUTH_EXPIRED" : "INTERNAL") : isAuthFailureText(message) ? "AUTH_EXPIRED" : "INTERNAL";
    this.emit(s, { type: "session_error", code, message });
  }

  /** CLI→host 控制请求：can_use_tool 审批（--permission-prompt-tool=stdio 前提） */
  private handleControlRequest(s: SessionState, msg: Record<string, unknown>): void {
    const request = (msg.request ?? {}) as Record<string, unknown>;
    if (request.subtype !== "can_use_tool") {
      this.log("unknown-control-request", String(request.subtype ?? ""));
      return;
    }
    const requestId = String(msg.request_id ?? "");
    if (!requestId) return;
    const toolName = String(request.tool_name ?? "");
    const input = (request.input ?? {}) as Record<string, unknown>;
    const itemId = typeof request.tool_use_id === "string" ? request.tool_use_id : `ap-${requestId}`;
    const suggestions = Array.isArray(request.permission_suggestions) ? (request.permission_suggestions as Record<string, unknown>[]) : [];
    const addRules = suggestions.find((x) => x.type === "addRules") ?? null;
    this.emit(s, {
      type: "approval_requested",
      requestId,
      itemId,
      command: describeCommand(toolName, input),
      suggestions: suggestions.map(mapSuggestion),
    });
    this.emit(s, { type: "session_status", status: "waiting" });
    s.pendingApprovals.set(requestId, {
      requestId,
      itemId,
      decided: false,
      addRules,
      respond: (wire) => s.client?.respondControlRequest(requestId, wire),
    });
  }

  /* ---------------- 内部：turn 驱动与终态 ---------------- */

  private startTurn(s: SessionState, text: string): void {
    this.kernel.beginTurn(s);
    this.emit(s, { type: "session_status", status: "running" });
    this.emit(s, { type: "turn_started", turnId: `t-${randomUUID().slice(0, 8)}` });
    s.client?.sendUser(text);
  }

  /** turn 终态统一收尾（内核单源终态机）：残留审批强制拒绝（claude wire 应答形状）+ completed 续发排队 */
  private finishTurn(s: SessionState, status: "completed" | "interrupted" | "failed"): void {
    this.kernel.finishTurn(s, status, {
      onResidue: (st) => {
        // 防护：终态后残留审批强制拒绝（CLI 进程侧无害；UI 不留挂起卡）
        for (const entry of st.pendingApprovals.values()) {
          entry.decided = true;
          s.deniedToolIds.add(entry.itemId);
          entry.respond({ behavior: "deny", message: "turn 已结束" });
        }
      },
      sendQueuedTurn: (next) => this.startTurn(s, next),
    });
  }

  /** 进程死亡：明确报错不重放；状态保留供 resume（收尾单源在内核，审批残留经 approval_expired 事件收口） */
  private handleProcessDeath(s: SessionState, err: Error): void {
    if (s.dead) return;
    s.dead = true;
    const exitCode = s.client?.exitInfo?.code;
    this.kernel.handleDeath(s, {
      exitCode: typeof exitCode === "number" ? exitCode : 1,
      reason: err.message,
      onApprovalResidue: (entry) => this.emit(s, { type: "approval_expired", requestId: entry.requestId, reason: "session_dead" }),
    });
  }

  /* ---------------- 内部：hook verified 信号与 transcript 回填 ---------------- */

  /** hook JSONL 增量消费 → transformHookEvents → verified SkillObservation（native sessionId → 应用侧映射；eventId 幂等） */
  private tailHookEvents(s: SessionState): void {
    const { lines, offset } = tailJsonl(s.hookFiles.eventsPath, s.hookOffset);
    if (offset > s.hookOffset) s.hookOffset = offset;
    if (lines.length === 0) return;
    for (const ev of transformHookEvents(lines)) {
      if (!ev.sessionId || !ev.skill) continue;
      const owner = this.byNative.get(ev.sessionId);
      if (!owner || owner.sessionId !== s.sessionId) continue; // 他会话 hook 行不误认
      this.emitObservation(owner, {
        eventId: ev.eventId,
        skill: ev.skill,
        evidenceLevel: "verified",
        source: "claude-hook",
        occurredAt: ev.occurredAt,
      });
    }
  }

  /** result 后延迟复扫（PostToolUse hook 进程与 result 消息存在写入竞态） */
  private scheduleLateHookScan(s: SessionState): void {
    setTimeout(() => {
      if (!s.dead) this.tailHookEvents(s);
    }, 500).unref();
  }

  /** transcript 直读回填：与本进程实时流同键去重后补入事件日志（快照+增量无缝拼接，不变量 4） */
  private backfillFromTranscript(s: SessionState): void {
    const file = findTranscriptFile(s.nativeSessionId, s.cwd);
    if (!file) return;
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      return; // CLI 并发写入窗口的极端读取失败：本轮跳过（下次 readHistory 重试）
    }
    const existing = new Set<string>();
    for (const e of s.log) {
      if (e.type === "message_delta" || e.type === "message_completed") existing.add(`msg:${e.itemId}:${e.partId}`);
      else if (e.type === "tool_started" || e.type === "tool_completed") existing.add(`tool:${e.itemId}`);
    }
    // itemId → 已见终文集合：thinking 拆分 wire 下流式 partId 为绝对下标、transcript content 内下标为 0，
    // 键对不上但同一段终文内容一致——按 (itemId, 终文) 兜底去重，避免 readHistory 恢复后重复气泡。
    const seenTexts = new Map<string, Set<string>>();
    for (const [key, text] of s.parts) {
      const itemId = key.slice(0, key.lastIndexOf(":"));
      if (!seenTexts.has(itemId)) seenTexts.set(itemId, new Set());
      seenTexts.get(itemId)!.add(text);
    }
    const isSeen = (item: { dedupeKeys: string[]; seeds: Array<{ seed: ChatEventSeed; at: string }> }): boolean => {
      if (item.dedupeKeys.every((k) => existing.has(k))) return true;
      const seed = item.seeds.find((x) => x.seed.type === "message_delta")?.seed;
      return seed?.type === "message_delta" ? (seenTexts.get(seed.itemId)?.has(seed.delta) ?? false) : false;
    };
    for (const turn of parseTranscriptItems(content)) {
      const unseen = turn.items.filter((item) => !isSeen(item));
      if (unseen.length === 0) continue; // 该轮已全部实时见过 → 整轮跳过（无重复）
      this.emit(s, { type: "turn_started", turnId: `t-${randomUUID().slice(0, 8)}` }, turn.at);
      for (const item of unseen) {
        for (const { seed, at } of item.seeds) this.emit(s, seed, at);
      }
      this.emit(s, { type: "turn_completed" }, turn.at);
    }
  }

  /* ---------------- 内部：事件与工具 ---------------- */

  /** ChatEvent 出口（内核单源：seq 单调 + at 可指定 transcript 时间戳 + 写日志 + 广播；SkillObservation 直发订阅者不入日志） */
  private emit(s: SessionState, ev: ChatEventSeed, at?: string): void {
    this.kernel.emit(s, ev, at);
  }

  private emitObservation(s: SessionState, base: { eventId: string; skill: string; evidenceLevel: "verified" | "self_reported"; source: string; occurredAt: string }): void {
    const obs: SkillObservation = {
      eventId: base.eventId,
      kind: "skill",
      sessionId: s.sessionId,
      cli: "claude-code",
      skill: base.skill,
      stage: null,
      requirementId: null,
      occurredAt: base.occurredAt,
      receivedAt: new Date().toISOString(),
      seq: null,
      evidenceLevel: base.evidenceLevel,
      source: base.source,
    };
    for (const h of this.handlers) h(obs);
  }

  private requireSession(sessionId: string): SessionState {
    return requireSessionEntry(this.sessions, sessionId);
  }

  private requireLiveSession(sessionId: string): SessionState {
    return requireLiveSessionEntry(this.sessions, sessionId, (s) => s.dead || !s.client || s.client.dead, "Claude 进程已退出");
  }
}

/* ---------------- wire 映射工具 ---------------- */

/** initialize 响应内层载荷 → 目录条目（claude 2.1.317 实测形状：models 数组项含 value/resolvedModel/displayName/description）：value→id；value 为 default 的占位项过滤（spec #75 避免「默认」字样）；isDefault 取 default 占位项的 resolvedModel（账号默认模型 id）与条目 value/resolvedModel 比对，无匹配则无默认项 */
function mapInitModels(payload: Record<string, unknown>): ModelEntry[] {
  const raw = payload.models;
  if (!Array.isArray(raw)) {
    throw new Error("initialize 响应不含 models 数组（claude 协议可能已变更，请报告）");
  }
  const items = raw as Array<Record<string, unknown> | null>;
  const defaultEntry = items.find((m) => m?.value === "default");
  const defaultId = typeof defaultEntry?.resolvedModel === "string" ? defaultEntry.resolvedModel : "";
  const entries: ModelEntry[] = [];
  for (const m of items) {
    if (!m) continue;
    const value = typeof m.value === "string" ? m.value : "";
    if (!value || value === "default") continue;
    const resolved = typeof m.resolvedModel === "string" && m.resolvedModel ? m.resolvedModel : value;
    entries.push({
      id: value,
      displayName: typeof m.displayName === "string" && m.displayName ? m.displayName : value,
      description: typeof m.description === "string" ? m.description : "",
      isDefault: value === defaultId || resolved === defaultId,
    });
  }
  return entries;
}

/** 统一审批决定 → can_use_tool wire 响应（SDK PermissionResult 形状；allow-always 原样回传 CLI 建议的 addRules 规则，语义不换写） */
function approvalWire(decision: string, entry: PendingApproval): unknown {
  if (decision === "allow-once") return { behavior: "allow" };
  if (decision === "allow-always") {
    return entry.addRules
      ? { behavior: "allow", updatedPermissions: [entry.addRules] }
      : { behavior: "allow" }; // CLI 未给规则建议：退化为本次放行
  }
  return { behavior: "deny", message: "用户在 kanban-desktop 拒绝了该操作" };
}

/** 审批卡命令摘要：按工具取最具信息量的输入字段 */
function describeCommand(toolName: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return null;
  };
  const described = pick("command", "file_path", "notebook_path", "path", "url", "skill", "command_name", "pattern", "prompt", "description");
  if (described) return `${toolName}: ${described}`;
  const json = safeJson(input);
  return json ? `${toolName}: ${json.slice(0, 120)}` : toolName;
}

/** permission_suggestions（addRules/addDirectories）→ 审批建议项（spec I-5 建议行） */
function mapSuggestion(s: Record<string, unknown>): ApprovalSuggestion {
  if (s.type === "addRules" && Array.isArray(s.rules)) {
    const rules = s.rules as Array<{ toolName?: string; ruleContent?: string }>;
    const label = rules.map((r) => `${r.toolName ?? ""}(${r.ruleContent ?? ""})`).join(" ").trim();
    return { kind: "rule", label: label || "允许同类操作", detail: `总是允许（${String(s.destination ?? "session")}）` };
  }
  if (s.type === "addDirectories" && Array.isArray(s.directories)) {
    return { kind: "directory", label: (s.directories as string[]).join("、"), detail: "允许访问以下目录（本会话）" };
  }
  return { kind: String(s.type ?? "other"), label: safeJson(s).slice(0, 80), detail: "" };
}

function flattenToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Record<string, unknown>[]).map((c) => (typeof c.text === "string" ? c.text : "")).join("");
  }
  return safeJson(content);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}
