// 用途：OpenCodeAdapter —— C1 契约的真实 OpenCode 实现：HTTP+SSE 直连（poc-3 client 演进）、server-per-project（经 OpenCodeServerHost）、审批轮询 GET /permission + SSE replied 兜底、/command 路由 self_reported SkillObservation、abort 归类已取消、按 native session id 跨重启恢复 + readTranscript message API 双视角（#28）
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LogKind, AdapterEvent, ApprovalDecision, ApprovalSuggestion, ChatEvent, ChatEventSeed, PermMode, SessionStatus, SkillObservation, TranscriptEvent } from "@kanban/ipc-schema";
import { AdapterError, ExeNotFoundError, type AdapterCapabilities, type CliAdapter, type CreateSessionInput, type DisposeInput, type ResolveApprovalInput, type SendTurnInput } from "./adapter";
import type { OpenCodeSseEvent, OpenCodeServerClientLike } from "./opencode/client";
import { OpenCodeServerHost, type OpenCodeServerHostLike, type OpenCodeServerHostOptions } from "./opencode/server-host";
import { isAuthFailureStatus, isAuthFailureText, isProtocolDisconnectText } from "./session-error";

/** 全能力（approval/interrupt/resume/readHistory 实证于 poc-3 + 1.15.7 探针；skillSignal=command 路由 self_reported） */
const OPENCODE_CAPABILITIES: AdapterCapabilities = {
  approval: true,
  interrupt: true,
  resume: true,
  readHistory: true,
  skillSignal: true,
};

/** magpie 网关模型 ID 含斜杠：按第一个斜杠切 provider，余下合并为 model（poc-3 §10.1） */
export function splitModelId(model: string): { providerID: string; modelID: string } {
  const idx = model.indexOf("/");
  if (idx <= 0) return { providerID: "", modelID: model };
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

/** turn 提交/command 请求失败文本 → session_error.code 归类（#41）：认证 → AUTH_EXPIRED；传输不可达 → PROTOCOL_DISCONNECT；其余 INTERNAL */
function classifyTransportFailure(message: string): "AUTH_EXPIRED" | "PROTOCOL_DISCONNECT" | "INTERNAL" {
  if (isAuthFailureText(message)) return "AUTH_EXPIRED";
  if (isProtocolDisconnectText(message)) return "PROTOCOL_DISCONNECT";
  return "INTERNAL";
}

export interface OpenCodeAdapterOptions extends Omit<OpenCodeServerHostOptions, "exe"> {
  /** config cliExe.opencode 手动覆盖（透传 host 探测链） */
  exe?: string | null;
  /** server-per-project 宿主（缺省构造 OpenCodeServerHost；测试注入 FakeHost） */
  host?: OpenCodeServerHostLike;
  /** 审批轮询间隔（缺省 500ms；测试调小） */
  pollIntervalMs?: number;
  /** running 静默多久进入卡死探测（缺省 60s；SSE 断线丢 session.idle 帧的自愈窗口，测试调小） */
  stuckIdleMs?: number;
  /** 卡死确认：连续两次快照探测的最小间隔（缺省 10s；内容零变化才收尾，测试调小） */
  stuckConfirmMs?: number;
  /** 诊断日志 */
  log?: (kind: LogKind, detail: string) => void;
}

/** 待决审批：轮询/SSE asked 发现；POST 响应终结 */
interface PendingApproval {
  requestId: string;
  itemId: string;
  decided: boolean;
}

interface ToolTrack {
  tool: string;
  startedAtMs: number;
  lastOutput: string;
  terminal: boolean;
}

interface SessionState {
  sessionId: string;
  nativeId: string;
  cwd: string;
  model?: string;
  permMode?: PermMode;
  seq: number;
  log: ChatEvent[];
  status: SessionStatus;
  turnActive: boolean;
  interruptRequested: boolean;
  /** 本 turn 出现过审批（审批必然伴随工具执行：idle 对账触发条件之一，覆盖工具帧全丢形态） */
  turnHadApproval: boolean;
  /** idle 终结对账进行中（防重入：对账期间再到的 idle 不重复收尾） */
  finishPending: boolean;
  /** 本会话最近一条 ChatEvent 时刻（running 卡死判定基准；SSE 静默时长） */
  lastEventAtMs: number;
  /** 卡死探测记忆（连续两次 /message 快照零变化 → 判定 turn 已终结） */
  stuckProbe: { key: string; at: number } | null;
  lastTurnError: { name: string; message: string } | null;
  queue: string[];
  pendingApprovals: Map<string, PendingApproval>;
  expiredApprovals: Set<string>;
  /** deny 决定的工具 part（error 终态映射 denied） */
  deniedToolIds: Set<string>;
  /** deny 决定时工具 part 尚未到达（审批先于 part 事件）：下一个 error 终态 part 映射 denied */
  unboundDeny: boolean;
  /** 文本增量累计（终文自愈依据；键 `${messageID}:${partID}`） */
  parts: Map<string, string>;
  /** partId → 原生 part 类型（reasoning 等 delta 降噪依据；未知类型按 text 放行由快照纠偏） */
  partTypes: Map<string, string>;
  tools: Map<string, ToolTrack>;
  /** 出现过 delta 的 itemId（message_completed 终结范围）与各 itemId 最近 partId */
  itemIdsWithDeltas: Set<string>;
  lastPartId: Map<string, string>;
  completedItems: Set<string>;
  activeMessageId: string | null;
  client: OpenCodeServerClientLike | null;
  dead: boolean;
}

export class OpenCodeAdapter implements CliAdapter {
  readonly capabilities = OPENCODE_CAPABILITIES;
  private readonly sessions = new Map<string, SessionState>();
  private readonly byNative = new Map<string, SessionState>();
  private readonly handlers = new Set<(event: AdapterEvent) => void>();
  private readonly host: OpenCodeServerHostLike;
  private readonly ownHost: OpenCodeServerHost | null;
  private readonly log: (kind: LogKind, detail: string) => void;
  private readonly pollIntervalMs: number;
  private readonly stuckIdleMs: number;
  private readonly stuckConfirmMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollBusy = false;
  /** server 客户端级缓存：command 名单 / 默认模型 */
  private readonly commandCache = new Map<OpenCodeServerClientLike, Set<string>>();
  private readonly modelCache = new Map<OpenCodeServerClientLike, { providerID: string; modelID: string } | null>();

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.log = options.log ?? (() => {});
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.stuckIdleMs = options.stuckIdleMs ?? 60_000;
    this.stuckConfirmMs = options.stuckConfirmMs ?? 10_000;
    if (options.host) {
      this.host = options.host;
      this.ownHost = null;
    } else {
      this.ownHost = new OpenCodeServerHost({
        ...options,
        exe: options.exe ?? null,
        registryPath: options.registryPath ?? defaultRegistryPath(),
        log: this.log,
      });
      this.host = this.ownHost;
    }
  }

  async createSession(init: CreateSessionInput): Promise<{ sessionId: string; nativeSessionId?: string | null }> {
    const sessionId = `s-${randomUUID().slice(0, 8)}`;
    // 权限档位缺省=⚡自动（spec B 默认档）：undefined 不落在原生默认（无注入=全放行），保证审批语义一致
    const mode = init.permMode ?? "auto";
    // 先以应用侧 sessionId 登记 server 引用（避免中间态引用归零误停 server）
    let client: OpenCodeServerClientLike;
    try {
      client = await this.host.acquire(init.cwd, mode, sessionId);
    } catch (e) {
      // #46：exe 解析失败协议级映射（E_SPAWN_NOT_FOUND → renderer spawn 卡）；其余包装为创建失败
      if (e instanceof ExeNotFoundError) throw new AdapterError("E_SPAWN_NOT_FOUND", e.message);
      if (e instanceof AdapterError) throw e;
      throw new AdapterError("E_INTERNAL", e instanceof Error ? e.message : String(e));
    }
    let nativeId: string;
    try {
      const r = await client.api("POST", "/session", { title: `kanban-${new Date().toISOString().slice(0, 10)}` });
      if (!r.ok || !(r.json as { id?: string } | null)?.id) {
        throw new Error(`创建 OpenCode 会话失败：HTTP ${r.status} ${r.text.slice(0, 160)}`);
      }
      nativeId = String((r.json as { id: string }).id);
    } catch (e) {
      await this.host.release(init.cwd, sessionId).catch(() => {});
      throw new AdapterError("E_INTERNAL", e instanceof Error ? e.message : String(e));
    }
    const s: SessionState = this.newState(sessionId, nativeId, { ...init, permMode: mode });
    this.attachServer(s, client);
    this.sessions.set(sessionId, s);
    this.byNative.set(nativeId, s);
    this.emit(s, { type: "session_status", status: "idle" });
    return { sessionId, nativeSessionId: nativeId };
  }

  /** 应用重启后的会话收养（#13 恢复编排接入点）：登记 native id（无连接；readHistory/resume 按需拉起 server） */
  async adoptSession(input: { sessionId: string; nativeSessionId: string; cwd: string; permMode?: PermMode; model?: string }): Promise<void> {
    if (this.sessions.has(input.sessionId)) throw new AdapterError("E_INTERNAL", `会话已存在：${input.sessionId}`);
    const s = this.newState(input.sessionId, input.nativeSessionId, { ...input, permMode: input.permMode ?? "auto" });
    s.dead = true;
    this.sessions.set(input.sessionId, s);
    this.byNative.set(input.nativeSessionId, s);
    this.emit(s, { type: "session_status", status: "disconnected" });
  }

  async sendTurn(input: SendTurnInput): Promise<void> {
    const s = this.requireLiveSession(input.sessionId);
    // 不变量 6：忙态（turn 进行中/审批待决）排队
    if (s.turnActive || s.pendingApprovals.size > 0) {
      s.queue.push(input.text);
      return;
    }
    // /command 路由："/" 开头且命中已知 command → command API + self_reported 观察；未命中按普通 prompt（spec B）
    const command = input.text.startsWith("/") ? await this.matchCommand(s, input.text) : null;
    await this.startTurn(s, input.text, command);
  }

  async interruptTurn(sessionId: string): Promise<void> {
    const s = this.requireLiveSession(sessionId);
    // 幂等：无活动 turn 时 no-op
    if (!s.turnActive && s.pendingApprovals.size === 0) return;
    if (s.interruptRequested) return;
    s.interruptRequested = true;
    // 待决审批先拒绝（否则 server 停在等应答，interrupt 语义不完整）；工具 part 将以 error 终态 → denied
    for (const entry of s.pendingApprovals.values()) {
      entry.decided = true;
      s.deniedToolIds.add(entry.itemId);
      void s.client?.api("POST", `/session/${s.nativeId}/permissions/${entry.requestId}`, { response: "reject" }).catch(() => {});
      this.emit(s, { type: "approval_expired", requestId: entry.requestId, reason: "user_interrupt" });
    }
    s.pendingApprovals.clear();
    void s.client?.api("POST", `/session/${s.nativeId}/abort`).catch(() => {});
  }

  async resolveApproval(input: ResolveApprovalInput): Promise<void> {
    const s = this.requireLiveSession(input.sessionId);
    const entry = s.pendingApprovals.get(input.requestId);
    if (!entry || entry.decided) {
      throw new AdapterError("E_APPROVAL_EXPIRED", `审批请求不存在或已终结：${input.requestId}`);
    }
    let r;
    try {
      r = await s.client!.api("POST", `/session/${s.nativeId}/permissions/${input.requestId}`, { response: approvalWire(input.decision) });
    } catch (e) {
      throw new AdapterError("E_APPROVAL_EXPIRED", `审批响应发送失败（可能已被服务端终结）：${e instanceof Error ? e.message : String(e)}`);
    }
    if (!r.ok) {
      s.pendingApprovals.delete(input.requestId);
      s.expiredApprovals.add(input.requestId);
      throw new AdapterError("E_APPROVAL_EXPIRED", `审批请求已被服务端终结：HTTP ${r.status}`);
    }
    entry.decided = true;
    s.pendingApprovals.delete(input.requestId);
    if (input.decision === "deny") {
      s.deniedToolIds.add(entry.itemId);
      // 绑定为回退合成 id（审批先于 tool part 事件到达）时，标记待绑：下一个 error part 映射 denied
      if (entry.itemId.startsWith("ap-")) s.unboundDeny = true;
    }
    // 仍有待决审批（模型一次性多工具调用）时保持 waiting——回 running 会掩盖待决卡并误导空闲等待（issue #39）
    if (s.turnActive && s.pendingApprovals.size === 0) this.emit(s, { type: "session_status", status: "running" });
  }

  async readHistory(sessionId: string): Promise<ChatEvent[]> {
    const s = this.requireSession(sessionId);
    // 断开态：按需拉起 server（session 数据落盘于 server 数据目录，重启可读，poc-3 resume 实证）
    if ((s.dead || !s.client || s.client.dead) && !s.turnActive) {
      const client = await this.acquireServer(s, s.sessionId);
      this.attachServer(s, client);
      s.dead = false;
    }
    if (s.client && !s.client.dead) await this.backfillFromNative(s);
    return [...s.log];
  }

  /** readTranscript（#28）：GET /session/{id}/message → user/assistant 双视角（断开会话按需拉起 server；原生 message API 为权威源，与本地事件日志无关） */
  async readTranscript(sessionId: string): Promise<TranscriptEvent[]> {
    const s = this.requireSession(sessionId);
    // 断开态：按需拉起 server（同 readHistory 恢复入口语义）
    if ((s.dead || !s.client || s.client.dead) && !s.turnActive) {
      const client = await this.acquireServer(s, s.sessionId);
      this.attachServer(s, client);
      s.dead = false;
    }
    let items: Array<{ info?: Record<string, unknown>; parts?: unknown[] }>;
    try {
      const r = await s.client!.api("GET", `/session/${s.nativeId}/message?limit=500`);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.text.slice(0, 160)}`);
      const json = r.json as { items?: Array<{ info?: Record<string, unknown>; parts?: unknown[] }> } | null;
      items = json?.items ?? (Array.isArray(r.json) ? (r.json as Array<{ info?: Record<string, unknown>; parts?: unknown[] }>) : []);
    } catch (e) {
      // 读失败不冒充完整（spec #27「缺失会话明确列出」）：报错由提取管线记为缺失
      throw new AdapterError("E_INTERNAL", `读取 OpenCode 原生历史失败：${e instanceof Error ? e.message : String(e)}`);
    }
    const out: TranscriptEvent[] = [];
    for (const it of items) {
      const info = it.info ?? {};
      const parts = Array.isArray(it.parts) ? (it.parts as Array<Record<string, unknown>>) : [];
      if (info.role === "user") {
        // 用户消息：text part 拼接（prompt_async 落盘的原文）
        const text = parts
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("");
        if (text.length > 0) out.push({ role: "user", text });
        continue;
      }
      if (info.role !== "assistant") continue;
      for (const p of parts) {
        if (p.type === "text" && typeof p.text === "string" && p.text.length > 0) {
          out.push({ role: "assistant", text: p.text });
        } else if (p.type === "tool") {
          // 工具 part：name/summary 与实时流 describeToolArgs 同源
          const state = (p.state ?? {}) as Record<string, unknown>;
          out.push({ role: "assistant", text: "", tool: { name: String(p.tool ?? "tool"), summary: describeToolArgs(state.input) } });
        }
      }
    }
    return out;
  }

  async resume(sessionId: string): Promise<void> {
    const s = this.requireSession(sessionId);
    if (s.client && !s.client.dead && !s.dead) {
      // 进程内存活：复位活动残留（与 Codex/Claude 同语义）
      s.turnActive = false;
      s.queue.length = 0;
      s.interruptRequested = false;
      this.emit(s, { type: "session_status", status: "idle" });
      return;
    }
    // server 重启/应用重启后：拉起 server（原生历史仍在）→ idle；上下文经 native session id 延续
    try {
      const client = await this.acquireServer(s, s.sessionId);
      this.attachServer(s, client);
      s.dead = false;
      s.turnActive = false;
      s.queue.length = 0;
      this.emit(s, { type: "session_status", status: "idle" });
    } catch (e) {
      throw new AdapterError("E_INTERNAL", `恢复 OpenCode 会话失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async dispose(input?: DisposeInput): Promise<void> {
    if (input?.sessionId) {
      // Session 粒度：释放引用计数（最后一个会话释放才停 server，由 host 保证）
      const s = this.sessions.get(input.sessionId);
      if (!s) return;
      this.sessions.delete(input.sessionId);
      this.byNative.delete(s.nativeId);
      await this.host.release(s.cwd, s.sessionId).catch(() => {});
      return;
    }
    // 全局：受控停机全部 server 并等待退出（onDead 链发 session_exit/disconnected；状态保留供 resume）
    if (this.ownHost) {
      await this.ownHost.shutdown();
      return;
    }
    // 注入 host（测试）：释放全部引用
    for (const s of this.sessions.values()) await this.host.release(s.cwd, s.sessionId).catch(() => {});
  }

  subscribe(handler: (event: AdapterEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** C5 演进（#44）：server-per-project —— 经 host 上报运行中 server pid（同 project 引用共享只报一份，多 project 多份） */
  async listChildPids(): Promise<number[]> {
    return this.host.listChildPids?.() ?? [];
  }

  /* ---------------- 内部：server 挂接与事件映射 ---------------- */

  /** 拉起/复用 server（应用侧 sessionId 为引用键；档位缺省=auto） */
  private async acquireServer(s: { cwd: string; permMode?: PermMode }, ownerKey: string): Promise<OpenCodeServerClientLike> {
    try {
      return await this.host.acquire(s.cwd, s.permMode ?? "auto", ownerKey);
    } catch (e) {
      throw new AdapterError("E_INTERNAL", e instanceof Error ? e.message : String(e));
    }
  }

  /** 会话挂接 server 客户端：SSE 订阅 + 死亡联动（引用计数由 acquire/release 管理，此处纯接线） */
  private attachServer(s: SessionState, client: OpenCodeServerClientLike): void {
    s.client = client;
    s.dead = false;
    client.onEvent((ev) => this.onServerEvent(s, ev));
    client.onDead((err) => this.handleServerDeath(s, err));
  }

  private newState(sessionId: string, nativeId: string, init: { cwd: string; model?: string; permMode?: PermMode }): SessionState {
    return {
      sessionId,
      nativeId,
      cwd: init.cwd,
      model: init.model,
      permMode: init.permMode,
      seq: 0,
      log: [],
      status: "idle",
      turnActive: false,
      interruptRequested: false,
      turnHadApproval: false,
      finishPending: false,
      lastEventAtMs: Date.now(),
      stuckProbe: null,
      lastTurnError: null,
      queue: [],
      pendingApprovals: new Map(),
      expiredApprovals: new Set(),
      deniedToolIds: new Set(),
      unboundDeny: false,
      parts: new Map(),
      partTypes: new Map(),
      tools: new Map(),
      itemIdsWithDeltas: new Set(),
      lastPartId: new Map(),
      completedItems: new Set(),
      activeMessageId: null,
      client: null,
      dead: false,
    };
  }

  /** SSE 事件分发（sessionID 路由到本会话；跨会话共享 server 时各会话各自订阅过滤） */
  private onServerEvent(s: SessionState, ev: OpenCodeSseEvent): void {
    const p = ev.properties ?? {};
    const sid = typeof p.sessionID === "string" ? p.sessionID : "";
    if (sid && sid !== s.nativeId) return;
    switch (ev.type) {
      case "message.part.delta":
        this.handlePartDelta(s, p);
        break;
      case "message.part.updated":
        this.handlePartUpdated(s, p);
        break;
      case "session.idle":
        if (s.turnActive && !s.finishPending) void this.finishTurnWithReconcile(s);
        break;
      case "session.error":
        this.handleSessionError(s, p);
        break;
      case "permission.asked":
        // 1.15.7 存在 asked 推送：加速发现（轮询为主，spec G）；须带本会话 sessionID 才认领
        if (typeof p.id === "string" && p.id && sid === s.nativeId) this.registerApproval(s, p);
        break;
      case "permission.replied":
        this.handlePermissionReplied(s, p);
        break;
      default:
        break; // session.status/message.updated/heartbeat 等不映射
    }
  }

  /** 增量事件（1.15.7）：field=text 且 part 类型非 reasoning → message_delta（delta 通道；未知类型按 text 放行，快照纠偏） */
  private handlePartDelta(s: SessionState, p: Record<string, unknown>): void {
    if (p.field !== "text" || typeof p.delta !== "string") return;
    const itemId = String(p.messageID ?? "");
    const partId = String(p.partID ?? "");
    if (!itemId || !partId) return;
    const partType = s.partTypes.get(partId);
    if (partType !== undefined && partType !== "text") return; // reasoning 等非文本 part 的 delta 不进消息流
    this.beginMessage(s, itemId);
    const key = `${itemId}:${partId}`;
    s.parts.set(key, (s.parts.get(key) ?? "") + p.delta);
    s.itemIdsWithDeltas.add(itemId);
    s.lastPartId.set(itemId, partId);
    this.emit(s, { type: "message_delta", itemId, partId, delta: p.delta });
  }

  /** 快照事件（双通道之二）：text 终文自愈 + tool part 状态机；非文本 part 记录类型（delta 降噪） */
  private handlePartUpdated(s: SessionState, p: Record<string, unknown>): void {
    const part = p.part as Record<string, unknown> | undefined;
    if (!part || typeof part.id !== "string") return;
    const itemId = String(part.messageID ?? "");
    if (!itemId) return;
    s.partTypes.set(String(part.id), String(part.type ?? ""));
    if (part.type === "text" && typeof part.text === "string") {
      this.beginMessage(s, itemId);
      const partId = String(part.id);
      const key = `${itemId}:${partId}`;
      const acc = s.parts.get(key) ?? "";
      if (part.text.startsWith(acc) && part.text.length > acc.length) {
        // 自愈：快照比累计多 → 补发缺失（delta 丢帧时无丢失）
        this.emit(s, { type: "message_delta", itemId, partId, delta: part.text.slice(acc.length) });
        s.itemIdsWithDeltas.add(itemId);
        s.lastPartId.set(itemId, partId);
      } else if (!part.text.startsWith(acc)) {
        this.log("text-mismatch", `itemId=${itemId} acc(${acc.length})!=snapshot(${part.text.length})`);
      }
      s.parts.set(key, part.text);
      return;
    }
    if (part.type === "tool") this.handleToolPart(s, part);
  }

  /** 新 assistant 消息首帧：终结上一条消息（工具轮+总结轮多消息 turn 的分界） */
  private beginMessage(s: SessionState, itemId: string): void {
    if (s.activeMessageId === itemId) return;
    const prev = s.activeMessageId;
    s.activeMessageId = itemId;
    if (prev && s.itemIdsWithDeltas.has(prev) && !s.completedItems.has(prev)) {
      s.completedItems.add(prev);
      this.emit(s, { type: "message_completed", itemId: prev, partId: s.lastPartId.get(prev) ?? "0" });
    }
  }

  /** tool part 状态机：pending/running → started/update；completed/error → completed（error+deny 决定 → denied） */
  private handleToolPart(s: SessionState, part: Record<string, unknown>): void {
    const itemId = String(part.id);
    const state = (part.state ?? {}) as Record<string, unknown>;
    const status = String(state.status ?? "");
    const time = (state.time ?? {}) as { start?: number; end?: number };
    let track = s.tools.get(itemId);
    if (!track) {
      track = { tool: String(part.tool ?? "tool"), startedAtMs: time.start ?? Date.now(), lastOutput: "", terminal: false };
      s.tools.set(itemId, track);
      this.emit(s, {
        type: "tool_started",
        itemId,
        tool: track.tool,
        argsSummary: describeToolArgs(state.input),
      });
    }
    const output = typeof state.output === "string" ? state.output : "";
    if (output.length > track.lastOutput.length) {
      this.emit(s, { type: "tool_update", itemId, outputDelta: output.slice(track.lastOutput.length) });
      track.lastOutput = output;
    }
    if (status !== "completed" && status !== "error") return;
    if (track.terminal) return;
    track.terminal = true;
    const durationMs = time.start && time.end ? Math.max(0, time.end - time.start) : Date.now() - track.startedAtMs;
    if (status === "error") {
      let denied = s.deniedToolIds.delete(itemId);
      if (!denied && s.unboundDeny) {
        denied = true;
        s.unboundDeny = false; // 回退绑定的 deny：本 turn 内首个 error part 归因
      }
      const errText = typeof state.error === "string" ? state.error : "工具执行失败";
      this.emit(s, {
        type: "tool_completed",
        itemId,
        status: denied ? "denied" : "completed",
        durationMs,
        output: denied ? errText : `[error] ${errText}`,
      });
      return;
    }
    this.emit(s, { type: "tool_completed", itemId, status: "completed", durationMs, output });
  }

  /** turn 内错误记录：abort 类归已取消（finishTurn 分类）；其余在 idle 时随终态报出 */
  private handleSessionError(s: SessionState, p: Record<string, unknown>): void {
    const err = (p.error ?? {}) as { name?: string; message?: string; data?: unknown };
    const name = String(err.name ?? "");
    const message = typeof err.message === "string" ? err.message : JSON.stringify(err.data ?? err).slice(0, 200);
    s.lastTurnError = { name, message };
  }

  /** permission.replied 兜底：非我方决定的终结 → approval_expired（服务端已决/他端已答） */
  private handlePermissionReplied(s: SessionState, p: Record<string, unknown>): void {
    const requestId = String(p.requestID ?? "");
    if (!requestId) return;
    const entry = s.pendingApprovals.get(requestId);
    if (!entry) return;
    s.pendingApprovals.delete(requestId);
    s.expiredApprovals.add(requestId);
    if (!entry.decided) {
      this.emit(s, { type: "approval_expired", requestId, reason: `server_resolved(${String(p.reply ?? "")})` });
    }
  }

  /* ---------------- 内部：审批轮询 ---------------- */

  /** 审批轮询主通道（spec G：SSE 不保证推送请求，GET /permission pending 列表可靠） */
  private ensurePoll(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.pollTick(), this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  private async pollTick(): Promise<void> {
    if (this.pollBusy) return;
    this.pollBusy = true;
    try {
      const active = [...this.sessions.values()].filter((s) => s.turnActive && s.client && !s.client.dead && !s.dead);
      if (active.length === 0) {
        this.stopPoll();
        return;
      }
      for (const s of active) {
        try {
          const r = await s.client!.api("GET", "/permission");
          if (!r.ok) continue;
          const pending = Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [];
          const mine = pending.filter((x) => x.sessionID === s.nativeId);
          const live = new Set<string>();
          for (const perm of mine) {
            const id = String(perm.id ?? "");
            if (!id) continue;
            live.add(id);
            if (!s.pendingApprovals.has(id) && !s.expiredApprovals.has(id)) this.registerApproval(s, perm);
          }
          // 轮询侧兜底：已从 pending 消失且非我方决定 → 过期
          for (const [id, entry] of s.pendingApprovals) {
            if (!live.has(id) && !entry.decided) {
              s.pendingApprovals.delete(id);
              s.expiredApprovals.add(id);
              this.emit(s, { type: "approval_expired", requestId: id, reason: "server_resolved(vanished)" });
            }
          }
        } catch {
          /* 瞬时不可达：下轮重试（死亡由 client.onDead 处理） */
        }
        await this.checkStuckRunning(s);
      }
    } finally {
      this.pollBusy = false;
    }
  }

  private stopPoll(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** running 卡死自愈（SSE 断线窗口丢 session.idle 帧 → 会话永久 running 的根因，issue #39）：
   *  静默超阈值后连续两次 /message 快照内容零变化（正常生成必有新帧/新落账）→ 判定 turn 已终结，走 idle 同款对账收尾。
   *  保守触发：waiting（审批待决）不收尾（replied/vanished 兜底管辖）；快照有变化即重置（网关慢而未死） */
  private async checkStuckRunning(s: SessionState): Promise<void> {
    if (s.finishPending || s.pendingApprovals.size > 0) return;
    if (Date.now() - s.lastEventAtMs < this.stuckIdleMs) {
      s.stuckProbe = null; // 有新事件 → 清除探测记忆重新计静默
      return;
    }
    let key = "";
    try {
      const r = await s.client!.api("GET", `/session/${s.nativeId}/message?limit=500`);
      if (!r.ok) return;
      const json = r.json as { items?: unknown[] } | null;
      const items = json?.items ?? (Array.isArray(r.json) ? r.json : []);
      // 内容指纹：消息/部件 id + 工具状态 + 文本与输出长度（时间戳类字段不参与，避免永远「有变化」）
      key = JSON.stringify(
        (items as Array<{ info?: Record<string, unknown>; parts?: unknown[] }>).map((it) => [
          String(it.info?.id ?? ""),
          (it.parts ?? []).map((p) => {
            const part = p as Record<string, unknown>;
            const state = (part.state ?? {}) as Record<string, unknown>;
            return [String(part.id ?? ""), String(state.status ?? ""), String(part.text ?? "").length, typeof state.output === "string" ? state.output.length : 0];
          }),
        ]),
      );
    } catch {
      return; // 探测失败下轮重试
    }
    const prev = s.stuckProbe;
    if (prev && prev.key === key) {
      if (Date.now() - prev.at < this.stuckConfirmMs) return; // 同快照：自首次探测起计确认窗（at 不刷新，否则永远凑不满）
      this.log("stuck-finish", `session=${s.sessionId} silentMs=${Date.now() - s.lastEventAtMs}（idle 帧丢失自愈）`);
      s.stuckProbe = null;
      await this.finishTurnWithReconcile(s); // 复用 idle 终结路径：快照对账补 tool 终态 + 分类收尾
      return;
    }
    s.stuckProbe = { key, at: Date.now() }; // 新快照指纹：从这里起计确认窗
  }

  /** 新审批：绑定当前非终态 tool part → approval_requested（含 patterns/always 建议映射）+ waiting */
  private registerApproval(s: SessionState, perm: Record<string, unknown>): void {
    const requestId = String(perm.id ?? "");
    if (!requestId || s.pendingApprovals.has(requestId) || s.expiredApprovals.has(requestId)) return;
    s.turnHadApproval = true; // idle 对账触发标记（审批伴随的工具执行可能整段丢帧）
    // 绑定 itemId：最近一个非终态 tool part（审批发生在工具 pending 阶段）；无则回退合成 id
    let itemId = "";
    for (const [id, t] of s.tools) {
      if (!t.terminal) itemId = id;
    }
    if (!itemId) itemId = `ap-${requestId}`;
    s.pendingApprovals.set(requestId, { requestId, itemId, decided: false });
    this.emit(s, {
      type: "approval_requested",
      requestId,
      itemId,
      command: describePermission(perm),
      suggestions: permissionSuggestions(perm),
    });
    this.emit(s, { type: "session_status", status: "waiting" });
    this.ensurePoll();
  }

  /* ---------------- 内部：turn 驱动与终态 ---------------- */

  /** model 解析：显式含斜杠 → 切分；否则 GET /config 默认模型；无默认 → 省略（server 自选） */
  private async resolveModelWire(s: SessionState): Promise<Record<string, string> | undefined> {
    if (s.model && s.model.includes("/")) return splitModelId(s.model);
    const client = s.client!;
    if (!this.modelCache.has(client)) {
      let def: string | null = null;
      try {
        const r = await client.api("GET", "/config");
        const m = (r.json as { model?: unknown } | null)?.model;
        if (typeof m === "string" && m.includes("/")) def = m;
      } catch {
        /* 配置读取失败：省略 model */
      }
      this.modelCache.set(client, def ? splitModelId(def) : null);
    }
    return this.modelCache.get(client) ?? undefined;
  }

  /** 已知 command 名单（GET /command，client 级缓存；miss 时刷新一次） */
  private async knownCommands(s: SessionState): Promise<Set<string>> {
    const client = s.client!;
    if (!this.commandCache.has(client)) {
      const names = new Set<string>();
      try {
        const r = await client.api("GET", "/command");
        const items = Array.isArray((r.json as { items?: unknown[] } | null)?.items)
          ? (r.json as { items: Record<string, unknown>[] }).items
          : Array.isArray(r.json)
            ? (r.json as Record<string, unknown>[])
            : [];
        for (const c of items) if (typeof c.name === "string" && c.name) names.add(c.name);
      } catch {
        /* 读取失败按未命中处理 */
      }
      this.commandCache.set(client, names);
    }
    return this.commandCache.get(client)!;
  }

  /** "/name args" → name 命中已知 command 时返回 name（未命中 null → 普通提示词） */
  private async matchCommand(s: SessionState, text: string): Promise<string | null> {
    const name = text.slice(1).split(/\s+/)[0] ?? "";
    if (!name) return null;
    let known = await this.knownCommands(s);
    if (!known.has(name)) {
      this.commandCache.delete(s.client!); // miss 刷新一次（新 command 落盘后）
      known = await this.knownCommands(s);
    }
    return known.has(name) ? name : null;
  }

  private async startTurn(s: SessionState, text: string, command: string | null): Promise<void> {
    s.turnActive = true;
    s.interruptRequested = false;
    s.turnHadApproval = false;
    s.stuckProbe = null; // 上一 turn 的探测记忆不复用
    s.lastTurnError = null;
    s.unboundDeny = false; // deny 待绑标记仅在本 turn 内有效
    this.emit(s, { type: "session_status", status: "running" });
    this.emit(s, { type: "turn_started", turnId: `t-${randomUUID().slice(0, 8)}` });
    this.ensurePoll();
    const model = await this.resolveModelWire(s);
    if (command) {
      // command API 同步返回完成消息：turn 生命周期仍由 SSE（session.idle）驱动；200 后发 self_reported
      const modelWire = s.model && s.model.includes("/") ? s.model : model ? `${model.providerID}/${model.modelID}` : null;
      void s.client!
        .api("POST", `/session/${s.nativeId}/command`, { command, arguments: "{}", ...(modelWire ? { model: modelWire } : {}) })
        .then((r) => {
          if (r.ok) {
            this.emitObservation(s, command, "self_reported", "opencode-command");
          } else {
            // #41 枚举映射：结构化 HTTP 状态优先（401/403 → AUTH_EXPIRED），其余 INTERNAL
            this.emit(s, {
              type: "session_error",
              code: isAuthFailureStatus(r.status) ? "AUTH_EXPIRED" : "INTERNAL",
              message: `command 执行失败：HTTP ${r.status} ${r.text.slice(0, 160)}`,
            });
            if (s.turnActive) this.finishTurn(s, "failed");
          }
        })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          this.emit(s, { type: "session_error", code: classifyTransportFailure(msg), message: `command 执行失败：${msg}` });
          if (s.turnActive) this.finishTurn(s, "failed");
        });
      return;
    }
    try {
      const r = await s.client!.api("POST", `/session/${s.nativeId}/prompt_async`, {
        ...(model ? { model } : {}),
        parts: [{ type: "text", text }],
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.text.slice(0, 160)}`);
    } catch (e) {
      // 提交失败：turn 回滚空闲并明确报错（不进入事件流重放）；#41 认证/断连/内部归类
      s.turnActive = false;
      const msg = e instanceof Error ? e.message : String(e);
      this.emit(s, { type: "session_error", code: classifyTransportFailure(msg), message: msg });
      this.emit(s, { type: "session_status", status: "idle" });
      throw new AdapterError("E_INTERNAL", `turn 提交失败：${msg}`);
    }
  }

  /** turn 终结入口（session.idle）：先经原生 message 快照对账再统一收尾——非终态工具补终态、本 turn 有审批而帧全丢的工具整体重建（SSE 断线窗口自愈） */
  private async finishTurnWithReconcile(s: SessionState): Promise<void> {
    const openIds = new Set([...s.tools.entries()].filter(([, t]) => !t.terminal).map(([id]) => id));
    // 触发：有非终态工具（丢 completed 帧），或本 turn 有审批（工具帧可能全丢：审批经轮询可发现，工具事件只走 SSE）
    if ((openIds.size > 0 || s.turnHadApproval) && !s.interruptRequested && s.client && !s.client.dead && !s.dead) {
      s.finishPending = true;
      try {
        const r = await s.client.api("GET", `/session/${s.nativeId}/message?limit=500`);
        if (r.ok) {
          const json = r.json as { items?: Array<{ parts?: unknown[] }> } | null;
          const items = json?.items ?? (Array.isArray(r.json) ? (r.json as Array<{ parts?: unknown[] }>) : []);
          const seen = new Set<string>();
          for (const it of items) {
            for (const p of Array.isArray(it.parts) ? (it.parts as Array<Record<string, unknown>>) : []) {
              if (p.type !== "tool") continue;
              const pid = String(p.id ?? "");
              if (!pid) continue;
              seen.add(pid);
              // 已终态的工具不重放；非终态或全丢（started 也未见）的经权威快照补齐（handleToolPart 幂等）
              if (openIds.has(pid) || !s.tools.has(pid)) this.handleToolPart(s, p);
            }
          }
          const healed = [...openIds].filter((id) => s.tools.get(id)?.terminal);
          if (healed.length > 0) this.log("tool-reconcile", `session=${s.sessionId} healed=[${healed.join(",")}]`);
        }
      } catch {
        /* 对账失败按既有行为收尾（失败分支收口 + readHistory 回填兜底） */
      }
      s.finishPending = false;
      if (!s.turnActive) return; // 等待期间死亡/resume 已接管终态
    }
    this.finishTurn(s);
  }

  /** 非终态工具收口 interrupted（中断/失败 turn 不宣称仍在运行，spec H） */
  private closeOpenTools(s: SessionState): void {
    for (const [itemId, t] of s.tools) {
      if (t.terminal) continue;
      t.terminal = true;
      this.emit(s, { type: "tool_completed", itemId, status: "interrupted", durationMs: Date.now() - t.startedAtMs, output: "" });
    }
  }

  /** turn 终态统一收尾（session.idle 触发）：interrupted/failed/completed 分类 + 残留收口 + 队列策略 */
  private finishTurn(s: SessionState, forced?: "failed"): void {
    s.turnActive = false;
    const aborted = s.interruptRequested || /abort/i.test(s.lastTurnError?.name ?? "");
    // 残留消息终结（多消息 turn 的最后一条）
    const active = s.activeMessageId;
    if (active && s.itemIdsWithDeltas.has(active) && !s.completedItems.has(active)) {
      s.completedItems.add(active);
      this.emit(s, { type: "message_completed", itemId: active, partId: s.lastPartId.get(active) ?? "0" });
    }
    s.activeMessageId = null;
    // 残留审批：过期收口（正常流先于终态解决）
    for (const entry of s.pendingApprovals.values()) {
      if (!entry.decided) this.emit(s, { type: "approval_expired", requestId: entry.requestId, reason: "turn_ended" });
    }
    s.pendingApprovals.clear();
    if (aborted) {
      // 中断中的工具不宣称仍在运行（spec H）：非终态工具 → interrupted
      this.closeOpenTools(s);
      s.queue.length = 0;
      this.emit(s, { type: "turn_interrupted", reason: "user" });
      this.emit(s, { type: "session_status", status: "interrupted" });
      return;
    }
    if (forced === "failed" || s.lastTurnError) {
      if (s.lastTurnError) {
        // #41 枚举映射：provider 认证类文本 → AUTH_EXPIRED，其余 INTERNAL（session.error 真实形状见 auth-samples.md）
        const msg = `${s.lastTurnError.name}: ${s.lastTurnError.message}`;
        this.emit(s, { type: "session_error", code: isAuthFailureText(msg) ? "AUTH_EXPIRED" : "INTERNAL", message: msg });
      }
      this.closeOpenTools(s); // 失败 turn 的非终态工具同样收口（对账未愈/无终态帧时不留运行中卡片）
      s.queue.length = 0; // 明确报错不重放（spec H）
      this.emit(s, { type: "session_status", status: "idle" });
      return;
    }
    this.emit(s, { type: "turn_completed" });
    this.emit(s, { type: "session_status", status: "idle" });
    const next = s.queue.shift();
    if (next) void this.startTurn(s, next, null).catch(() => {});
  }

  /** server 死亡：本会话明确报错不重放；状态保留供 resume（原生历史落盘无损） */
  private handleServerDeath(s: SessionState, err: Error): void {
    if (s.dead) return;
    s.dead = true;
    s.queue.length = 0;
    s.turnActive = false;
    for (const entry of s.pendingApprovals.values()) {
      if (!entry.decided) this.emit(s, { type: "approval_expired", requestId: entry.requestId, reason: "session_dead" });
    }
    s.pendingApprovals.clear();
    this.emit(s, { type: "session_exit", exitCode: 1, reason: err.message });
    this.emit(s, { type: "session_status", status: "disconnected" });
  }

  /* ---------------- 内部：原生历史回填 ---------------- */

  /** GET /session/{id}/message → 与实时流同键去重后补入事件日志（快照+增量无缝拼接，不变量 4） */
  private async backfillFromNative(s: SessionState): Promise<void> {
    let items: Array<{ info?: Record<string, unknown>; parts?: unknown[] }>;
    try {
      const r = await s.client!.api("GET", `/session/${s.nativeId}/message?limit=500`);
      if (!r.ok) return;
      const json = r.json as { items?: Array<{ info?: Record<string, unknown>; parts?: unknown[] }> } | null;
      items = json?.items ?? (Array.isArray(r.json) ? (r.json as Array<{ info?: Record<string, unknown>; parts?: unknown[] }>) : []);
    } catch {
      return; // 瞬时不可达：本轮跳过（下次 readHistory 重试）
    }
    const existing = new Set<string>();
    for (const e of s.log) {
      if (e.type === "message_delta" || e.type === "message_completed") existing.add(`msg:${e.itemId}:${e.partId}`);
      else if (e.type === "tool_started") existing.add(`tool-start:${e.itemId}`);
      else if (e.type === "tool_completed") existing.add(`tool-done:${e.itemId}`);
    }
    // 按 parentID 分组 assistant 消息（工具轮+总结轮同 parent = 同一 turn）
    const groups = new Map<string, Array<{ info: Record<string, unknown>; parts: unknown[] }>>();
    for (const it of items) {
      const info = it.info ?? {};
      if (info.role !== "assistant") continue;
      const parent = typeof info.parentID === "string" && info.parentID ? info.parentID : String(info.id ?? "");
      const arr = groups.get(parent) ?? [];
      arr.push({ info, parts: Array.isArray(it.parts) ? it.parts : [] });
      groups.set(parent, arr);
    }
    for (const [, msgs] of groups) {
      const seeds: Array<{ seed: ChatEventSeed; at: string; heal?: boolean }> = [];
      for (const { info, parts } of msgs) {
        const itemId = String(info.id ?? "");
        if (!itemId) continue;
        const time = (info.time ?? {}) as { created?: number };
        const at = time.created ? new Date(time.created).toISOString() : new Date().toISOString();
        for (const raw of parts as Array<Record<string, unknown>>) {
          if (raw.type === "text" && typeof raw.text === "string") {
            const partId = String(raw.id ?? "0");
            const key = `msg:${itemId}:${partId}`;
            if (existing.has(key)) continue;
            existing.add(key);
            if (raw.text.length > 0) seeds.push({ seed: { type: "message_delta", itemId, partId, delta: raw.text }, at });
            seeds.push({ seed: { type: "message_completed", itemId, partId }, at });
            s.itemIdsWithDeltas.add(itemId);
            s.completedItems.add(itemId);
          } else if (raw.type === "tool") {
            const toolId = String(raw.id ?? "");
            if (!toolId) continue;
            // started/completed 分键去重：丢帧自愈——实时只见 started（completed 帧丢失）时仅补终态
            const startedSeen = existing.has(`tool-start:${toolId}`);
            const doneSeen = existing.has(`tool-done:${toolId}`);
            if (startedSeen && doneSeen) continue;
            const state = (raw.state ?? {}) as Record<string, unknown>;
            const t = (state.time ?? {}) as { start?: number; end?: number };
            if (!startedSeen) {
              existing.add(`tool-start:${toolId}`);
              seeds.push({
                seed: { type: "tool_started", itemId: toolId, tool: String(raw.tool ?? "tool"), argsSummary: describeToolArgs(state.input) },
                at,
              });
            }
            existing.add(`tool-done:${toolId}`);
            const durationMs = t.start && t.end ? Math.max(0, t.end - t.start) : 0;
            const output = typeof state.output === "string" ? state.output : "";
            const denied = typeof state.error === "string" && state.error.includes("rejected");
            seeds.push({
              seed: {
                type: "tool_completed",
                itemId: toolId,
                status: denied ? "denied" : "completed",
                durationMs,
                output: typeof state.error === "string" && !denied ? `[error] ${state.error}` : output,
              },
              at,
              heal: startedSeen, // started 已实时见过的补终态为自愈事件（不重造 turn 边界）
            });
          }
        }
      }
      if (seeds.length === 0) continue; // 该轮已全部实时见过 → 整轮跳过（无重复）
      // 纯补终态（started 已实时见过、completed 帧丢失）：不包裹 turn 边界（该轮边界已实时见过，避免幽灵 turn）
      if (seeds.every((x) => x.heal)) {
        for (const { seed, at } of seeds) this.emit(s, seed, at);
        continue;
      }
      this.emit(s, { type: "turn_started", turnId: `t-${randomUUID().slice(0, 8)}` }, seeds[0].at);
      for (const { seed, at } of seeds) this.emit(s, seed, at);
      this.emit(s, { type: "turn_completed" }, seeds.at(-1)!.at);
    }
  }

  /* ---------------- 内部：事件与工具 ---------------- */

  /** ChatEvent 唯一出口：seq 单调 + at + 广播；SkillObservation 直发订阅者不入日志 */
  private emit(s: SessionState, ev: ChatEventSeed, at?: string): void {
    s.seq += 1;
    s.lastEventAtMs = Date.now(); // SSE 静默基准：有事件 = turn 活着（卡死探测不触发）
    const full = { ...ev, sessionId: s.sessionId, seq: s.seq, at: at ?? new Date().toISOString() } as ChatEvent;
    s.log.push(full);
    for (const h of this.handlers) h(full);
  }

  private emitObservation(s: SessionState, skill: string, evidenceLevel: "self_reported", source: string): void {
    const obs: SkillObservation = {
      eventId: `opencode-command:${s.nativeId}:${skill}:${Date.now()}`,
      kind: "skill",
      sessionId: s.sessionId,
      cli: "opencode",
      skill,
      stage: null,
      requirementId: null,
      occurredAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      seq: null,
      evidenceLevel,
      source,
    };
    for (const h of this.handlers) h(obs);
  }

  private requireSession(sessionId: string): SessionState {
    const s = this.sessions.get(sessionId);
    if (!s) throw new AdapterError("E_SESSION_NOT_FOUND", `会话不存在：${sessionId}`);
    return s;
  }

  private requireLiveSession(sessionId: string): SessionState {
    const s = this.requireSession(sessionId);
    if (s.dead || !s.client || s.client.dead) {
      throw new AdapterError("E_INTERNAL", "OpenCode server 已断开，会话已断开（请读取原生历史恢复或新建会话）");
    }
    return s;
  }
}

/* ---------------- wire 映射工具 ---------------- */

/** 统一审批决定 → OpenCode response 枚举（spec B 审批映射表：once/always/reject，语义不换写） */
function approvalWire(decision: ApprovalDecision): string {
  if (decision === "allow-once") return "once";
  if (decision === "allow-always") return "always";
  return "reject";
}

/** 工具参数摘要（bash 命令直出，其余 JSON 截断） */
function describeToolArgs(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  if (typeof obj.command === "string" && obj.command) return obj.command;
  if (typeof obj.filePath === "string" && obj.filePath) return obj.filePath;
  try {
    return JSON.stringify(input).slice(0, 160);
  } catch {
    return "";
  }
}

/** pending permission → 审批卡命令行（metadata 命令优先，其次 pattern） */
function describePermission(perm: Record<string, unknown>): string {
  const meta = (perm.metadata ?? {}) as Record<string, unknown>;
  const tool = String(perm.permission ?? "tool");
  const cmd = typeof meta.command === "string" && meta.command ? meta.command : typeof meta.description === "string" && meta.description ? meta.description : "";
  if (cmd) return `${tool}: ${cmd}`;
  const patterns = Array.isArray(perm.patterns) ? (perm.patterns as string[]).join(" ") : "";
  return patterns ? `${tool}: ${patterns}` : `${tool}: (未知命令)`;
}

/** pending permission → 建议项（patterns=本次匹配；always=server 级通配建议，原生语义） */
function permissionSuggestions(perm: Record<string, unknown>): ApprovalSuggestion[] {
  const out: ApprovalSuggestion[] = [];
  const always = Array.isArray(perm.always) ? (perm.always as string[]) : [];
  for (const pattern of always) {
    out.push({ kind: "pattern", label: pattern, detail: "总是允许匹配此模式的操作（server 级，同项目共享）" });
  }
  const patterns = Array.isArray(perm.patterns) ? (perm.patterns as string[]) : [];
  for (const pattern of patterns) {
    out.push({ kind: "pattern", label: pattern, detail: "本次请求匹配的模式" });
  }
  return out;
}

/** 注册表缺省路径（桌面场景经 KANBAN_DATA_DIR=userData；缺省 tmp 供同机接管） */
function defaultRegistryPath(): string {
  const dataDir = process.env.KANBAN_DATA_DIR;
  return dataDir ? path.join(dataDir, "opencode-servers.json") : path.join(tmpdir(), "kanban-opencode-servers.json");
}
