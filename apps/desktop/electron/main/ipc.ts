// 用途：Main 入站 IPC 处理器聚合 —— kanban:ipc（信封经共享工厂 + 27 子通道编译期穷尽查表，handler 按 feature 落 main/ipc/*.ts）与 memory/residue/diff/config/cli:status 五个独立单通道路由（27 子通道）（纯函数无 Electron 依赖：dialog 与 config 经 deps 注入）；#72 C1 Step2 自 775 行 route switch 巨石拆分
import {
  IPC_CHANNELS,
  type AutoArchiveScanSummary,
  type CliInstalledMap,
  type CliStatusRequest,
  type CliStatusResult,
  type ConfigRequest,
  type ConfigResult,
  type DiffRequest,
  type DiffResult,
  type IpcRequest,
  type IpcResult,
  type MemoryRequest,
  type MemoryResult,
  type ModelsRequest,
  type ModelsResult,
  type ResidueProcess,
  type ResidueRequest,
  type ResidueResult,
  type ResidueKillResult,
} from "@kanban/ipc-schema";
import type { CliAdapter } from "@kanban/cli-host";
import { TrackerEngine, type TrackerChange } from "@kanban/tracker";
import type { AppConfig, LiveConfig } from "./config";
import type { WorkspaceDiff } from "./git-diff-service";
import { CommandCatalog } from "./command-catalog";
import { createChannelHandler, codeEnvelope, reasonEnvelope, type EnvelopeDeps } from "./ipc-envelope";
import { type MemoryService } from "./memory-service";
import type { PtyHost } from "./pty-host";
import type { ProjectStore } from "./project-store";
import type { SessionLifecycle } from "./session-lifecycle";
import type { SessionStore } from "./session-store";
import { allKanbanHandlers, routeByTable } from "./ipc/table";

// kanban:ipc 子通道查表总表（arch C10 起 TRACKER_CLI_BY_APP 的消费方经 "./ipc/helpers" 直连，此处不再 re-export）

/** 路由依赖：adapter + PTY 宿主 + 持久化 store + 平台能力（Electron dialog/config 由 index.ts 注入，测试可替换）；isShuttingDown?/log? 经 EnvelopeDeps 注入 */
export interface IpcDeps extends EnvelopeDeps {
  adapter: CliAdapter;
  /** PTY 终端宿主（terminal:* 通道；mock 注入可单测） */
  pty: PtyHost;
  projects: ProjectStore;
  sessions: SessionStore;
  /** #70 C2：会话生命周期唯一编排写者（archive/unarchive/remove 编排主体；adapter/pty 经其 SessionProcesses seam 分派） */
  lifecycle: SessionLifecycle;
  /** #17：kanban:* 通道与 session:create+requirementId 全量经 engine 落事件流（事件溯源唯一状态变化路径，spec #15 C 节） */
  engine: TrackerEngine;
  /** #17：tracker 变更推送（index.ts 接 webContents.send("tracker:event")；可选，缺省丢弃供不需要推送的测试） */
  emitTrackerChange?(change: TrackerChange): void;
  /** 原生目录选择（用户取消返回 null） */
  pickDirectory(): Promise<string | null>;
  getCurrentProjectId(): string | null;
  setCurrentProjectId(id: string): void;
  /** #21（spec #15 E 节）：用户级 Claude 基准目录解析（CLAUDE_CONFIG_DIR 优先，否则 ~/.claude）；仅 session:create cli=claude 的同名 skill 检测用。缺省读 process.env + os.homedir，测试注入固定目录 */
  resolveUserClaudeDir?(): string;
  /** #89（spec #82 E 块）：斜杠命令目录（短 TTL 缓存；缺省由 composer handler 按 adapter 惰性构建——生产单 adapter 生命周期内共享；测试注入显式实例控时钟/计扫描次数） */
  commandCatalog?: CommandCatalog;
  /** #92（spec #82 E 块）：用户级 codex 基准目录（composer:expandCommand 安全边界 <home>/.codex/prompts 的 home 解析，与 codex prompts 扫描口径一致）；缺省 os.homedir()，测试注入 fixture */
  codexHomeDir?: string;
  /** #35（spec #27 J 节）：memory 面（kanban:delete 需求删除级联清理）；index.ts 经 openMemoryService 装配注入，缺省无 memory 数据可清理（旧测试/降级装配） */
  memory?: MemoryService;
}

/** 处理一条入站请求：信封（校验/门闸/错误形状化）经共享工厂，主体查 27 子通道路由表分发（spec E：Main 强制校验，非法消息明确错误码；spec H：退出中拒新请求）；
 *  通道名与请求契约引自 IPC_CHANNELS 单源（#72 Step4） */
export async function handleIpc(deps: IpcDeps, raw: unknown): Promise<IpcResult> {
  return createChannelHandler<IpcRequest, IpcResult, IpcDeps>(
    { scope: IPC_CHANNELS.kanban.name, schema: IPC_CHANNELS.kanban.request, dialect: codeEnvelope, catchStyle: { kind: "adapter-passthrough", toError: codeEnvelope.toError } },
    deps,
    (req, d) => routeByTable(allKanbanHandlers, d, req),
  )(raw);
}

// ============ #31 memory:ipc 通道（spec #27 H 节，对齐 kanban:ipc 模式：单通道 + Main 入站 zod 强制校验 + 业务拒绝 ok:false+reason） ============

/** memory:ipc 路由依赖（MemoryService 由 index.ts 经 openMemoryService 装配注入）；isShuttingDown?/log? 经 EnvelopeDeps 注入 */
export interface MemoryIpcDeps extends EnvelopeDeps {
  memory: MemoryService;
}

/** 处理一条 memory:ipc 入站请求：信封经共享工厂（reason 方言 + rethrow），八通道路由（业务拒绝直达调用方，不新增全局错误码） */
export async function handleMemoryIpc(deps: MemoryIpcDeps, raw: unknown): Promise<MemoryResult> {
  return createChannelHandler<MemoryRequest, MemoryResult, MemoryIpcDeps>(
    { scope: IPC_CHANNELS.memory.name, schema: IPC_CHANNELS.memory.request, dialect: reasonEnvelope, catchStyle: { kind: "rethrow" } },
    deps,
    routeMemory,
  )(raw);
}

/** memory 八通道路由主体 */
async function routeMemory(req: MemoryRequest, deps: MemoryIpcDeps): Promise<MemoryResult> {
  switch (req.channel) {
    case "memory:extract": {
      const r = deps.memory.extract(req.requirementId);
      return r.ok ? { ok: true, started: true, batchId: r.batchId } : r;
    }
    case "memory:cancel": {
      // #32：取消管线已接线（异步等待整批落定）
      const r = await deps.memory.cancel(req.requirementId);
      return r.ok ? { ok: true, cancelled: true } : r;
    }
    case "memory:reviewCandidate": {
      const r = deps.memory.reviewCandidate(req.candidateId, req.action, req.edit);
      return r.ok ? { ok: true, candidate: r.candidate } : r;
    }
    case "memory:resolveSummary": {
      return await deps.memory.resolveSummary(req.requirementId, req.choice);
    }
    case "memory:requirementMemory": {
      return await deps.memory.requirementMemory(req.requirementId);
    }
    case "memory:projectMemory": {
      return await deps.memory.projectMemory(req.projectId, req.query);
    }
    case "memory:editAccepted": {
      const r = deps.memory.editAccepted(req.candidateId, { claim: req.claim, scope: req.scope });
      return r.ok ? { ok: true, candidate: r.candidate } : r;
    }
    case "memory:editSummary": {
      return await deps.memory.editSummary(req.requirementId, req.content);
    }
  }
}

// ============ #49 residue:ipc 通道（spec #40 D 节，对齐 memory:ipc 模式：单通道 + Main 入站 zod 强制校验 + 业务拒绝 ok:false+reason） ============

/** residue:ipc 路由依赖（检测与终止由 index.ts 装配注入：检测为本次启动缓存的一次性结果，不重复探测）；isShuttingDown?/log? 经 EnvelopeDeps 注入 */
export interface ResidueIpcDeps extends EnvelopeDeps {
  /** 残留检测（返回缓存清单；spec：每次启动只检测一次，不轮询） */
  detect(): Promise<ResidueProcess[]>;
  /** 确认式逐 pid 终止（用户显式触发；无自动清理路径） */
  kill(pids: number[]): Promise<ResidueKillResult[]>;
}

// ============ #43 diff:ipc 通道（spec #40 D 节，对齐 memory:ipc 独立单通道先例：入站 zod 强制校验 + 退出门闸 + 经 project store 解析 cwd） ============

/** diff:ipc 路由依赖：project store（projectId → canonicalPath）+ git-diff-service 单函数（测试注入 fixture）；isShuttingDown?/log? 经 EnvelopeDeps 注入 */
export interface DiffIpcDeps extends EnvelopeDeps {
  projects: ProjectStore;
  /** 读取工作区未提交变更（生产 = git-diff-service readWorkspaceDiff 装配） */
  readWorkspaceDiff(cwd: string): Promise<WorkspaceDiff>;
}

/** 处理一条 residue:ipc 入站请求：信封经共享工厂（reason 方言 + rethrow），二通道路由（业务拒绝直达调用方，不新增全局错误码） */
export async function handleResidueIpc(deps: ResidueIpcDeps, raw: unknown): Promise<ResidueResult> {
  return createChannelHandler<ResidueRequest, ResidueResult, ResidueIpcDeps>(
    { scope: IPC_CHANNELS.residue.name, schema: IPC_CHANNELS.residue.request, dialect: reasonEnvelope, catchStyle: { kind: "rethrow" } },
    deps,
    routeResidue,
  )(raw);
}

/** residue 二通道路由主体 */
async function routeResidue(req: ResidueRequest, deps: ResidueIpcDeps): Promise<ResidueResult> {
  switch (req.channel) {
    case "residue:detect":
      return { ok: true, processes: await deps.detect() };
    case "residue:kill":
      return { ok: true, results: await deps.kill(req.pids) };
  }
}

/** 处理一条 diff:ipc 入站请求：信封经共享工厂（code 方言 + rethrow），diff:get 经 project store 解析 cwd 后透传服务结果 */
export async function handleDiffIpc(deps: DiffIpcDeps, raw: unknown): Promise<DiffResult> {
  return createChannelHandler<DiffRequest, DiffResult, DiffIpcDeps>(
    { scope: IPC_CHANNELS.diff.name, schema: IPC_CHANNELS.diff.request, dialect: codeEnvelope, catchStyle: { kind: "rethrow" } },
    deps,
    routeDiff,
  )(raw);
}

/** diff 单通道路由主体 */
async function routeDiff(req: DiffRequest, deps: DiffIpcDeps): Promise<DiffResult> {
  switch (req.channel) {
    case "diff:get": {
      const project = deps.projects.get(req.projectId);
      if (!project) {
        return { ok: false, error: { code: "E_PROJECT_NOT_FOUND", message: `项目不存在：${req.projectId}` } };
      }
      // return await：让 readWorkspaceDiff 的拒绝进 catch（记日志后原样 rethrow），而非绕过 catch 直达调用方
      return await deps.readWorkspaceDiff(project.canonicalPath);
    }
  }
}

// ============ #80 cli:status 通道（spec #75 实现决策 3/7：三真实 CLI 安装状态聚合；fake/pty 恒可用不经探测） ============

/** cli:status 路由依赖：安装状态查询（生产 = index.ts 经 createCliStatusService 装配：已装进程内缓存、未装每次重探）；isShuttingDown?/log? 经 EnvelopeDeps 注入 */
export interface CliStatusIpcDeps extends EnvelopeDeps {
  cliStatus(): Promise<CliInstalledMap>;
}

/** 处理一条 cli:status 入站请求：信封经共享工厂（code 方言 + fail——探测意外异常返回明确错误不 rethrow，菜单不因此废掉） */
export async function handleCliStatusIpc(deps: CliStatusIpcDeps, raw: unknown): Promise<CliStatusResult> {
  return createChannelHandler<CliStatusRequest, CliStatusResult, CliStatusIpcDeps>(
    {
      scope: IPC_CHANNELS.cliStatus.name,
      schema: IPC_CHANNELS.cliStatus.request,
      dialect: codeEnvelope,
      catchStyle: {
        kind: "fail",
        logMessage: (message) => `CLI 安装状态查询失败：${message}`,
        toResult: (message) => ({ ok: false, error: { code: "E_INTERNAL", message: `CLI 安装状态查询失败：${message}` } }),
      },
    },
    deps,
    routeCliStatus,
  )(raw);
}

/** cli:status 单通道路由主体 */
async function routeCliStatus(req: CliStatusRequest, deps: CliStatusIpcDeps): Promise<CliStatusResult> {
  switch (req.channel) {
    case "cli:status":
      return { ok: true, installed: await deps.cliStatus() };
  }
}

// ============ #61 config:ipc 通道（spec #57 配置链路，对齐 diff:ipc 独立单通道先例：读 autoArchive 子集 / 写经 LiveConfig.set 字段级合并 + 先持久化成功再变异） ============

/** config:ipc 路由依赖：活配置读写器（config.ts 统一写入口，arch C10；测试注入真实 openLiveConfig + tmp 文件）；isShuttingDown?/log? 经 EnvelopeDeps 注入 */
export interface ConfigIpcDeps extends EnvelopeDeps {
  /** 活配置（get 恒同一引用 = Main 内存态；set 先持久化成功再原地变异内存对象——写序单点，与项目切换共用） */
  config: LiveConfig;
  /** #64（spec #57）：配置保存成功后触发一次自动归档扫描（引擎由 index.ts 注入，handler 不直接耦合引擎；缺省不扫描供旧测试）。
   *  在内存配置更新之后调用（扫描读到新值）；应答携带返回的摘要供设置区即时反馈 */
  onAutoArchiveSaved?(config: AppConfig): Promise<AutoArchiveScanSummary | null>;
  /** #64：上次扫描摘要缓存（index.ts 闭包；config:get 应答携带，跨打开周期保留；缺省 null=尚未扫描） */
  getLastScan?(): AutoArchiveScanSummary | null;
}

/** 处理一条 config:ipc 入站请求：信封经共享工厂（code 方言 + fail——写盘失败返回明确错误不 rethrow），读子集 / 写先持久化成功再改内存（失败明确报错，内存与磁盘不分叉） */
export async function handleConfigIpc(deps: ConfigIpcDeps, raw: unknown): Promise<ConfigResult> {
  return createChannelHandler<ConfigRequest, ConfigResult, ConfigIpcDeps>(
    {
      scope: IPC_CHANNELS.config.name,
      schema: IPC_CHANNELS.config.request,
      dialect: codeEnvelope,
      // 写盘失败不 rethrow：配置保存是用户可见的可重试动作，返回明确错误直达调用方（新值不生效）；文案逐字保持既有锚点
      catchStyle: {
        kind: "fail",
        logMessage: (message) => `配置保存失败（新值未生效）：${message}`,
        toResult: (message) => ({ ok: false, error: { code: "E_INTERNAL", message: `配置保存失败，新值未生效：${message}` } }),
      },
    },
    deps,
    routeConfig,
  )(raw);
}

/** config 二通道路由主体 */
async function routeConfig(req: ConfigRequest, deps: ConfigIpcDeps): Promise<ConfigResult> {
  switch (req.channel) {
    case "config:get":
      return { ok: true, autoArchive: deps.config.get().autoArchive, lastScan: deps.getLastScan?.() ?? null };
    case "config:set": {
      // 统一写入口（LiveConfig.set）：先持久化成功再变异内存，抛错进 catch（返回明确错误，内存对象未动，新值不生效）；
      // 写仅开放 autoArchive 子集 —— 持久化对象由内存配置字段级合并而来，项目/CLI 路径等其余字段不受请求影响
      deps.config.set({ autoArchive: req.autoArchive });
      const current = deps.config.get();
      // #64：保存成功后触发自动归档扫描（读到的已是新值）。扫描异常不改变「保存已成功」的事实——
      // 记日志、摘要置 null，不落入下方 catch 谎报「保存失败」
      let lastScan: AutoArchiveScanSummary | null = null;
      if (deps.onAutoArchiveSaved) {
        try {
          lastScan = await deps.onAutoArchiveSaved(current);
        } catch (err) {
          deps.log?.("error", "config:ipc", `保存后自动归档扫描失败（配置已保存生效）：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return { ok: true, autoArchive: current.autoArchive, lastScan };
    }
  }
}

// ============ #76 models:ipc 通道（spec #75 模型目录：models:list 按 cli 经 adapter 分发；默认项由 isDefault 派生） ============

/** models:ipc 路由依赖：adapter（生产 = CliHostClient/AdapterRouter，按 cli 分发到各实现）；isShuttingDown?/log? 经 EnvelopeDeps 注入 */
export interface ModelsIpcDeps extends EnvelopeDeps {
  adapter: CliAdapter;
}

/** 处理一条 models:ipc 入站请求：信封经共享工厂（code 方言 + adapter-passthrough——AdapterError 错误码透传，如 claude 暂未支持 E_INTERNAL、exe 未装 E_SPAWN_NOT_FOUND） */
export async function handleModelsIpc(deps: ModelsIpcDeps, raw: unknown): Promise<ModelsResult> {
  return createChannelHandler<ModelsRequest, ModelsResult, ModelsIpcDeps>(
    { scope: IPC_CHANNELS.models.name, schema: IPC_CHANNELS.models.request, dialect: codeEnvelope, catchStyle: { kind: "adapter-passthrough", toError: codeEnvelope.toError } },
    deps,
    routeModels,
  )(raw);
}

/** models 单通道路由主体 */
async function routeModels(req: ModelsRequest, deps: ModelsIpcDeps): Promise<ModelsResult> {
  switch (req.channel) {
    case "models:list":
      return { ok: true, models: await deps.adapter.listModels({ cli: req.cli, cwd: req.cwd }) };
  }
}
