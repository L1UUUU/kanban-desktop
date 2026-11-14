// 用途：C1 Adapter 统一契约（spec B 冻结）—— 会话级方法面 + capabilities + 带错误码的异常；实现侧（Fake/三 CLI）与宿主（CliHost/Main 路由）共同依赖；可选面含 runOnce/cancelRunOnce 与 listChildPids（issue #73 托管附加能力并入）；arch C13 起可选方法的缺席判定单源 = capabilities 同键布尔（方法本体保持 TS 可选）；arch D2 起目录级四命令（createSession/listModels/listCommands/adoptSession）自带 CLI 维度，拆出到 CliDirectory（cli 经 forCli 句柄参数承载，input 不含 cli 字段），CliAdapter 收成会话级方法面
import type {
  ApprovalDecision,
  ApprovalSuggestion,
  AdapterEvent,
  ChatEvent,
  CommandEntry,
  ErrorCode,
  ModelEntry,
  PermMode,
  TranscriptEvent,
} from "@kanban/ipc-schema";
import type { RunOnceInput, RunOnceResult } from "./host/run-once";

/**
 * 能力声明：未实证能力 UI 不暴露控件（spec B capabilities）。
 * arch C13：可选方法（adoptSession / runOnce+cancelRunOnce / listChildPids）是否可用的判定单源收进本面——
 * 声明 true ⇒ 同名（runOnce 门控 runOnce/cancelRunOnce 两个同门方法）方法必在场可调用；false ⇒ 调用方按各自业务降级，
 * 不再对方法做 `?.` 存在性探测散判定。能力与方法在场的同步由实现方保证（adapter.contract 契约断言钉住）。
 * summarizeTitle 不在此面：必选方法 + null 返回语义（ADR 0003 决策 3，null = 该会话无可摘要而非无能力）。
 */
export interface AdapterCapabilities {
  approval: boolean;
  interrupt: boolean;
  resume: boolean;
  readHistory: boolean;
  skillSignal: boolean;
  /** 会话收养（adoptSession）：false ⇒ 目录面 adoptSession 缺席，恢复编排降级（reject / 落库断开） */
  adoptSession: boolean;
  /** 一次性执行（runOnce 与 cancelRunOnce 同门）：false ⇒ 两方法均缺席，记忆提取降级不接桥 */
  runOnce: boolean;
  /** 活跃子进程上报（listChildPids）：false ⇒ 方法缺席，聚合方按空集处理 */
  listChildPids: boolean;
}

/** createSession 输入（arch D2 起 cli 维度经 forCli 句柄承载，input 不含 cli 字段；cwd 必填；model/permMode 由 Adapter 映射到各 CLI 原生机制） */
export interface CreateSessionInput {
  cwd: string;
  model?: string;
  permMode?: PermMode;
}

/** createSession 返回：nativeSessionId 为各 CLI 原生会话 id（Codex thread id 等；Fake 无则为 undefined/null），宿主据此回填 sessions 表；model 为该会话实际采用的模型（spec #75：codex=探测结果、opencode=显式值或 /config 默认、fake/claude 透传请求值；undefined=未指定且未知） */
export interface CreateSessionResult {
  sessionId: string;
  nativeSessionId?: string | null;
  model?: string | null;
}

export interface SendTurnInput {
  sessionId: string;
  text: string;
}

export interface ResolveApprovalInput {
  sessionId: string;
  requestId: string;
  decision: ApprovalDecision;
}

export interface DisposeInput {
  sessionId?: string;
}

/** listModels 输入（issue #76 / spec #75）：cwd 供 server-per-project CLI（opencode）拉起 server；cli 维度经 forCli 句柄承载（arch D2） */
export interface ListModelsInput {
  cwd: string;
}

/** listCommands 输入（issue #89 / spec #82 E 块）：cwd 供项目级目录扫描与 server-per-project CLI（opencode）拉起 server；cli 维度经 forCli 句柄承载（arch D2） */
export interface ListCommandsInput {
  cwd: string;
}

/** setModel 输入（issue #79 / spec #75）：会话中途切换模型 —— idle 可切、下一轮生效；忙态/断开由 main 侧校验拒绝 */
export interface SetModelInput {
  sessionId: string;
  model: string;
}

/** 会话收养输入（#13 恢复编排）：按 DB 持久化的 native id 重建会话状态（登记 disconnected，无进程；readHistory/resume 按需拉起）；cli 维度经 forCli 句柄承载（arch D2） */
export interface AdoptSessionInput {
  /** 应用侧 sessionId（DB sessions 表 PK） */
  sessionId: string;
  /** 各 CLI 原生会话 id（sessions.native_session_id；Fake 等无原生 id 的实现忽略） */
  nativeSessionId: string;
  cwd: string;
  permMode?: PermMode;
  model?: string;
}

/**
 * CLI exe 解析失败（#46）：exe 解析链（arch C4 骨架 exe-chain.ts）全链落空时抛出；各 Adapter spawn 阶段
 * catch 经 exe-chain 的 mapSpawnFailure 单点映射为 AdapterError("E_SPAWN_NOT_FOUND")（协议级，renderer classify 归 spawn_not_found 卡）。
 * 独立于 AdapterError（run-once 等既有 catch 继续按普通 Error 包装 E_INTERNAL，行为不变）。
 */
export class ExeNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExeNotFoundError";
  }
}

/** Adapter 异常：code 形状由 ipc-schema 定义（不变量 6），宿主据此映射 IPC 错误 */
export class AdapterError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

/**
 * 目录级命令面（arch D2）：createSession/listModels/listCommands/adoptSession 四命令自带 CLI 维度且无会话上下文，
 * 自会话级 CliAdapter 拆出独立 interface —— cli 经 CliAdapter.forCli(cli) 句柄参数承载（缺省 fake 的兜底单点在
 * AdapterRouter.forCli），input 不含 cli 字段，路由知识不再泄漏进单实现签名。
 * 单实现（Fake/三真实 CLI）以本面实现四方法（Fake 按 forCli 绑定身份模拟 codex 目录，其余身份即自身）；
 * 分发门面（AdapterRouter/CliHostClient）的 forCli 返回分发/wire 转发句柄。
 */
export interface CliDirectory {
  createSession(init: CreateSessionInput): Promise<CreateSessionResult>;
  /**
   * 模型目录查询（issue #76 / spec #75）：返回该 CLI 当前可用的模型目录（统一 ModelEntry 四字段条目；
   * 默认项由 isDefault 派生，无独立 defaultModel 字段）。进程握手/缓存/摊平隐藏在各 adapter 内；
   * 不可用（未安装/未登录/协议失败）抛 AdapterError。
   */
  listModels(input: ListModelsInput): Promise<ModelEntry[]>;
  /**
   * 斜杠命令列举（issue #89 / spec #82 E 块）：返回该 CLI 当前可用的统一命令目录（CommandEntry：名称/描述/参数提示/来源/所属 CLI/来源文件路径/仅用户调用标记）。
   * 目录级命令（无会话上下文）：claude/codex 扫描用户级+项目级目录（任何读取失败安全降级，目录缺失为空集不报错）；
   * opencode 经原生 /command API（server-per-project 按 cwd 拉起，不可用抛 AdapterError）；fake 返回固定演示集。
   * 列举不解析命令正文（sourcePath 供后续派发按需读取）；发送/派发判定不经此面。
   */
  listCommands(input: ListCommandsInput): Promise<CommandEntry[]>;
  /** 会话收养（可选能力，#13）：登记断开会话供 readHistory/resume 恢复；缺席判定单源 = capabilities.adoptSession（arch C13），未实现时恢复编排落库为断开并报错引导 */
  adoptSession?(input: AdoptSessionInput): Promise<void>;
}

/**
 * C1 统一接口（全部方法异步；订阅为同步注册返回退订函数）。arch D2 起只承载会话级方法面——目录级四命令见 CliDirectory，
 * 经 forCli(cli) 句柄进入。六不变量（spec B，强制）：
 * 1. 内容一律经事件流返回，sendTurn 只表达「已提交」；
 * 2. 审批语义不换写（统一枚举映射各 CLI 原生机制）；
 * 3. 事件带可合并键（itemId/partId），流式增量无重复无丢失；
 * 4. readHistory 快照与实时流同一合并键，快照后增量无缝拼接；
 * 5. Adapter 独占 CLI 进程生命周期（宿主不触碰子进程）；
 * 6. 忙态 sendTurn 排队 + interruptTurn 幂等；错误码形状由 ipc-schema 定义。
 */
export interface CliAdapter {
  readonly capabilities: AdapterCapabilities;
  /**
   * 目录级命令句柄（arch D2）：按 CLI 取 CliDirectory——单实现（Fake/三真实 CLI）返回自身目录面（Fake 按
   * 绑定身份模拟 codex 目录）；分发门面（AdapterRouter/CliHostClient）返回分发/wire 转发句柄。
   * 「cli 缺省 → fake」兜底单点 = AdapterRouter.forCli。
   */
  forCli(cli?: string): CliDirectory;
  sendTurn(input: SendTurnInput): Promise<void>;
  interruptTurn(sessionId: string): Promise<void>;
  resolveApproval(input: ResolveApprovalInput): Promise<void>;
  readHistory(sessionId: string): Promise<ChatEvent[]>;
  /**
   * C1 演进（#28 / spec #27 B 节）：读取会话原生历史的 user/assistant 双视角事件。
   * 与 readHistory（GUI 聊天流，ChatEvent 13 成员无 user 消息）互补而非替代；
   * capabilities 门控同 readHistory（无单独开关）；各实现从原生历史源只读拉取。
   */
  readTranscript(sessionId: string): Promise<TranscriptEvent[]>;
  resume(sessionId: string): Promise<void>;
  dispose(input?: DisposeInput): Promise<void>;
  /**
   * C5 演进（#44 / spec #40 C 节）：上报本 Adapter 当前管理的全部活跃 CLI 子进程 pid（去重集合）。
   * 可选成员：缺席判定单源 = capabilities.listChildPids（arch C13），无子进程的实现（Fake 等）实现为空集返回；
   * 残留治理（#49）以此 worker/进程内形态上报的并集为「本应用活跃集合」判定基准。
   */
  listChildPids?(): Promise<number[]>;
  /**
   * 一次性 CLI 执行（#29 C5 演进；issue #73 并入 CliAdapter 可选面，取代 instanceof 探测）。
   * 缺席判定单源 = capabilities.runOnce（arch C13）：托管形态（utilityProcess worker 的 CliHostClient）声明 true，
   * 进程内回退 AdapterRouter 并集为 false——CLI 形态知识归声明侧，main 只查能力面。
   * shortcut: AdapterRouter（进程内回退）暂不实现 runOnce/cancelRunOnce（能力并集恒 false）；复查触发条件 = 回退形态需要提取能力时给 Router 挂 RunOnceRunner
   */
  runOnce?(input: RunOnceInput): Promise<RunOnceResult>;
  /** 取消进行中的一次性执行（与 runOnce 同门能力，缺席判定同查 capabilities.runOnce；未实现即缺席，调用方按无此能力处理） */
  cancelRunOnce?(runId: string): Promise<void>;
  /**
   * 会话中途切换模型（issue #79 / spec #75）：统一语义 idle 可切、下一轮生效——codex 更新会话态（此后每次
   * turn/start 携带 model 覆盖参数，幂等）；claude 向活进程发 set_model 控制请求并以响应实际模型名回写会话态；
   * opencode 仅更新会话态（prompt 请求已带 model）；fake 存储 no-op。返回下一轮实际生效的模型名；失败抛 AdapterError。
   */
  setModel(input: SetModelInput): Promise<{ model: string }>;
  /**
   * 一次性标题摘要（#95 / ADR 0003 决策 3）：spawn 独立一次性进程（喂截断的最近对话文本、会话当前模型、
   * 超时独立设定），不进会话事件流、不污染会话上下文；返回单行标题文本，null = 无素材或该 CLI 无摘要能力
   * （opencode prompt API 需会话上下文，恒 null 降级保留 fallback）。失败/超时抛 AdapterError（调用方静默不重试）。
   */
  summarizeTitle(sessionId: string): Promise<string | null>;
  /** 订阅归一化事件流（ChatEvent ∪ SkillObservation），返回退订函数 */
  subscribe(handler: (event: AdapterEvent) => void): () => void;
}

export type { ApprovalDecision, ApprovalSuggestion, AdapterEvent, ChatEvent, CommandEntry, ModelEntry, PermMode, TranscriptEvent };
