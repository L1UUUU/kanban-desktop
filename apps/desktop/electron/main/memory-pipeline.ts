// 用途：手动提取全管线编排（issue #32，spec #27 F/C 节）—— 批次生命周期内编排：readTranscript 桥逐会话读取（PTY/失败列 missingSessions）→ chunkEvents 分段 → 逐段 claude headless（经 runOnce 桥：全新 session id + 应用数据目录临时 cwd + 300s 超时 + zod 校验失败重试一次 + 来源 clamp 段内）→ 段小结合并总结 + 候选跨段去重 → #30 store 双写落库 → memory:event 四步进度推送；本模块不 spawn 进程（进程治理全归 #29 runOnce 桥）
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  memorySegmentOutputSchema,
  type MemoryEventWire,
  type MemorySegmentOutput,
  type TranscriptEvent,
} from "@kanban/ipc-schema";
import {
  chunkEvents,
  mergeCandidates,
  type EventChunk,
  type ExtractedCandidate,
  type MemoryEvent,
  type MemoryStore,
  type MissingSession,
  type SummaryStore,
} from "@kanban/memory";

/** 单段提取超时（spec F：默认 300s，超时归批次 failed） */
export const SEGMENT_TIMEOUT_MS = 300_000;

/** runOnce 桥调用形状（与 #29 RunOnceInput 同形；本模块结构性声明，不依赖 cli-host） */
export interface RunOnceCall {
  runId: string;
  cli: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs?: number;
}

/** runOnce 桥结果形状（与 #29 RunOnceResult 同形） */
export interface RunOnceOutcome {
  status: "completed" | "failed" | "timeout" | "cancelled";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** 提取双桥 seam（可测注入：Main 侧由 cli-host-client 代理提供，测试注入 fake） */
export interface ExtractionBridges {
  /** 双视角历史读取（#28 readTranscript 经 Main 桥） */
  readTranscript(appSessionId: string): Promise<TranscriptEvent[]>;
  /** 一次性 CLI 执行（#29 runOnce 经 Main 桥；claude exe 解析与认证 env 由其保证） */
  runOnce(input: RunOnceCall): Promise<RunOnceOutcome>;
  /** 取消进行中的一次性执行（缺省无操作——真实装配必接） */
  cancelRunOnce?(runId: string): Promise<void> | void;
}

/** 批次取消控制柄：cancel/stop 置 aborted，管线在每个阶段边界检查；currentRunId 为当前段临时执行锚点 */
export interface ExtractionControl {
  aborted: boolean;
  currentRunId: string | null;
}

/** 管线输入（MemoryService 组装：批次行已建，projectId/标题/关联会话由 Main 查询注入） */
export interface PipelineRunInput {
  batchId: string;
  requirementId: string;
  projectId: string;
  requirementTitle: string | null;
  /** 当前关联 structured 会话（US2：解除关联不纳入） */
  sessions: Array<{ sessionId: string; cli: string }>;
  /** 当前关联 PTY 会话（无结构化历史，US3 列入缺失声明） */
  ptySessions: Array<{ sessionId: string }>;
}

/** 用户取消（批次收敛 cancelled；区别于失败） */
class ExtractionCancelledError extends Error {
  constructor() {
    super("提取已取消");
  }
}

/** 批次失败（附直达用户的原因） */
class ExtractionFailedError extends Error {}

/** 提取中需求被删除（#35 删除级联边界）：整批丢弃不写库——语义归 cancelled（用户删除动作终止了提取，非故障） */
class RequirementDeletedError extends Error {
  constructor() {
    super("需求已删除，提取终止（整批丢弃）");
  }
}

/** aborted 检查点（阶段边界与段间共用；取消语义优先于一切失败） */
function throwIfAborted(control: ExtractionControl): void {
  if (control.aborted) throw new ExtractionCancelledError();
}

/**
 * 执行一个批次的全管线。本函数不抛错（全部收敛为批次终态 + memory:event 推送）；
 * 同批次重复收尾（stop 兜底先行落定）由 finishBatchIfRunning 保护，先落定者生效。
 */
export async function runExtractionPipeline(
  deps: {
    store: MemoryStore;
    summaries: SummaryStore;
    bridges: ExtractionBridges;
    control: ExtractionControl;
    dataRoot: string;
    emit(event: MemoryEventWire): void;
    /** 需求存在性查询（tracker 口径；终局写库前守卫删除竞态，缺省恒存在供测试） */
    requirementExists?(requirementId: string): boolean;
  },
  input: PipelineRunInput,
): Promise<void> {
  const { store, summaries, bridges, control, emit } = deps;
  const { batchId, requirementId, projectId } = input;
  // 三层隔离之一：cwd = <dataRoot>/<projectId>/extract-tmp/<batchId>（应用数据目录，不进项目仓库）
  const extractCwd = join(deps.dataRoot, projectId, "extract-tmp", batchId);
  // 阶段边界存活检查：用户取消优先；提取中需求被删除（#35 删除级联已清数据）→ 整批丢弃不写库，防孤儿复活
  const checkAlive = (): void => {
    throwIfAborted(control);
    if (deps.requirementExists && !deps.requirementExists(requirementId)) throw new RequirementDeletedError();
  };

  try {
    emit({ type: "batch-status", batchId, requirementId, status: "running" });

    // ---- 阶段 1：读取历史（逐会话桥读；PTY/失败 → missingSessions 带原因，不冒充完整） ----
    emit({ type: "chunk-progress", batchId, requirementId, step: "reading", chunkIndex: 0, chunkCount: 0 });
    checkAlive();
    const missing: MissingSession[] = input.ptySessions.map((s) => ({
      sessionId: s.sessionId,
      cli: "pty",
      reason: "PTY 终端会话无结构化原生历史，不在提取范围",
    }));
    const events: MemoryEvent[] = [];
    const readableCounts: Array<{ sessionId: string; cli: string; eventCount: number }> = [];
    for (const s of input.sessions) {
      try {
        const transcript = await bridges.readTranscript(s.sessionId);
        for (const e of transcript) {
          events.push({ cli: s.cli, sessionId: s.sessionId, role: e.role, text: e.text, tool: e.tool ?? undefined });
        }
        readableCounts.push({ sessionId: s.sessionId, cli: s.cli, eventCount: transcript.length });
      } catch (e) {
        missing.push({ sessionId: s.sessionId, cli: s.cli, reason: e instanceof Error ? e.message : String(e) });
      }
    }

    // ---- 阶段 2：分段（#30 chunkEvents：会话边界优先 + maxChars 6000 + 单事件硬切） ----
    checkAlive();
    const chunks = chunkEvents(events);
    store.updateBatch(batchId, { missingSessions: missing, chunkCount: chunks.length });
    emit({ type: "chunk-progress", batchId, requirementId, step: "chunking", chunkIndex: 0, chunkCount: 0 });

    // ---- 阶段 3：逐段提取（每段独立临时 claude headless；三层隔离另两层：全新 session id、开发会话只读） ----
    mkdirSync(extractCwd, { recursive: true });
    const segSummaries: Array<{ index: number; sessions: string[]; summary: string }> = [];
    const allCandidates: ExtractedCandidate[] = [];
    let modelCalls = 0;
    // 模型调用计数（含重试）逐次持久化——段失败/批次失败时元信息也如实（US12）
    const countModelCall = (): void => {
      modelCalls += 1;
      try {
        store.updateBatch(batchId, { modelCallCount: modelCalls });
      } catch {
        // 批次行已被删除级联清掉（#35：提取中需求被删除）→ 归入整批丢弃
        throw new RequirementDeletedError();
      }
    };
    for (const chunk of chunks) {
      checkAlive();
      emit({ type: "chunk-progress", batchId, requirementId, step: "extracting", chunkIndex: chunk.index, chunkCount: chunks.length });
      const seg = await extractSegment(bridges, control, {
        chunk,
        total: chunks.length,
        requirementId,
        requirementTitle: input.requirementTitle,
        batchId,
        cwd: extractCwd,
        onModelCall: countModelCall,
      });
      segSummaries.push({ index: chunk.index, sessions: chunk.sessions.map((s) => s.id), summary: seg.summary });
      allCandidates.push(...seg.candidates);
    }

    // ---- 阶段 4：合并写库（段小结→总结正文；候选跨段 0.75 去重；双写序与防覆盖走 #30 store） ----
    // 删除竞态守卫（#35 边界）并入 checkAlive：提取进行中需求被删除（级联已清批次/候选/总结行与需求目录）→
    // 整批丢弃、绝不写库，防止为已删需求复活孤儿数据；检查点后到写库间的极窄窗口由 #35 幂等级联兜底
    checkAlive();
    emit({ type: "chunk-progress", batchId, requirementId, step: "merging", chunkIndex: 0, chunkCount: 0 });
    const merged = mergeCandidates(allCandidates);
    const content = renderSummaryMd({
      requirementId,
      requirementTitle: input.requirementTitle,
      batchId,
      sourceSessionCount: input.sessions.length,
      readableCounts,
      missing,
      chunkCount: chunks.length,
      modelCallCount: modelCalls,
      segSummaries,
    });
    // 写序沿用 poc-5：总结先行（防覆盖由 SummaryStore 内 hash 基准判定）→ 候选单事务落库（含冲突检测标注）
    summaries.writeSummary({ requirementId, projectId, batchId, content });
    store.appendCandidates(batchId, merged);

    finishBatchIfRunning(store, batchId, { status: "completed" });
    emit({ type: "batch-status", batchId, requirementId, status: "completed" });
  } catch (err) {
    // 取消语义优先：abort 已标记时一切失败都归取消（worker 随停机退出导致的桥拒绝等）
    const error = err instanceof Error ? err.message : String(err);
    if (err instanceof RequirementDeletedError) {
      // 批次行多已被 #35 级联删除（finishIfRunning no-op）；事件仍推送——持有批次号的监听方需要终态
      finishBatchIfRunning(store, batchId, { status: "cancelled", error });
      emit({ type: "batch-status", batchId, requirementId, status: "cancelled", error });
    } else if (control.aborted || err instanceof ExtractionCancelledError) {
      if (finishBatchIfRunning(store, batchId, { status: "cancelled" })) {
        emit({ type: "batch-status", batchId, requirementId, status: "cancelled" });
      }
    } else {
      if (finishBatchIfRunning(store, batchId, { status: "failed", error })) {
        emit({ type: "batch-status", batchId, requirementId, status: "failed", error });
      }
    }
  }
}

/** 单段提取：claude headless（prompt 经 stdin、全新 session id、段超时），输出 JSON 抠取 + zod 校验失败重试一次 */
async function extractSegment(
  bridges: ExtractionBridges,
  control: ExtractionControl,
  ctx: {
    chunk: EventChunk;
    total: number;
    requirementId: string;
    requirementTitle: string | null;
    batchId: string;
    cwd: string;
    /** 每次真实发起的模型调用后回调（含重试；桥抛错不计——调用未成立） */
    onModelCall(): void;
  },
): Promise<{ attempts: number; summary: string; candidates: ExtractedCandidate[] }> {
  const segLabel = `段 ${ctx.chunk.index + 1}`;
  const segSessionIds = ctx.chunk.sessions.map((s) => s.id);
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    throwIfAborted(control);
    const runId = `${ctx.batchId}-seg${ctx.chunk.index}-a${attempt}`;
    control.currentRunId = runId;
    let outcome: RunOnceOutcome;
    try {
      outcome = await bridges.runOnce({
        runId,
        cli: "claude",
        // 三层隔离之二：每段（每次尝试）全新 session id（poc-5 实证形态）
        args: ["-p", "--session-id", randomUUID()],
        cwd: ctx.cwd,
        stdin: buildSegmentPrompt({
          chunk: ctx.chunk,
          total: ctx.total,
          requirementId: ctx.requirementId,
          requirementTitle: ctx.requirementTitle,
          retryError: attempt > 1 ? lastError : null,
        }),
        timeoutMs: SEGMENT_TIMEOUT_MS,
      });
    } catch (e) {
      // 桥抛错 = CLI 不可用（exe 解析失败 / worker 已退出）：不重试，整批 failed（US10）
      if (control.aborted) throw new ExtractionCancelledError();
      throw new ExtractionFailedError(`CLI 不可用：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      control.currentRunId = null;
    }
    ctx.onModelCall(); // 进程已真实发起（completed/failed/timeout 都算模型调用成立）
    if (outcome.status === "cancelled") throw new ExtractionCancelledError();
    if (outcome.status === "timeout") throw new ExtractionFailedError(`${segLabel} 提取超时（${SEGMENT_TIMEOUT_MS / 1000}s），批次失败`);
    if (outcome.status === "failed") {
      throw new ExtractionFailedError(`${segLabel} 提取进程退出码 ${outcome.exitCode ?? "unknown"}：${firstLines(outcome.stderr, 200)}`);
    }
    try {
      const parsed = parseSegmentOutput(outcome.stdout);
      return { attempts: attempt, ...clampSegment(parsed, segSessionIds) };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      // zod 校验失败 → 重试一次（US7：调用次数计数；仍失败落到循环外抛出）
    }
  }
  throw new ExtractionFailedError(`${segLabel} 提取输出校验重试仍失败：${lastError}`);
}

/** 段 prompt（演进自 poc-5 segmentPrompt）：注入需求上下文与段历史；固定术语 + 串内禁英文双引号 + 只输出 JSON */
function buildSegmentPrompt(input: {
  chunk: EventChunk;
  total: number;
  requirementId: string;
  requirementTitle: string | null;
  retryError: string | null;
}): string {
  const title = input.requirementTitle ?? input.requirementId;
  const src = input.chunk.sessions.map((s) => `${s.id}（${s.cli}）`).join("、");
  const lines = [
    `你是「需求经验提取器」。以下是需求《${title}》（${input.requirementId}）开发历史的第 ${input.chunk.index + 1}/${input.total} 段。`,
    `本段来源 Session：${src}。历史事件每行开头带 [cli/session 角色] 标签。`,
    "",
    "----- 历史开始 -----",
    input.chunk.text,
    "----- 历史结束 -----",
    "",
    "不要使用任何工具，只基于以上历史输出 JSON，不要输出 JSON 以外的任何内容：",
    "{",
    '  "summary": "本段开发小结：目标、做了什么、关键决策与取舍、错误与修复、验证方式（3-5 句）",',
    '  "candidates": [',
    '    {"claim": "一条可复用的项目级规则/边界/经验（一句话）", "evidence": "历史中的依据（引用关键行为或原句）", "scope": "适用范围（如某文件 / 某模块 / 项目级）", "sourceSessionIds": ["本段来源 session id"]}',
    "  ]",
    "}",
    "缺失的信息不要编造；只提取这段历史真正支撑的内容；没有可提取的候选时 candidates 给空数组。",
    "术语约束：候选 claim 与 evidence 必须复用历史中已出现的固定术语（文件名、组件名、命令名、接口名等），不要改写或发明新的说法。",
    '格式硬约束：输出必须是单个合法 JSON 对象；所有字符串值内部禁止出现英文双引号（需要引用时用中文引号『』或单引号）；不要输出注释、代码围栏或 JSON 以外的任何文字。',
  ];
  if (input.retryError) lines.push(`上一次输出未通过校验（${input.retryError}），请严格修正后重新输出。`);
  return lines.join("\n");
}

/** 从模型回复抠取 JSON 并过 zod 校验（容忍围栏与前后说明文字；演进自 poc-5 extractJsonObject） */
function parseSegmentOutput(stdout: string): MemorySegmentOutput {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("回复中未找到 JSON 对象");
  let json: unknown;
  try {
    json = JSON.parse(stdout.slice(start, end + 1));
  } catch (e) {
    throw new Error(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = memorySegmentOutputSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`schema 校验失败：${issues}`);
  }
  return parsed.data;
}

/** 段结果规范化（演进自 poc-5 clampExtraction）：空 claim 丢弃；来源强制 clamp 到段内会话（无有效来源回填段内全部） */
function clampSegment(parsed: MemorySegmentOutput, segSessionIds: string[]): { summary: string; candidates: ExtractedCandidate[] } {
  const candidates = parsed.candidates
    .filter((c) => c.claim.trim().length > 0)
    .map((c) => {
      const valid = [...new Set(c.sourceSessionIds.filter((s) => segSessionIds.includes(s)))];
      return {
        claim: c.claim.trim(),
        evidence: c.evidence.trim(),
        scope: c.scope.trim(),
        sourceSessionIds: valid.length > 0 ? valid : [...segSessionIds],
      };
    });
  return { summary: parsed.summary.trim(), candidates };
}

/** 总结 Markdown（演进自 poc-5 summaryLines）：元信息如实 + 来源声明 + 缺失声明 + 分段小结合并 */
function renderSummaryMd(input: {
  requirementId: string;
  requirementTitle: string | null;
  batchId: string;
  sourceSessionCount: number;
  readableCounts: Array<{ sessionId: string; cli: string; eventCount: number }>;
  missing: MissingSession[];
  chunkCount: number;
  modelCallCount: number;
  segSummaries: Array<{ index: number; sessions: string[]; summary: string }>;
}): string {
  const title = input.requirementTitle ?? input.requirementId;
  const lines: string[] = [
    `# ${title} 需求开发总结（批次 ${input.batchId}）`,
    "",
    `- 需求：${input.requirementId}`,
    `- 生成方式：手动提取（Kanban Desktop，用户触发）`,
    `- 提取元信息：来源会话 ${input.sourceSessionCount} 个（缺失 ${input.missing.length} 个）/ 分段 ${input.chunkCount} 段 / 模型调用 ${input.modelCallCount} 次（含重试）`,
    "",
    "## 来源 Session",
    ...input.readableCounts.map((r) => `- ${r.sessionId}（${r.cli}）— 可读，事件 ${r.eventCount} 条`),
    ...input.missing.map((m) => `- ${m.sessionId}（${m.cli}）— ❌ 历史不可读：${m.reason}`),
    "",
  ];
  if (input.missing.length > 0) {
    lines.push(
      "## 缺失历史提示",
      "",
      `本次提取未包含以下 ${input.missing.length} 个 Session 的历史，总结不覆盖其内容：`,
      ...input.missing.map((m) => `- ${m.sessionId}（${m.cli}）：${m.reason}`),
      "",
    );
  }
  lines.push("## 分段开发小结");
  for (const s of input.segSummaries) {
    lines.push("", `### 段 ${s.index + 1}（来源：${s.sessions.join("、")}）`, "", s.summary || "（本段无小结）");
  }
  lines.push("");
  return lines.join("\n");
}

/** 批次收尾保护：仅 running 可落终态（先落定者生效；stop 兜底与管线自然收尾竞争时防改写）；返回是否实际写入 */
export function finishBatchIfRunning(
  store: MemoryStore,
  batchId: string,
  result: { status: "completed" | "failed" | "cancelled"; error?: string },
): boolean {
  const cur = store.getBatch(batchId);
  if (!cur || cur.status !== "running") return false;
  store.finishBatch(batchId, result);
  return true;
}

/** stderr 首段摘要（失败原因直达用户，避免整屏噪音） */
function firstLines(text: string, maxChars: number): string {
  const t = text.trim();
  return t.length > maxChars ? `${t.slice(0, maxChars)}…` : t || "（无 stderr 输出）";
}
