// 用途：memory 测试共享装配 —— 独立「应用实例」（文件库 + 独立 memory dataRoot + 真实 handleIpc/handleMemoryIpc 路由与 index.ts 同款 tracker 查询注入）与预置数据/等待辅助；供 tests/memory-ipc.test.ts（fake 桥，默认跑）与 tests/e2e/memory.e2e.test.ts（真实 claude，KANBAN_E2E 门控）复用
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { type CliAdapter, FakeAdapter, VirtualClock } from "@kanban/cli-host";
import type { MemoryEventWire, TranscriptEvent } from "@kanban/ipc-schema";
import type { MemoryBatchRecord } from "@kanban/memory";
import { TrackerEngine } from "@kanban/tracker";
import { openDatabase } from "../electron/main/db";
import { handleIpc, handleMemoryIpc, type IpcDeps } from "../electron/main/ipc";
import { createLinkedSessionQueries } from "../electron/main/linked-sessions";
import { openMemoryService } from "../electron/main/memory-service";
import type { RunOnceCall, RunOnceOutcome } from "../electron/main/memory-pipeline";
import { ProjectStore } from "../electron/main/project-store";
import { createAdapterSessionProcesses, createSessionLifecycle } from "../electron/main/session-lifecycle";
import { SessionStore } from "../electron/main/session-store";
import type { PtyHost } from "../electron/main/pty-host";

export let tmpRoot = "";

/** Windows 下 SQLite 句柄释放有延迟：清理带短重试（失败可见）；各测试文件以 afterEach 挂接 */
export async function cleanupTmpRoot(): Promise<void> {
  if (!tmpRoot) return;
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = "";
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  rmSync(tmpRoot, { recursive: true, force: true }); // 仍失败则抛出（不静默吞）
  tmpRoot = "";
}

/** 路由级 fake PTY 宿主（测试不触 PTY 通道，仅满足 IpcDeps 形状；模式同 ipc.test.ts） */
function makeFakePtyHost(): PtyHost {
  const running = new Set<string>();
  return {
    spawn: (terminalId) => {
      running.add(terminalId);
      return { ok: true, label: "pwsh", shell: "pwsh.exe", cwd: tmpRoot };
    },
    write: (terminalId) => (running.has(terminalId) ? { ok: true } : { ok: false, message: "终端未运行" }),
    resize: () => undefined,
    kill: (terminalId) => running.delete(terminalId),
    isRunning: (terminalId) => running.has(terminalId),
    killAll: () => running.clear(),
  };
}

/** 一台「应用实例」：文件库 + 独立 memory dataRoot + 真实 handleIpc/handleMemoryIpc 路由与 index.ts 同款 tracker 查询注入 */
export function makeApp() {
  tmpRoot = mkdtempSync(join(tmpdir(), "kb-memory-e2e-"));
  const dbPath = join(tmpRoot, "kanban.db");
  const dataRoot = join(tmpRoot, "memory");
  const projectDir = join(tmpRoot, "proj");
  mkdirSync(projectDir);
  return assemble(dbPath, dataRoot, projectDir);
}

/** （重）装配：打开库 → 各 store/engine → memory 面（与 index.ts 生产装配同入口 openMemoryService 与同款 tracker 查询闭包 + 提取双桥 seam 注入，#32） */
export function assemble(dbPath: string, dataRoot: string, projectDir: string, over?: {
  /** memory:event 捕获目标数组 */
  events?: MemoryEventWire[];
  /** readTranscript 桥覆盖（缺省：每个会话返回一段固定双视角历史） */
  readTranscript?: (sessionId: string) => Promise<TranscriptEvent[]>;
  /** runOnce 桥覆盖（缺省：记录调用并返回单段合法 JSON 输出） */
  runOnce?: (input: RunOnceCall) => Promise<RunOnceOutcome>;
  /** cancelRunOnce 桥覆盖 */
  cancelRunOnce?: (runId: string) => Promise<void>;
}) {
  const db = openDatabase(dbPath);
  const adapter: CliAdapter = new FakeAdapter({ clock: new VirtualClock() });
  const engine = new TrackerEngine(db);
  engine.restore();
  const sessions = new SessionStore(db);
  const projects = new ProjectStore(db);
  // 与 index.ts 生产装配一致的 tracker 查询（arch C10 起共用 linked-sessions.ts 同一实现，memory 不依赖 tracker，由 Main 查询后传入）
  const linkedSessions = createLinkedSessionQueries({ tracker: engine.tracker, sessions });
  // fake 提取双桥（runOnce seam 注入点：无真实 CLI，缺省行为可覆盖；调用记录统一在装配层，覆盖亦可见）
  const runCalls: RunOnceCall[] = [];
  const cancelRunOnceCalls: string[] = [];
  const defaultReadTranscript = async (): Promise<TranscriptEvent[]> => [
    { role: "user", text: "e2e 历史：用户提出构建提速诉求" },
    { role: "assistant", text: "e2e 历史：完成了构建脚本改造" },
  ];
  const defaultRunOnce = async (): Promise<RunOnceOutcome> => ({
    status: "completed",
    exitCode: 0,
    stdout: JSON.stringify({
      summary: "e2e 段小结：完成构建脚本改造并验证。",
      candidates: [{ claim: "e2e 候选：构建必须走 pnpm filter", evidence: "e2e 历史实证", scope: "构建", sourceSessionIds: [] }],
    }),
    stderr: "",
    durationMs: 5,
  });
  const { service } = openMemoryService({
    db,
    dataRoot,
    listLinkedStructuredSessions: linkedSessions.listLinkedStructuredSessions,
    listLinkedPtySessions: linkedSessions.listLinkedPtySessions,
    getRequirementProjectId: (requirementId) => engine.tracker.req(requirementId)?.projectId ?? null,
    getRequirementTitle: (requirementId) => engine.tracker.req(requirementId)?.title ?? null,
    requirementExists: (requirementId) => engine.tracker.req(requirementId) != null,
    readTranscriptBridge: over?.readTranscript ?? defaultReadTranscript,
    runOnceBridge: async (input) => {
      runCalls.push(input);
      return (over?.runOnce ?? defaultRunOnce)(input);
    },
    cancelRunOnceBridge:
      over?.cancelRunOnce ??
      (async (runId) => {
        cancelRunOnceCalls.push(runId);
      }),
    emitMemoryEvent: (event) => over?.events?.push(event),
  });
  const ptyHost = makeFakePtyHost();
  const deps: IpcDeps = {
    adapter,
    engine,
    projects,
    sessions,
    // #35：与 index.ts 生产装配一致注入 memory（kanban:delete 需求删除级联）
    memory: service,
    // #70 C2：归档/删除编排唯一写者（与生产装配同构）
    lifecycle: createSessionLifecycle({ sessions, procs: createAdapterSessionProcesses(adapter, ptyHost) }),
    pty: ptyHost,
    pickDirectory: async () => projectDir,
    getCurrentProjectId: () => null,
    setCurrentProjectId: () => undefined,
  };
  return {
    db,
    dbPath,
    dataRoot,
    projectDir,
    service,
    runCalls,
    cancelRunOnceCalls,
    handleKanban: (raw: unknown) => handleIpc(deps, raw),
    handleMemory: (raw: unknown) => handleMemoryIpc({ memory: service }, raw),
  };
}

/** 等待批次离开 running（管线异步落定；真实模型跑用大 timeoutMs） */
export async function waitBatchTerminal(app: ReturnType<typeof assemble>, batchId: string, timeoutMs = 2000): Promise<MemoryBatchRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const b = app.service.store.getBatch(batchId);
    if (b && b.status !== "running") return b;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`批次 ${batchId} 未在时限内落定`);
}

/** 等待条件成立（轮询） */
export async function waitUntilE2E(fn: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("条件未在时限内成立");
}

/** 预置一份「S3-05 提取完成」形态的产物：completed 批次 + 三条 pending 候选 + 总结 */
export async function seedRequirement(app: ReturnType<typeof makeApp>) {
  // 真实 kanban:ipc 通道：注册项目 → 建需求 → 建 fake 会话并原子关联（spec #15 C 节）
  const reg = await app.handleKanban({ channel: "project:register" });
  expect(reg.ok).toBe(true);
  const projectId = reg.ok && reg.project ? reg.project.id : "";
  const created = await app.handleKanban({ channel: "kanban:create", projectId, title: "记忆提取需求" });
  const requirementId = created.ok ? created.requirementId! : "";
  expect(requirementId).toBeTruthy();
  const session = await app.handleKanban({
    channel: "session:create",
    cli: "fake",
    cwd: app.projectDir,
    projectId,
    requirementId,
  });
  expect(session.ok).toBe(true);
  // 关联成功（真实 kanban:ipc 原子关联路径）→ extract 不再 no-sessions（落到占位拒绝）
  const linked = session.ok ? session.linked : undefined;
  expect(linked).toBe(true);

  // 预置提取产物（模拟 S3-05 管线落库形态）
  app.service.store.createBatch({ id: "B1", requirementId, projectId, sourceSessionCount: 1 });
  const candidates = app.service.store.appendCandidates("B1", [
    { claim: "e2e 验证的结论甲", scope: "集成测试", evidence: "批次 B1", sourceSessionIds: ["s-e2e-1"] },
    { claim: "e2e 验证的结论乙", scope: "检索", evidence: "批次 B1", sourceSessionIds: ["s-e2e-1"] },
    { claim: "e2e 待忽略的结论", scope: "", evidence: "批次 B1", sourceSessionIds: ["s-e2e-1"] },
  ]);
  app.service.store.finishBatch("B1", { status: "completed" });
  app.service.summaries.writeSummary({
    requirementId,
    projectId,
    batchId: "B1",
    content: "# 需求开发总结（e2e）\n目标：验证 memory IPC 全链路。",
  });
  return { projectId, requirementId, candidates };
}

/** 预置「仅有活需求」形态：项目 + 需求 + 一个关联 fake 会话（无历史批次/候选/总结——提取/取消/删除竞态用例的干净基线） */
export async function seedLiveRequirement(app: ReturnType<typeof makeApp>) {
  const reg = await app.handleKanban({ channel: "project:register" });
  expect(reg.ok).toBe(true);
  const projectId = reg.ok && reg.project ? reg.project.id : "";
  const created = await app.handleKanban({ channel: "kanban:create", projectId, title: "提取管线需求" });
  const requirementId = created.ok ? created.requirementId! : "";
  expect(requirementId).toBeTruthy();
  const session = await app.handleKanban({ channel: "session:create", cli: "fake", cwd: app.projectDir, projectId, requirementId });
  expect(session.ok ? session.linked : undefined).toBe(true);
  return { projectId, requirementId };
}
