// 用途：FakeAdapter —— C1 契约的脚本化 mock 实现：事件溯源日志（readHistory=重放，天然满足不变量 4）、可注入时钟、演示脚本驱动（原型行为规格）+ readTranscript 双视角剧本（#28，独立于 ChatEvent 日志维护）+ listModels 假模型目录（#76：演示 UI 形态与真实 CLI 一致）+ listCommands（#92 起 cli=codex 模拟真实 codex 目录扫描；其余 CLI 恒空集——ADR 0004：fake 会话无命令源，斜杠菜单空态引导）
import { homedir } from "node:os";
import type { AdapterEvent, ChatEvent, ChatEventSeed, CommandEntry, ModelEntry, PermMode, SessionStatus, SkillObservation, TranscriptEvent } from "@kanban/ipc-schema";
import { AdapterError, type AdoptSessionInput, type AdapterCapabilities, type CliAdapter, type CreateSessionInput, type DisposeInput, type ListCommandsInput, type ListModelsInput, type ResolveApprovalInput, type SendTurnInput, type SetModelInput } from "./adapter";
import { SystemClock, type FakeClock } from "./clock";
import { listCodexPromptCommands } from "./codex/prompt-commands";
import { pickScript, type ScriptStep } from "./fake-scripts";

// 视觉节奏常量（对照原型：流式 ~60ms 出 3 字符、步进间隔给工具卡/消息留呼吸感）
const STREAM_TICK_MS = 60;
const STREAM_CHUNK_CHARS = 3;
const STEP_DELAY_MS = 250;
// 审批决定后的工具终态时长（原型「完成 · 0.8s」）
const DECIDED_TOOL_DURATION_MS = 800;

interface ApprovalPending {
  requestId: string;
  itemId: string;
  step: Extract<ScriptStep, { t: "approval" }>;
  cancelExpire: () => void;
}

interface SessionState {
  sessionId: string;
  cwd: string;
  model?: string;
  permMode?: PermMode;
  seq: number;
  log: ChatEvent[];
  /** readTranscript 双视角剧本（#28）：与 ChatEvent 日志分轨维护（GUI 聊天流无 user 条目，提取管线需要 user 视角） */
  transcript: TranscriptEvent[];
  status: SessionStatus;
  /** 当前 turn 待执行脚本（null=无活动 turn） */
  script: ScriptStep[] | null;
  ix: number;
  /** 流式中的助手分段 */
  stream: { itemId: string; partId: string; target: string; pos: number } | null;
  /** 最近一次 tool_started 的 itemId（toolOutput/toolDone/approval 归属） */
  lastToolItemId: string | null;
  /** 仍未终态的工具 itemId（interrupt 时置 interrupted） */
  runningToolItemId: string | null;
  pendingApproval: ApprovalPending | null;
  /** allow-always 后本会话同类审批自动放行（会话级规则，spec B） */
  skipApprovals: boolean;
  /** 忙态排队的不变量 6：当前 turn 结束后按序续发 */
  queue: string[];
}

export interface FakeAdapterOptions {
  /** 缺省自建 SystemClock（dispose 时停泵）；测试注入 VirtualClock 获得确定性 */
  clock?: FakeClock;
  /** 脚本选择器（按发送文本挑演示分支；缺省 pickScript） */
  pickTurnScript?: (text: string) => ScriptStep[];
  /** #42 e2e 支撑：resume 前置注入延迟毫秒（整机 Playwright 观察「恢复中」态；缺省 0） */
  resumeDelayMs?: number;
  /** #42 e2e 支撑：前 N 次 resume 抛 AdapterError（整机 Playwright 驱动失败/重试态；缺省 0 不注入） */
  failResumeFirst?: number;
  /** #46 e2e 支撑：前 N 次 createSession 抛 E_SPAWN_NOT_FOUND（整机 Playwright 驱动侧栏 spawn 失败卡；缺省 0 不注入） */
  failCreateFirst?: number;
  /** #81 e2e 支撑：listModels 前置注入延迟毫秒（整机 Playwright 观察 combobox 加载阻塞态；缺省 0） */
  modelsDelayMs?: number;
  /** #81 e2e 支撑：前 N 次 listModels 抛 E_SPAWN_NOT_FOUND（整机 Playwright 驱动 combobox 拉取失败态；缺省 0 不注入） */
  failModelsFirst?: number;
  /** #81 e2e 支撑：前 N 次 setModel 抛 AdapterError（整机 Playwright 驱动中途切换失败回滚；缺省 0 不注入） */
  failSetModelFirst?: number;
  /** #95 e2e 支撑：summarizeTitle 前置注入延迟毫秒（整机 Playwright 观察「摘要进行中手动重命名不被覆盖」竞态；缺省 0） */
  summarizeDelayMs?: number;
  /** 用户主目录覆盖（#92：cli=codex 时目录模拟真实 codex 扫描的 ~/.codex/prompts 基准；缺省 os.homedir()；测试注入 fixture） */
  homeDir?: string;
}

/** 全能力 Fake：UI 不隐藏任何控件（spec B capabilities 语义）；runOnce 为托管形态能力（worker RunOnceRunner），adapter 单元恒 false（arch C13） */
const FAKE_CAPABILITIES: AdapterCapabilities = {
  approval: true,
  interrupt: true,
  resume: true,
  readHistory: true,
  skillSignal: true,
  adoptSession: true,
  runOnce: false,
  listChildPids: true,
};

/** Fake 摘要标题固定值（#95 / ADR 0003 决策 3）：整机 e2e 断言侧栏标题翻转；契约套默认精确断言值 */
export const FAKE_SUMMARIZED_TITLE = "演示会话 · 首轮摘要";

/** Fake 模型目录（spec #75 #18）：两条假模型，第一条默认——演示/测试时 UI 形态与真实 CLI 一致 */
const FAKE_MODELS: ModelEntry[] = [
  { id: "fake-standard", displayName: "Fake 标准模型", description: "演示用假模型（完整演示脚本节奏）", isDefault: true },
  { id: "fake-lite", displayName: "Fake 轻量模型", description: "演示用假模型（轻量输出）", isDefault: false },
];

export class FakeAdapter implements CliAdapter {
  readonly capabilities = FAKE_CAPABILITIES;
  private readonly clock: FakeClock;
  private readonly ownsClock: boolean;
  private readonly pickTurnScript: (text: string) => ScriptStep[];
  private readonly resumeDelayMs: number;
  private readonly failResumeFirst: number;
  private readonly failCreateFirst: number;
  private readonly modelsDelayMs: number;
  private readonly failModelsFirst: number;
  private readonly failSetModelFirst: number;
  private readonly summarizeDelayMs: number;
  private resumeCalls = 0;
  private createCalls = 0;
  private listModelsCalls = 0;
  private setModelCalls = 0;
  private readonly homeDir: string | null;
  private readonly sessions = new Map<string, SessionState>();
  private readonly handlers = new Set<(event: AdapterEvent) => void>();

  constructor(options: FakeAdapterOptions = {}) {
    this.pickTurnScript = options.pickTurnScript ?? pickScript;
    this.ownsClock = !options.clock;
    this.clock = options.clock ?? new SystemClock();
    this.resumeDelayMs = options.resumeDelayMs ?? 0;
    this.failResumeFirst = options.failResumeFirst ?? 0;
    this.failCreateFirst = options.failCreateFirst ?? 0;
    this.modelsDelayMs = options.modelsDelayMs ?? 0;
    this.failModelsFirst = options.failModelsFirst ?? 0;
    this.failSetModelFirst = options.failSetModelFirst ?? 0;
    this.summarizeDelayMs = options.summarizeDelayMs ?? 0;
    this.homeDir = options.homeDir ?? null;
  }

  async createSession(init: CreateSessionInput): Promise<{ sessionId: string; model?: string | null }> {
    // #46 e2e 注入：前 N 次创建抛 spawn 失败（协议级 E_SPAWN_NOT_FOUND，与真实 exe 解析失败同码）
    this.createCalls += 1;
    if (this.createCalls <= this.failCreateFirst) {
      // 消息携带收到的 model（#81 整机 e2e「默认选中真实下发」见证：失败卡原文含模型 id）
      throw new AdapterError(
        "E_SPAWN_NOT_FOUND",
        `未找到 CLI 可执行文件（FakeAdapter 注入：failCreateFirst=${this.failCreateFirst}，演示 spawn 失败；已收到 model=${init.model ?? "未指定"}）`,
      );
    }
    const sessionId = randomId("s");
    const s: SessionState = {
      sessionId,
      cwd: init.cwd,
      model: init.model,
      permMode: init.permMode,
      seq: 0,
      log: [],
      transcript: [],
      status: "idle",
      script: null,
      ix: 0,
      stream: null,
      lastToolItemId: null,
      runningToolItemId: null,
      pendingApproval: null,
      skipApprovals: false,
      queue: [],
    };
    this.sessions.set(sessionId, s);
    this.emit(s, { type: "session_status", status: "idle" });
    return { sessionId, model: init.model }; // model 透传（issue #76：fake 会话实际采用即请求值）
  }

  /** 模型目录（issue #76）：返回两条假模型（拷贝防调用方改写常量），第一条默认；#81 注入：延迟/前 N 次失败（整机 e2e 驱动加载/失败态） */
  async listModels(_input: ListModelsInput): Promise<ModelEntry[]> {
    this.listModelsCalls += 1;
    if (this.modelsDelayMs > 0) await new Promise((r) => setTimeout(r, this.modelsDelayMs));
    if (this.listModelsCalls <= this.failModelsFirst) {
      throw new AdapterError("E_SPAWN_NOT_FOUND", `未找到 CLI 可执行文件（FakeAdapter 注入：failModelsFirst=${this.failModelsFirst}，驱动模型列表拉取失败态）`);
    }
    return FAKE_MODELS.map((m) => ({ ...m }));
  }

  /** 命令列举（ADR 0004：fake 无命令源，非 codex 恒空集——斜杠菜单空态引导，每次新数组）；
   *  cli=codex 时走真实 codex prompts 目录扫描（KANBAN_DISABLE_CODEX 回落 Fake 的场景保持目录语义一致，
   *  展开派发链路整机 e2e 无需真实 exe 即可端到端驱动） */
  async listCommands(input: ListCommandsInput): Promise<CommandEntry[]> {
    if (input.cli === "codex") return listCodexPromptCommands(input.cwd, this.homeDir ?? homedir());
    return [];
  }

  /** 会话中途切换模型（issue #79）：存储 no-op——记录所选值并回显，不报错、不影响演示脚本；#81 注入：前 N 次失败（整机 e2e 驱动回滚） */
  async setModel(input: SetModelInput): Promise<{ model: string }> {
    const s = this.requireSession(input.sessionId);
    this.setModelCalls += 1;
    if (this.setModelCalls <= this.failSetModelFirst) {
      throw new AdapterError("E_INTERNAL", `注入的模型切换失败（failSetModelFirst=${this.failSetModelFirst}，FakeAdapter 测试钩子）：模型 ${input.model} 不可用`);
    }
    s.model = input.model;
    return { model: input.model };
  }

  /** 一次性标题摘要（#95 / ADR 0003 决策 3）：固定值（整机 e2e 断言侧栏翻转）；#95 注入：前置延迟（驱动「摘要进行中重命名不被覆盖」竞态） */
  async summarizeTitle(sessionId: string): Promise<string | null> {
    this.requireSession(sessionId);
    if (this.summarizeDelayMs > 0) await new Promise((r) => setTimeout(r, this.summarizeDelayMs));
    return FAKE_SUMMARIZED_TITLE;
  }

  async sendTurn(input: SendTurnInput): Promise<void> {
    const s = this.requireSession(input.sessionId);
    // 不变量 1：立即返回「已提交」，内容一律经事件流
    // 不变量 6：忙态（运行中/流式中/等待审批）排队，当前 turn 结束后续发
    if (s.script || s.stream || s.pendingApproval) {
      s.queue.push(input.text);
      return;
    }
    this.startTurn(s, input.text);
  }

  async interruptTurn(sessionId: string): Promise<void> {
    const s = this.requireSession(sessionId);
    // 不变量 6：幂等 —— 无活动 turn 时为 no-op
    if (!s.script && !s.stream && !s.pendingApproval) return;
    if (s.pendingApproval) {
      s.pendingApproval.cancelExpire();
      s.pendingApproval = null;
    }
    if (s.stream) {
      // 对照原型：流式文本补「 …」收尾后终结该分段
      const st = s.stream;
      this.emit(s, { type: "message_delta", itemId: st.itemId, partId: st.partId, delta: " …" });
      this.emit(s, { type: "message_completed", itemId: st.itemId, partId: st.partId });
      s.transcript.push({ role: "assistant", text: `${st.target.slice(0, st.pos)} …` }); // #28：被打断文本按已流出部分收场
      s.stream = null;
    }
    if (s.runningToolItemId) {
      this.emit(s, { type: "tool_completed", itemId: s.runningToolItemId, status: "interrupted", durationMs: 0, output: "" });
      s.runningToolItemId = null;
    }
    // 中断丢弃脚本与排队消息（spec H：中断中的工具调用不自动继续、不重放）
    s.script = null;
    s.queue.length = 0;
    this.emit(s, { type: "turn_interrupted", reason: "user" });
    this.emit(s, { type: "session_status", status: "interrupted" });
  }

  async resolveApproval(input: ResolveApprovalInput): Promise<void> {
    const s = this.requireSession(input.sessionId);
    // 非法时序：无待决审批或 requestId 不匹配（已决/过期）→ 明确错误码
    if (!s.pendingApproval || s.pendingApproval.requestId !== input.requestId) {
      throw new AdapterError("E_APPROVAL_EXPIRED", `审批请求不存在或已终结：${input.requestId}`);
    }
    const { itemId, step, cancelExpire } = s.pendingApproval;
    cancelExpire();
    s.pendingApproval = null;
    this.emit(s, { type: "session_status", status: "running" });
    if (input.decision === "deny") {
      // 审批语义不换写：deny → 工具确为未执行（denied 终态）
      this.emit(s, { type: "tool_completed", itemId, status: "denied", durationMs: DECIDED_TOOL_DURATION_MS, output: "" });
      this.runningToolDone(s);
      s.script = step.onDeny ? step.onDeny.map((x) => ({ ...x })) : null;
      s.ix = 0;
      if (s.script) this.scheduleTick(s, 0);
      else this.finishTurn(s);
      return;
    }
    const note =
      input.decision === "allow-always" ? "已写入（记住规则，后续同类不再询问）" : "已写入（仅本次允许）";
    this.emit(s, { type: "tool_completed", itemId, status: "completed", durationMs: DECIDED_TOOL_DURATION_MS, output: note });
    this.runningToolDone(s);
    if (input.decision === "allow-always") s.skipApprovals = true;
    // allow → 继续执行脚本剩余步骤（后续同类审批是否再问取决于 once/always）
    this.scheduleTick(s, 0);
  }

  async readHistory(sessionId: string): Promise<ChatEvent[]> {
    const s = this.requireSession(sessionId);
    // 不变量 4：快照=事件日志，与实时流同键同 seq
    return [...s.log];
  }

  async readTranscript(sessionId: string): Promise<TranscriptEvent[]> {
    const s = this.requireSession(sessionId);
    // #28：双视角剧本快照（user 输入 + 助手文本 + 工具标注，随语义节点增量维护）
    return [...s.transcript];
  }

  async resume(sessionId: string): Promise<void> {
    const s = this.requireSession(sessionId);
    // #42 e2e 支撑：可注入延迟（观察「恢复中」态）与前 N 次失败（驱动失败/重试态）；生产构造不传即关闭
    this.resumeCalls += 1;
    if (this.resumeDelayMs > 0) await new Promise((r) => setTimeout(r, this.resumeDelayMs));
    if (this.resumeCalls <= this.failResumeFirst) {
      throw new AdapterError("E_INTERNAL", `注入的恢复失败（failResumeFirst=${this.failResumeFirst}，FakeAdapter 测试钩子）`);
    }
    // Fake 复位实现：丢弃残余活动并经事件流通知空闲
    s.script = null;
    s.stream = null;
    s.queue.length = 0;
    s.pendingApproval = null;
    this.emit(s, { type: "session_status", status: "idle" });
  }

  /** 应用重启收养（#13）：登记断开会话（Fake 无原生历史落盘，readHistory 返回空日志为诚实行为；resume 复位可续） */
  async adoptSession(input: AdoptSessionInput): Promise<void> {
    if (this.sessions.has(input.sessionId)) throw new AdapterError("E_INTERNAL", `会话已存在：${input.sessionId}`);
    const s: SessionState = {
      sessionId: input.sessionId,
      cwd: input.cwd,
      model: input.model,
      permMode: input.permMode,
      seq: 0,
      log: [],
      transcript: [],
      status: "disconnected",
      script: null,
      ix: 0,
      stream: null,
      lastToolItemId: null,
      runningToolItemId: null,
      pendingApproval: null,
      skipApprovals: false,
      queue: [],
    };
    this.sessions.set(input.sessionId, s);
    this.emit(s, { type: "session_status", status: "disconnected" });
  }

  async dispose(input?: DisposeInput): Promise<void> {
    if (input?.sessionId) {
      this.sessions.delete(input.sessionId);
      return;
    }
    this.sessions.clear();
    if (this.ownsClock && this.clock instanceof SystemClock) this.clock.dispose();
  }

  /** C5 演进（#44）：脚本化 mock 无真实子进程 —— 恒空集 */
  async listChildPids(): Promise<number[]> {
    return [];
  }

  subscribe(handler: (event: AdapterEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /* ---------------- 内部：turn 驱动 ---------------- */

  private startTurn(s: SessionState, text: string): void {
    s.script = this.pickTurnScript(text);
    s.ix = 0;
    s.runningToolItemId = null;
    s.transcript.push({ role: "user", text }); // #28：用户输入入剧本（原生 CLI 落盘口径）
    this.emit(s, { type: "session_status", status: "running" });
    this.emit(s, { type: "turn_started", turnId: randomId("t") });
    this.scheduleTick(s, 0);
  }

  private finishTurn(s: SessionState): void {
    s.script = null;
    if (s.stream) {
      const st = s.stream;
      this.emit(s, { type: "message_delta", itemId: st.itemId, partId: st.partId, delta: st.target.slice(st.pos) });
      this.emit(s, { type: "message_completed", itemId: st.itemId, partId: st.partId });
      s.transcript.push({ role: "assistant", text: st.target }); // turnEnd 收尾：终文全部已流出
      s.stream = null;
    }
    if (s.runningToolItemId) {
      this.emit(s, { type: "tool_completed", itemId: s.runningToolItemId, status: "completed", durationMs: 0, output: "" });
      s.runningToolItemId = null;
    }
    this.emit(s, { type: "turn_completed" });
    this.emit(s, { type: "session_status", status: "idle" });
    // 排队续发（不变量 6）
    if (s.queue.length > 0) {
      const next = s.queue.shift()!;
      this.scheduleTick(s, 0, () => this.startTurn(s, next));
    }
  }

  private scheduleTick(s: SessionState, delayMs: number, run?: () => void): void {
    void this.clock.schedule(delayMs, () => {
      if (run) {
        run();
        return;
      }
      this.tick(s);
    });
  }

  /** 单次求值：流式分片或解释一步脚本 */
  private tick(s: SessionState): void {
    if (!s.script || s.pendingApproval) return; // 审批等待：暂停（过期由独立定时器触发）
    if (s.stream) {
      this.emitStreamChunk(s);
      this.scheduleTick(s, s.stream ? STREAM_TICK_MS : STEP_DELAY_MS);
      return;
    }
    const step = s.script[s.ix];
    if (!step) {
      this.finishTurn(s);
      return;
    }
    s.ix += 1;
    this.applyStep(s, step);
  }

  private applyStep(s: SessionState, step: ScriptStep): void {
    switch (step.t) {
      case "wait":
        this.scheduleTick(s, step.ms);
        return;
      case "assistant": {
        const itemId = randomId("m");
        s.stream = { itemId, partId: "0", target: step.text, pos: 0 };
        this.scheduleTick(s, STREAM_TICK_MS);
        return;
      }
      case "tool": {
        const itemId = randomId("tl");
        s.lastToolItemId = itemId;
        s.runningToolItemId = itemId;
        this.emit(s, { type: "tool_started", itemId, tool: step.tool, argsSummary: step.args });
        s.transcript.push({ role: "assistant", text: "", tool: { name: step.tool, summary: step.args } }); // #28：工具调用入剧本
        this.scheduleTick(s, STEP_DELAY_MS);
        return;
      }
      case "toolOutput": {
        if (s.lastToolItemId) {
          this.emit(s, { type: "tool_update", itemId: s.lastToolItemId, outputDelta: step.chunk });
        }
        this.scheduleTick(s, STEP_DELAY_MS);
        return;
      }
      case "toolDone": {
        if (s.lastToolItemId) {
          this.emit(s, {
            type: "tool_completed",
            itemId: s.lastToolItemId,
            status: step.status,
            durationMs: step.durationMs,
            output: step.output ?? "",
          });
          this.runningToolDone(s);
        }
        this.scheduleTick(s, STEP_DELAY_MS);
        return;
      }
      case "approval": {
        // allow-always 已记住规则：同类审批自动放行，不再打扰（会话级）
        if (s.skipApprovals) {
          if (s.lastToolItemId) {
            this.emit(s, {
              type: "tool_completed",
              itemId: s.lastToolItemId,
              status: "completed",
              durationMs: DECIDED_TOOL_DURATION_MS,
              output: "已写入（记住规则，后续同类不再询问）",
            });
            this.runningToolDone(s);
          }
          this.scheduleTick(s, STEP_DELAY_MS);
          return;
        }
        const requestId = randomId("ap");
        const itemId = s.lastToolItemId ?? randomId("tl");
        this.emit(s, { type: "approval_requested", requestId, itemId, command: step.command, suggestions: step.suggestions });
        this.emit(s, { type: "session_status", status: "waiting" });
        const cancelExpire = step.expireAfterMs
          ? this.clock.schedule(step.expireAfterMs, () => this.expireApproval(s, requestId))
          : () => undefined;
        s.pendingApproval = { requestId, itemId, step, cancelExpire };
        return; // 暂停：不续排 tick，等 resolveApproval/过期
      }
      case "skill": {
        // SkillObservation 直发订阅者：不入 chat 日志（readHistory 恢复的是消息流，skill 观察信号经 tracker stage_events 持久化）
        const at = new Date(this.clock.now()).toISOString();
        const obs: SkillObservation = {
          eventId: randomId("sk"),
          kind: "skill",
          sessionId: s.sessionId,
          cli: step.cli,
          skill: step.skill,
          stage: null,
          requirementId: null,
          occurredAt: at,
          receivedAt: at,
          seq: null,
          evidenceLevel: step.evidenceLevel,
          source: "fake-script",
        };
        for (const h of this.handlers) h(obs);
        this.scheduleTick(s, STEP_DELAY_MS);
        return;
      }
      case "error": {
        // 明确报错、不崩溃、不重放：丢弃脚本与队列，状态回空闲，不宣称 turn_completed
        s.script = null;
        s.queue.length = 0;
        s.stream = null;
        this.emit(s, { type: "session_error", code: step.code, message: step.message });
        this.emit(s, { type: "session_status", status: "idle" });
        return;
      }
      case "turnEnd":
        this.finishTurn(s);
        return;
    }
  }

  private expireApproval(s: SessionState, requestId: string): void {
    if (!s.pendingApproval || s.pendingApproval.requestId !== requestId) return;
    const { itemId, step } = s.pendingApproval;
    s.pendingApproval = null;
    // Codex 服务端终态（timed_out）→ 统一 approval_expired 回传（spec B 映射表）
    this.emit(s, { type: "approval_expired", requestId, reason: "timed_out" });
    this.emit(s, { type: "tool_completed", itemId, status: "denied", durationMs: DECIDED_TOOL_DURATION_MS, output: "" });
    this.runningToolDone(s);
    this.emit(s, { type: "session_status", status: "running" });
    s.script = step.onDeny ? step.onDeny.map((x) => ({ ...x })) : null;
    s.ix = 0;
    if (s.script) this.scheduleTick(s, 0);
    else this.finishTurn(s);
  }

  private emitStreamChunk(s: SessionState): void {
    const st = s.stream;
    if (!st) return;
    const nextPos = Math.min(st.pos + STREAM_CHUNK_CHARS, st.target.length);
    this.emit(s, { type: "message_delta", itemId: st.itemId, partId: st.partId, delta: st.target.slice(st.pos, nextPos) });
    st.pos = nextPos;
    if (nextPos >= st.target.length) {
      this.emit(s, { type: "message_completed", itemId: st.itemId, partId: st.partId });
      s.transcript.push({ role: "assistant", text: st.target }); // #28：完整流出的助手文本入剧本
      s.stream = null;
    }
  }

  private runningToolDone(s: SessionState): void {
    s.runningToolItemId = null;
  }

  /* ---------------- 内部：事件与工具 ---------------- */

  /** 事件唯一出口：写日志（seq 单调分配）+ 通知订阅者 —— readHistory 与实时流零分叉 */
  private emit(s: SessionState, ev: ChatEventSeed): void {
    s.seq += 1;
    const full = { ...ev, sessionId: s.sessionId, seq: s.seq, at: new Date(this.clock.now()).toISOString() } as ChatEvent;
    s.log.push(full);
    for (const h of this.handlers) h(full);
  }

  private requireSession(sessionId: string): SessionState {
    const s = this.sessions.get(sessionId);
    if (!s) throw new AdapterError("E_SESSION_NOT_FOUND", `会话不存在：${sessionId}`);
    return s;
  }
}

/** id 生成：crypto.randomUUID 前缀化（日志可读；各运行时均可用） */
function randomId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
}
