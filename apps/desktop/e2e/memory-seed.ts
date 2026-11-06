// 用途：阶段 3 记忆 Playwright 预置数据种子（issue #36，沿 #22/#31 夹具模式）—— 在独立 userData 内经真实 ProjectStore/SessionStore/TrackerEngine 事件流造项目/需求/关联会话（与 kanban:ipc 落库副作用同构），经 @kanban/memory 真实 store 造批次/候选/总结（含冲突标注与 proposed 暂存），关闭库后由被测 Electron 打开同库水化；确定性时间戳保证批次/候选展示序稳定。
// 注意：不走 handleIpc（其值依赖 @kanban/cli-host，包内 import.meta 与 Playwright CJS 转译不兼容）；本文件只允许 import 无 import.meta 的纯 Node 依赖（ipc-schema/tracker/memory/db/store 层）。
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, SummaryStore, diceSimilarity } from "@kanban/memory";
import { TrackerEngine, type NormalizedEvent } from "@kanban/tracker";
import { openDatabase } from "../electron/main/db";
import { ProjectStore } from "../electron/main/project-store";
import { SessionStore } from "../electron/main/session-store";

/** 种子项目目录名（注册后即侧栏/记忆视图展示的项目名） */
export const SEED_PROJECT_NAME = "kb-s3-memory-repo";
/** 审核闭环需求（关联 1 个结构化会话：提取按钮可用、批次/候选/总结齐全） */
export const SEED_REQ_TITLE = "记忆提取演示需求";
/** 无会话需求（零 structured 关联：提取按钮禁用态走查用） */
export const SEED_REQ2_TITLE = "无会话需求";

/** 种子文案常量（断言与造数共用单一来源；claim 措辞保证冲突对 Dice ≥ 0.5，种子内前置校验） */
export const SEED = {
  // B1 已接受知识（记忆视图 + 冲突基准）
  acceptedClaim: "构建提速必须走 pnpm --filter 精确子集构建，禁止全仓安装后全量构建",
  acceptedScope: "构建",
  acceptedEvidence: "会话中实测 pnpm filter 命令有效",
  // B1 编辑后接受知识（展示「已编辑」chip 与编辑有效值）
  editedClaimOriginal: "SQLite 迁移机制需按先例演进",
  editedClaim: "SQLite v3 迁移沿用 SCHEMA_VERSION 单事务先例，新表 DDL 由 memory 包导出",
  editedScopeOriginal: "数据层",
  editedScope: "存储与迁移",
  editedEvidence: "迁移代码走读记录",
  // B2 待审三候选：冲突对（vs acceptedClaim）/ 干净可编辑 / 待忽略
  conflictPendingClaim: "构建提速要走 pnpm --filter 精确子集构建，不要全仓安装后全量构建",
  editPendingClaim: "长历史分段处理按会话边界优先，累计字符上限 6000，单事件超限硬切",
  ignorePendingClaim: "早期调研的临时结论草稿，已被后续实现推翻",
  pendingScope: "提取管线",
  pendingEvidence: "分段策略实测记录",
  // 总结三版：机器首发 → 人工修订（防覆盖基准）→ 新版（proposed 暂存待二选一）
  summaryMachine: "# 需求开发总结\n目标：打通记忆提取与审核链路。\n设计：memory 包三表 + Markdown 双写序。",
  summaryHuman: "# 需求开发总结（人工修订）\n目标：打通记忆提取与审核链路。\n设计：memory 包三表 + Markdown 双写序。\n人工补充：验收以 Playwright 全流程为准。",
  summaryNew: "# 需求开发总结（新版）\n目标：重新提取后的新版总结。\n设计：双存储 hash 防覆盖，proposed 暂存待二选一。",
  // 失败批次（红边卡 + 缺失会话警示 + 重试按钮走查）
  failedError: "claude exe 解析失败（预置演示失败批次）",
  missingPtyReason: "PTY 终端无结构化历史",
} as const;

/** 种子产物定位信息（断言剪贴板路径 / 详情面板批次徽标用） */
export interface MemorySeed {
  userData: string;
  repoDir: string;
  repoRoot: string;
  projectId: string;
  /** 审核闭环需求 id（REQ-xxx） */
  reviewRequirementId: string;
  /** 无会话需求 id */
  plainRequirementId: string;
  /** 已接受知识 CAND-0001 的 accepted md 绝对路径（复制路径断言用） */
  acceptedMdPath: string;
  /** summary.md 绝对路径（总结复制路径断言用） */
  summaryMdPath: string;
  /** 冲突候选编号（冲突提示断言用） */
  conflictDisplayNo: string;
}

/** GUI 事件工厂（同 ipc.ts guiEvent 形状：evidenceLevel=verified、同一 nowIso 时刻；种子用确定性时钟） */
function guiEvent(
  prefix: string,
  at: string,
  partial: { kind: NormalizedEvent["kind"]; source: string; requirementId: string | null } & Partial<
    Pick<NormalizedEvent, "sessionId" | "cli" | "stage" | "title" | "projectId">
  >,
): NormalizedEvent {
  return {
    eventId: `${prefix}:${at}`,
    kind: partial.kind,
    sessionId: partial.sessionId ?? null,
    cli: partial.cli ?? null,
    skill: null,
    stage: partial.stage ?? null,
    requirementId: partial.requirementId,
    title: partial.title ?? null,
    projectId: partial.projectId ?? null,
    occurredAt: at,
    receivedAt: at,
    seq: null,
    evidenceLevel: "verified",
    source: partial.source,
  };
}

/**
 * 造一套完整记忆预置数据并落盘到独立 userData（同步完成，无外部进程依赖）：
 * 项目 + 需求×2（其一关联 fake 结构化会话）+ 批次×5（B1 完成/已审、B2 完成待审、B3 完成/proposed 载体、
 * B4 失败带缺失会话、B5 取消）+ 知识（accepted CAND-0001 / edited CAND-0002）+ 待审三候选
 * （其一与 CAND-0001 Dice ≥ 0.5 冲突）+ 总结（人工版生效、新版 proposed）。
 */
export function seedMemoryFixture(): MemorySeed {
  // 冲突对前置校验：措辞漂移导致 Dice < 0.5 时种子直接失败（快速暴露，避免测试期困惑）
  const sim = diceSimilarity(SEED.conflictPendingClaim, SEED.acceptedClaim);
  if (sim < 0.5) throw new Error(`种子冲突对相似度不足 0.5（实际 ${sim.toFixed(3)}），请同步调整 SEED 文案`);

  const userData = mkdtempSync(join(tmpdir(), "kb-s3-mem-user-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "kb-s3-mem-repo-"));
  const repoDir = join(repoRoot, SEED_PROJECT_NAME);
  mkdirSync(join(repoDir, ".git"), { recursive: true });

  const db = openDatabase(join(userData, "kanban.db"));
  const projects = new ProjectStore(db);
  const engine = new TrackerEngine(db);
  engine.restore();

  // 项目 + 需求×2 + fake 结构化会话原子关联（事件溯源路径与 kanban:ipc 同构：create/link 经 engine.process 落 stage_events）
  const { duplicate, project } = projects.register(repoDir);
  if (duplicate) throw new Error("种子项目注册异常：临时目录不应重复");
  const projectId = project.id;
  let tick = 0;
  const eventAt = (): string => new Date(Date.UTC(2026, 10, 6, 8, 0, 0) + tick++ * 1000).toISOString();
  engine.process(guiEvent("seed-create-r1", eventAt(), {
    kind: "create",
    source: "gui-create",
    requirementId: "REQ-001",
    title: SEED_REQ_TITLE,
    projectId,
  }));
  engine.process(guiEvent("seed-create-r2", eventAt(), {
    kind: "create",
    source: "gui-create",
    requirementId: "REQ-002",
    title: SEED_REQ2_TITLE,
    projectId,
  }));
  const sessionId = "seed-session-0001";
  new SessionStore(db).insert({
    id: sessionId,
    kind: "structured",
    cli: "fake",
    nativeSessionId: null,
    projectId,
    title: "新会话 · Fake",
    cwd: repoDir,
    permMode: "auto",
    status: "idle",
    lastActiveAt: null,
  });
  engine.process(guiEvent(`seed-link-${sessionId}`, eventAt(), {
    kind: "link",
    source: "gui-card",
    requirementId: "REQ-001",
    sessionId,
    cli: "claude-code", // TRACKER_CLI_BY_APP[fake]，同 ipc.ts 映射
    projectId,
  }));
  // 种子侧水化自检：需求与关联就位（重放后应用侧同形）
  if (engine.tracker.req("REQ-001") == null || engine.tracker.sessionToReq.get(sessionId) !== "REQ-001") {
    throw new Error("种子事件水化自检失败（create/link 未生效）");
  }

  // 确定性时间戳：批次/候选/总结展示序由造数顺序唯一决定（同毫秒并列风险消除）
  let mtick = 0;
  const now = (): string => new Date(Date.UTC(2026, 10, 6, 9, 0, 0) + mtick++ * 1000).toISOString();
  const dataRoot = join(userData, "memory");
  const store = new MemoryStore(db, dataRoot, { now });
  const summaries = new SummaryStore(db, dataRoot, { now });
  const requirementId = "REQ-001";

  // B1（完成）：两候选即审为知识——accepted（冲突基准）+ edited（状态 chip 与有效值展示）
  store.createBatch({ id: "B-seed-1", requirementId, projectId, sourceSessionCount: 1 });
  const b1 = store.appendCandidates("B-seed-1", [
    { claim: SEED.acceptedClaim, scope: SEED.acceptedScope, evidence: SEED.acceptedEvidence, sourceSessionIds: [sessionId] },
    { claim: SEED.editedClaimOriginal, scope: SEED.editedScopeOriginal, evidence: SEED.editedEvidence, sourceSessionIds: [sessionId] },
  ]);
  store.updateBatch("B-seed-1", { chunkCount: 2, modelCallCount: 2 });
  store.finishBatch("B-seed-1", { status: "completed" });
  const accepted = store.reviewCandidate(b1[0].id, "accept"); // 返回记录含 accepted md 路径（双写序落盘）
  store.reviewCandidate(b1[1].id, "edit", { claim: SEED.editedClaim, scope: SEED.editedScope });

  // B2（完成，待审）：冲突候选由 store 对既有知识真实跑 Dice 标注；另配干净的可编辑/待忽略各一
  store.createBatch({ id: "B-seed-2", requirementId, projectId, sourceSessionCount: 1 });
  const b2 = store.appendCandidates("B-seed-2", [
    { claim: SEED.conflictPendingClaim, scope: SEED.pendingScope, evidence: SEED.pendingEvidence, sourceSessionIds: [sessionId] },
    { claim: SEED.editPendingClaim, scope: SEED.pendingScope, evidence: SEED.pendingEvidence, sourceSessionIds: [sessionId] },
    { claim: SEED.ignorePendingClaim, scope: "", evidence: SEED.pendingEvidence, sourceSessionIds: [sessionId] },
  ]);
  store.updateBatch("B-seed-2", { chunkCount: 1, modelCallCount: 1 });
  store.finishBatch("B-seed-2", { status: "completed" });
  const conflict = b2[0].conflicts.find((k) => k.displayNo === b1[0].displayNo);
  if (!conflict || conflict.similarity < 0.5) throw new Error("种子冲突标注缺失（appendCandidates 未对既有知识命中）");

  // 总结防覆盖链：B1 机器首发（写基准）→ 应用内人工修订（磁盘 ≠ 基准）→ B3 新版 → proposed 暂存不覆盖
  summaries.writeSummary({ requirementId, projectId, batchId: "B-seed-1", content: SEED.summaryMachine });
  summaries.editSummary(requirementId, SEED.summaryHuman);
  store.createBatch({ id: "B-seed-3", requirementId, projectId, sourceSessionCount: 1 });
  store.updateBatch("B-seed-3", { chunkCount: 1, modelCallCount: 1 });
  store.finishBatch("B-seed-3", { status: "completed" });
  const proposed = summaries.writeSummary({ requirementId, projectId, batchId: "B-seed-3", content: SEED.summaryNew });
  if (proposed.mode !== "proposed") throw new Error("种子 proposed 暂存未生效（writeSummary 未走防覆盖分支）");

  // B4（失败）：缺失会话警示 + 红边失败卡 + 重试按钮走查；B5（取消）：灰显走查
  store.createBatch({ id: "B-seed-4", requirementId, projectId, sourceSessionCount: 2 });
  store.updateBatch("B-seed-4", {
    missingSessions: [{ sessionId: "seed-pty-0001", cli: "pty", reason: SEED.missingPtyReason }],
    modelCallCount: 1,
  });
  store.finishBatch("B-seed-4", { status: "failed", error: SEED.failedError });
  store.createBatch({ id: "B-seed-5", requirementId, projectId, sourceSessionCount: 1 });
  store.finishBatch("B-seed-5", { status: "cancelled" });

  const summaryMdPath = summaries.getSummary(requirementId)?.mdPath ?? "";
  if (!summaryMdPath || !accepted.mdPath) throw new Error("种子 md 路径缺失");
  db.close();

  return {
    userData,
    repoDir,
    repoRoot,
    projectId,
    reviewRequirementId: requirementId,
    plainRequirementId: "REQ-002",
    acceptedMdPath: accepted.mdPath!,
    summaryMdPath,
    conflictDisplayNo: b1[0].displayNo,
  };
}
