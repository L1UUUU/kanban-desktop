// 用途：MemoryService（spec #27 A 节）—— Main 进程内的 memory 深模块：store 级动作全量（审核三动作/终态拒绝/resolveSummary/需求一次读/项目一次读含查询过滤/知识再编辑/#35 删除级联入口；arch D7 起审核流转规则单源 @kanban/memory，本层只把类型化业务拒绝映射为 wire 方言）+ #32 提取管线编排（extract 启动真批次 / cancel 终止临时执行整批丢弃 / stop 退出序列停止）+ openMemoryService 启动对账装配；db 句柄、数据根目录与双桥（readTranscript/runOnce）经注入，需求关联会话/标题由 Main 查询后传入（memory 不依赖 tracker）
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { MemoryEventWire, MemorySummaryRow, TranscriptEvent } from "@kanban/ipc-schema";
import {
  MemoryRejectionError,
  MemoryStore,
  SummaryStore,
  reconcileMemory,
  type MemoryBatchRecord,
  type MemoryCandidateRecord,
  type MemorySummaryRecord,
  type ReconcileReport,
  type ReviewAction,
  type SqliteDb,
} from "@kanban/memory";
import { finishBatchIfRunning, runExtractionPipeline, type ExtractionBridges, type ExtractionControl, type RunOnceCall, type RunOnceOutcome } from "./memory-pipeline";

/** 业务拒绝形状（wire memoryRejectionSchema 同构；reason 为自由字符串，不新增全局错误码） */
export interface MemoryRejectionResult {
  ok: false;
  reason: string;
  detail?: string;
}

/** reviewCandidate / editAccepted 成功形状 */
export interface CandidateResult {
  ok: true;
  candidate: MemoryCandidateRecord;
}

/** 进行中提取登记（cancel/stop 的锚点：控制柄 + 落定 Promise） */
interface RunningExtraction {
  batchId: string;
  requirementId: string;
  control: ExtractionControl;
  done: Promise<void>;
}

/** MemoryService 依赖注入 seam（可测）：db 句柄 + 数据根目录 + Main 侧 tracker 查询 + 提取双桥 + memory:event 推送 */
export interface MemoryServiceDeps {
  db: SqliteDb;
  /** Markdown 数据根（<userData>/memory，spec #27 D 节布局；提取临时 cwd 也在此下） */
  dataRoot: string;
  /** 需求当前关联 structured 会话（Main 查 tracker 后传入；PTY 会话不入提取范围，US2） */
  listLinkedStructuredSessions(requirementId: string): Array<{ sessionId: string; cli: string }>;
  /** 需求当前关联 PTY 会话（Main 查 tracker 后传入；US3 无结构化历史 → 列入 missingSessions 声明） */
  listLinkedPtySessions?(requirementId: string): Array<{ sessionId: string }>;
  /** 需求项目归属（Main 查 tracker 注入；批次行 projectId 与提取临时 cwd 定位用） */
  getRequirementProjectId?(requirementId: string): string | null;
  /** 需求标题（Main 查 tracker 注入；记忆视图总结行标题与「标题+正文」搜索的标题字段） */
  getRequirementTitle(requirementId: string): string | null;
  /** 需求存在性（tracker 口径；提取阶段边界守卫「提取中需求被删除」删除竞态，#35 边界；缺省恒存在） */
  requirementExists?(requirementId: string): boolean;
  /** readTranscript 桥（#28：Main → cli-host adapter 双视角历史；未接线 → extract 拒 cli-unavailable） */
  readTranscriptBridge?(appSessionId: string): Promise<TranscriptEvent[]>;
  /** runOnce 桥（#29：Main → cli-host worker 一次性执行；未接线 → extract 拒 cli-unavailable） */
  runOnceBridge?(input: RunOnceCall): Promise<RunOnceOutcome>;
  /** cancelRunOnce 桥（终止进行中的临时执行；真实装配必接，缺省 no-op） */
  cancelRunOnceBridge?(runId: string): Promise<void> | void;
  /** memory:event 推送（批次状态/段进度；缺省丢弃供不需要推送的测试） */
  emitMemoryEvent?(event: MemoryEventWire): void;
  /** stop() 等待进行中批次落定的上限 ms（缺省 3000；超时兜底直接收敛 cancelled） */
  stopSettleMs?: number;
}

export class MemoryService {
  readonly store: MemoryStore;
  readonly summaries: SummaryStore;
  private readonly deps: MemoryServiceDeps;
  /** 进行中提取（requirementId → 锚点）；批次行 running 状态是串行判定的唯一事实源，本表是取消路由 */
  private readonly running = new Map<string, RunningExtraction>();

  constructor(deps: MemoryServiceDeps) {
    this.deps = deps;
    this.store = new MemoryStore(deps.db, deps.dataRoot);
    this.summaries = new SummaryStore(deps.db, deps.dataRoot);
  }

  /**
   * 提取需求经验（US1 手动触发，issue #32 管线）：前置业务拒绝后同步建 running 批次行并异步起管线
   * （批次行先于返回落库——同需求二次触发在同一 tick 内即被 extraction-running 拒绝，无竞态窗口）。
   * 拒绝语义：no-sessions（零关联 structured 会话）/ extraction-running（US11 同需求串行）/
   * cli-unavailable（提取双桥未接线，如进程内回退 adapter 无 runOnce 能力）/ requirement-not-found（防御）。
   */
  extract(requirementId: string): MemoryRejectionResult | { ok: true; started: true; batchId: string } {
    const sessions = this.deps.listLinkedStructuredSessions(requirementId);
    if (sessions.length === 0) {
      return { ok: false, reason: "no-sessions", detail: "该需求当前没有关联的结构化会话，无历史可提取" };
    }
    if (this.hasRunningBatch(requirementId)) {
      return { ok: false, reason: "extraction-running", detail: "该需求已有进行中的提取批次，禁止重复触发" };
    }
    const readTranscript = this.deps.readTranscriptBridge;
    const runOnce = this.deps.runOnceBridge;
    if (!readTranscript || !runOnce) {
      return { ok: false, reason: "cli-unavailable", detail: "提取引擎桥未接线（cli-host runOnce 能力不可用），无法启动提取" };
    }
    const projectId = this.deps.getRequirementProjectId?.(requirementId) ?? null;
    if (!projectId) {
      return { ok: false, reason: "requirement-not-found", detail: `需求 ${requirementId} 不存在或无项目归属，无法创建提取批次` };
    }
    // 同步建批次行（running）：返回前即占据同需求串行判定；sourceSessionCount 为触发时关联 structured 会话数
    const batchId = randomUUID();
    this.store.createBatch({ id: batchId, requirementId, projectId, sourceSessionCount: sessions.length });

    const bridges: ExtractionBridges = {
      readTranscript,
      runOnce,
      cancelRunOnce: this.deps.cancelRunOnceBridge ? (runId) => this.deps.cancelRunOnceBridge?.(runId) : undefined,
    };
    const control: ExtractionControl = { aborted: false, currentRunId: null };
    // 管线不抛错（内部收敛为批次终态 + 事件）；finally 摘除登记，同需求可再发起新批次
    const done = runExtractionPipeline(
      {
        store: this.store,
        summaries: this.summaries,
        bridges,
        control,
        dataRoot: this.deps.dataRoot,
        emit: (event) => this.deps.emitMemoryEvent?.(event),
        requirementExists: this.deps.requirementExists,
      },
      {
        batchId,
        requirementId,
        projectId,
        requirementTitle: this.deps.getRequirementTitle(requirementId),
        sessions,
        ptySessions: this.deps.listLinkedPtySessions?.(requirementId) ?? [],
      },
    ).finally(() => {
      if (this.running.get(requirementId)?.batchId === batchId) this.running.delete(requirementId);
    });
    this.running.set(requirementId, { batchId, requirementId, control, done });
    return { ok: true, started: true, batchId };
  }

  /**
   * 取消进行中的提取（US9）：终止当前段临时执行（#29 cancelRunOnce 桥）并等待整批落定——
   * running→cancelled、无候选落库（落库只在整批完成时发生，事务语义天然保证整批丢弃）。
   * 无进行中批次 → no-extraction-running；库内有 running 行但无编排（孤儿）→ 直接收敛 cancelled。
   */
  async cancel(requirementId: string): Promise<MemoryRejectionResult | { ok: true; cancelled: true }> {
    const entry = this.running.get(requirementId);
    if (!entry) {
      const orphan = this.store.listBatches(requirementId).find((b) => b.status === "running");
      if (!orphan) return { ok: false, reason: "no-extraction-running", detail: "该需求没有进行中的提取批次" };
      finishBatchIfRunning(this.store, orphan.id, { status: "cancelled", error: "取消（无进行中编排，直接收敛）" });
      this.deps.emitMemoryEvent?.({ type: "batch-status", batchId: orphan.id, requirementId, status: "cancelled" });
      return { ok: true, cancelled: true };
    }
    entry.control.aborted = true;
    await this.cancelCurrentRun(entry.control);
    await entry.done;
    return { ok: true, cancelled: true };
  }

  /**
   * 退出序列停止（spec #27 C 节：排在 adapter/PTY 之后、DB 关闭前）：全部进行中批次置取消 →
   * 有限等待落定（默认 3s，桥可能已随 cli-host worker 退出而拒绝）→ 兜底把仍未落定的批次行直接收敛 cancelled，
   * 保证 DB 关闭前无 running 残留（重启对账的崩溃窗口由此消除）。
   */
  async stop(): Promise<void> {
    const entries = [...this.running.values()];
    for (const e of entries) {
      e.control.aborted = true;
      await this.cancelCurrentRun(e.control);
    }
    await Promise.race([
      Promise.allSettled(entries.map((e) => e.done)),
      new Promise((r) => setTimeout(r, this.deps.stopSettleMs ?? 3000)),
    ]);
    for (const e of entries) {
      if (finishBatchIfRunning(this.store, e.batchId, { status: "cancelled", error: "应用退出取消" })) {
        this.deps.emitMemoryEvent?.({ type: "batch-status", batchId: e.batchId, requirementId: e.requirementId, status: "cancelled" });
      }
    }
    this.running.clear();
  }

  /** 终止控制柄锚定的当前段临时执行（best-effort：桥不可用/已退出时忽略） */
  private async cancelCurrentRun(control: ExtractionControl): Promise<void> {
    const runId = control.currentRunId;
    if (!runId || !this.deps.cancelRunOnceBridge) return;
    try {
      await this.deps.cancelRunOnceBridge(runId);
    } catch {
      /* best-effort：runOnce 落定后管线按 abort/cancelled 收敛 */
    }
  }

  /** 候选审核三动作（US16）：流转规则与拒绝文案单源 store（arch D7），此处仅把类型化业务拒绝映射为 wire 方言 */
  reviewCandidate(
    candidateId: string,
    action: ReviewAction,
    edit?: { claim?: string; scope?: string },
  ): CandidateResult | MemoryRejectionResult {
    try {
      return { ok: true, candidate: this.store.reviewCandidate(candidateId, action, edit) };
    } catch (err) {
      return mapRejection(err);
    }
  }

  /** 总结 proposed 二选一处置（US14：accept-new 采纳新版 / keep-human 保留人工版；处置后暂存清除）。无 proposed 拒绝单源 summary store（arch D7），此处仅映射 wire 方言 */
  resolveSummary(requirementId: string, choice: "accept-new" | "keep-human"): MemoryRejectionResult | { ok: true } {
    try {
      this.summaries.resolveSummary(requirementId, choice);
      return { ok: true };
    } catch (err) {
      return mapRejection(err);
    }
  }

  /** 总结正文编辑写回（issue #38，spec #27 I-8/US13）：需求存在性（tracker 口径）守卫在此（store 不依赖 tracker，arch D7 不收编）；无总结拒绝单源 summary store，此处仅映射 wire 方言 */
  editSummary(requirementId: string, content: string): MemoryRejectionResult | { ok: true } {
    if (this.deps.requirementExists && !this.deps.requirementExists(requirementId)) {
      return { ok: false, reason: "requirement-not-found", detail: `需求 ${requirementId} 不存在，无法编辑总结` };
    }
    try {
      this.summaries.editSummary(requirementId, content);
      return { ok: true };
    } catch (err) {
      return mapRejection(err);
    }
  }

  /** 详情面板一次读（US13/US18）：需求全部批次 + 跨批次全部候选 + 总结（无数据宽容返回空集） */
  requirementMemory(requirementId: string): {
    ok: true;
    batches: MemoryBatchRecord[];
    candidates: MemoryCandidateRecord[];
    summary: MemorySummaryRow | null;
  } {
    return {
      ok: true,
      batches: this.store.listBatches(requirementId),
      candidates: this.store.listRequirementCandidates(requirementId),
      summary: this.toSummaryWire(this.summaries.getSummary(requirementId)),
    };
  }

  /**
   * 记忆视图一次读（US20/US21）：项目已接受知识（accepted/edited，pending/ignored 不进）+ 总结行（含正文）；
   * 可选 query 大小写不敏感子串——知识匹配 claim（标题）与 scope/evidence（正文，取编辑后有效值），
   * 总结匹配需求标题（标题）与 summary.md 正文。
   */
  projectMemory(projectId: string, query?: string): {
    ok: true;
    knowledge: MemoryCandidateRecord[];
    summaries: MemorySummaryRow[];
  } {
    const q = query?.trim().toLowerCase() ?? "";
    const knowledge = this.store.listKnowledge(projectId).filter((k) => {
      if (!q) return true;
      const claim = k.editedClaim ?? k.claim;
      const scope = k.editedScope ?? k.scope;
      return [claim, scope, k.evidence].some((field) => field.toLowerCase().includes(q));
    });
    const summaries = this.summaries
      .listSummaries(projectId)
      .map((row) => this.toSummaryWire(row))
      .filter((s): s is MemorySummaryRow => s != null) // 库行必有 → wire 行非空（toSummaryWire 仅对 null 入参返回 null）
      .filter((s) => {
        if (!q) return true;
        return [s.title ?? "", s.content ?? ""].some((field) => field.toLowerCase().includes(q));
      });
    return { ok: true, knowledge, summaries };
  }

  /** 已接受知识再编辑（US21：claim/适用范围可再编辑、溯源不可变）。可编辑判定单源 store（arch D7），此处仅映射 wire 方言 */
  editAccepted(candidateId: string, edit: { claim?: string; scope?: string }): CandidateResult | MemoryRejectionResult {
    try {
      return { ok: true, candidate: this.store.editAccepted(candidateId, edit) };
    } catch (err) {
      return mapRejection(err);
    }
  }

  /** 需求删除级联入口（issue #35，spec #27 J 节 US22）：kanban:delete 时由 Main 调用；accepted/edited 知识保留（项目级资产） */
  deleteRequirementData(requirementId: string, projectId: string | null): void {
    this.store.deleteRequirementData(requirementId, projectId);
  }

  /** 该需求是否存在 running 批次（extract 防重复触发 / cancel 对象判定共用） */
  private hasRunningBatch(requirementId: string): boolean {
    return this.store.listBatches(requirementId).some((b) => b.status === "running");
  }

  /** 库行 → wire 总结行（补标题与正文：md 正文读取 + proposed 对比内容；文件缺失防御性返回 null） */
  private toSummaryWire(row: MemorySummaryRecord | null): MemorySummaryRow | null {
    if (!row) return null;
    return {
      requirementId: row.requirementId,
      projectId: row.projectId,
      mdPath: row.mdPath,
      proposedBatchId: row.proposedBatchId,
      proposedMdPath: row.proposedMdPath,
      updatedAt: row.updatedAt,
      title: this.deps.getRequirementTitle(row.requirementId),
      content: readTextIfExists(row.mdPath),
      proposedContent: row.proposedMdPath != null ? readTextIfExists(row.proposedMdPath) : null,
    };
  }
}

/** store 类型化业务拒绝 → wire 方言映射（arch D7：流转规则单源 memory 包，service 只做翻译，不重查规则；未预期异常原样 rethrow 走信封层既有异常路径） */
function mapRejection(err: unknown): MemoryRejectionResult {
  if (err instanceof MemoryRejectionError) return { ok: false, reason: err.reason, detail: err.message };
  throw err;
}

/** 读文本文件；不存在返回 null（启动修复前的中间态防御） */
function readTextIfExists(file: string): string | null {
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8");
}

/**
 * 打开库装配 memory 面（issue #31，spec #27 C 节）：先跑启动对账与修复四规则（running 批次→failed 等，
 * 复用 #30 reconcileMemory；崩溃窗口由此收敛、不锁死需求），再实例化 MemoryService。
 * index.ts 生产路径与测试的「重启模拟」共用本入口。
 */
export function openMemoryService(deps: MemoryServiceDeps): { service: MemoryService; report: ReconcileReport } {
  const report = reconcileMemory(deps.db, deps.dataRoot);
  return { service: new MemoryService(deps), report };
}
