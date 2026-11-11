// 用途：PTY 终端草稿控制器（#60，spec #57）—— 点「＋」只开草稿（不落库、不进侧栏、不起进程）；草稿态输入不直写 terminal:write，首个输入触发 terminal:create（渲染端预生成终端 id + 首输入缓冲）；启动失败草稿与缓冲保留可重试；external store 模式供 useSyncExternalStore 消费
import type { IpcOk, IpcRequest, IpcResult, TerminalCommand } from "@kanban/ipc-schema";

/** 草稿快照（终端面板渲染数据源；null=无草稿） */
export interface TerminalDraftSnapshot {
  /** 渲染端预生成终端 id（uuid，与 Main randomUUID 同格式；创建后即会话 id） */
  terminalId: string;
  projectId: string | null;
  cwd: string;
  command?: TerminalCommand;
  requirementId?: string;
  /** 面板当前尺寸（创建请求携带，避免 spawn 后 80×30 与实际错位） */
  cols: number;
  rows: number;
  /** 创建请求已发出（在途）：期间输入先缓冲，成功后补写剩余部分 */
  creating: boolean;
  /** 缓冲输入（含创建失败后保留的全部输入，重试时随 create 重放，首输入不丢失） */
  buffer: string;
  /** 本次 create 已携带的 buffer 前缀长度（成功后仅补写 slice(launchedLength)） */
  launchedLength: number;
  /** 本草稿替换过已有草稿（提示行显示「已替换上一个草稿」，与结构化草稿同款文案，spec #57 Story 4） */
  replacedHint: boolean;
  /** 最近一次创建失败（IPC 错误；null=无） */
  error: { code: string; message: string } | null;
}

/** 创建成功事件（调用方登记会话行并补写剩余输入） */
export interface TerminalDraftCreated {
  terminalId: string;
  ok: IpcOk;
  /** 创建请求的原始参数（projectId/cwd/command/requirementId） */
  opts: { projectId: string | null; cwd: string; command?: TerminalCommand; requirementId?: string };
  /** 创建期间到达的输入（调用方经 terminal:write 补写，保序） */
  remainder: string;
}

/** 控制器依赖 */
export interface TerminalDraftDeps {
  invoke(req: IpcRequest): Promise<IpcResult>;
  /** 创建成功（含草稿已被丢弃的迟到成功——Main 已落库，调用方仍须登记会话） */
  onCreated(ev: TerminalDraftCreated): void;
  /** 创建失败（渲染端日志用；草稿态是否更新由控制器自行判断） */
  onFailed?(ev: { terminalId: string; code: string; message: string }): void;
}

/** 打开草稿的参数（与原 terminals.create 对齐：cwd 必填；requirementId 随首输入触发的创建落关联） */
export interface OpenDraftOptions {
  projectId: string | null;
  cwd: string;
  command?: TerminalCommand;
  requirementId?: string;
  /** 替换提示单源（issue #71 S4）：openSessionDraft 判定「两类任一草稿被替换」后显式传入；缺省自算（仅本类） */
  replacedHint?: boolean;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 30;

export class TerminalDraftController {
  private state: TerminalDraftSnapshot | null = null;
  private listeners = new Set<() => void>();

  constructor(private readonly deps: TerminalDraftDeps) {}

  /** useSyncExternalStore 数据源（无变更间引用稳定：copy-on-write） */
  getSnapshot = (): TerminalDraftSnapshot | null => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 打开（或替换为）新草稿：全局仅一个；在途创建不取消（迟到结果仍上报） */
  open(opts: OpenDraftOptions): void {
    const replaced = opts.replacedHint ?? this.state !== null;
    this.state = {
      terminalId: globalThis.crypto.randomUUID(),
      projectId: opts.projectId,
      cwd: opts.cwd,
      ...(opts.command ? { command: opts.command } : {}),
      ...(opts.requirementId ? { requirementId: opts.requirementId } : {}),
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      creating: false,
      buffer: "",
      launchedLength: 0,
      replacedHint: replaced,
      error: null,
    };
    this.changed();
  }

  /** 丢弃草稿（切换会话/项目、替换草稿时；无确认——草稿无任何持久化副作用） */
  discard(): void {
    if (!this.state) return;
    this.state = null;
    this.changed();
  }

  /**
   * 草稿态输入门闸（TerminalManager io.write 路由）：命中草稿返回 true（不直写 terminal:write）；
   * 首输入触发创建（含失败重试：缓冲合并后整体重放），创建在途时仅缓冲。
   */
  handleInput(terminalId: string, data: string): boolean {
    const d = this.state;
    if (!d || d.terminalId !== terminalId) return false;
    this.state = { ...d, buffer: d.buffer + data };
    if (!d.creating) this.launch(this.state);
    else this.changed();
    return true;
  }

  /** 草稿面板尺寸记录（命中返回 true；创建请求携带最新尺寸） */
  recordSize(terminalId: string, cols: number, rows: number): boolean {
    const d = this.state;
    if (!d || d.terminalId !== terminalId) return false;
    this.state = { ...d, cols, rows };
    this.changed();
    return true;
  }

  /** 发起创建：firstInput=当前全部缓冲；结果回调里只更新仍是当前草稿的状态 */
  private launch(d: TerminalDraftSnapshot): void {
    const firstInput = d.buffer;
    const launched = { ...d, creating: true, launchedLength: d.buffer.length, error: null };
    this.state = launched;
    this.changed();
    void this.deps
      .invoke({
        channel: "terminal:create",
        terminalId: launched.terminalId,
        cwd: launched.cwd,
        cols: launched.cols,
        rows: launched.rows,
        ...(launched.projectId ? { projectId: launched.projectId } : {}),
        command: launched.command,
        requirementId: launched.requirementId,
        firstInput,
      })
      .then((r) => {
        const opts = { projectId: launched.projectId, cwd: launched.cwd, ...(launched.command ? { command: launched.command } : {}), ...(launched.requirementId ? { requirementId: launched.requirementId } : {}) };
        // 剩余输入 = 创建在途期间新到的部分（this.state 仍是同一草稿时取最新 buffer，否则回落发起时快照）
        const latest = this.state?.terminalId === launched.terminalId ? this.state : launched;
        if (r.ok && r.sessionId) {
          // 迟到成功（草稿已被丢弃/替换）也上报：Main 已落库，调用方须登记会话行
          this.deps.onCreated({ terminalId: launched.terminalId, ok: r, opts, remainder: latest.buffer.slice(launched.launchedLength) });
          if (this.state?.terminalId === launched.terminalId) {
            this.state = null;
            this.changed();
          }
          return;
        }
        const code = r.ok ? "E_INTERNAL" : r.error.code;
        const message = r.ok ? "创建响应缺少会话 id" : r.error.message;
        this.deps.onFailed?.({ terminalId: launched.terminalId, code, message });
        if (this.state?.terminalId === launched.terminalId) {
          // 失败：草稿保留、缓冲保留（下个输入合并重试）
          this.state = { ...this.state, creating: false, error: { code, message } };
          this.changed();
        }
      });
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }
}
