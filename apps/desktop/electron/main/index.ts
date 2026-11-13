// 用途：Electron 主进程入口 —— 创建主窗口、注册 IPC 处理器（app:getInfo + kanban:ipc/memory:ipc/diff:ipc/residue:ipc/config:ipc/models:ipc/cli:status 路由）、CliHost 托管（utilityProcess 优先，进程内回退）与事件转发/状态落库、TrackerEngine（SkillObservation 落库 + 重启恢复）、PTY 终端宿主（node-pty，main 进程直接使用，t0-03 实证）、有序退出与残留进程检测一次性通知（#49 app:event）、#51 单实例锁（二次启动转发聚焦 + 持锁失败立即退出）、#53 日志地基（Logger 二实例守卫后创建 + 启动横幅 + 崩溃兜底 + 9 处 console 迁移 + log:getPath/log:openDir）、#54 worker {log} 消息与 CLI stderr 汇聚（onWorkerLog→worker source；进程内回退同目标）；#64 自动归档引擎接线（启动后一次 + config:set 成功后经 onAutoArchiveSaved 触发，摘要缓存供设置区反馈）；初始化应用配置与 SQLite（依赖方向：main → cli-host, tracker, ipc-schema，spec A）
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as nodePty from "node-pty";
import {
  appEventSchema,
  appInfoSchema,
  IPC_CHANNELS,
  memoryEventSchema,
  residueProcessSchema,
  shutdownNoticeSchema,
  terminalEventSchema,
  trackerChangeSchema,
  type AutoArchiveScanSummary,
  type ResidueProcess,
} from "@kanban/ipc-schema";
import {
  AdapterRouter,
  createDesktopAdapterFactory,
  listClaudeExeCandidates,
  listCodexExeCandidates,
  listOpenCodeExeCandidates,
  type CliAdapter,
} from "@kanban/cli-host";
import { TrackerEngine } from "@kanban/tracker";
import { defaultConfig, loadConfig, resolveEffectiveLevel, saveConfig, type AppConfig } from "./config";
import { runAutoArchiveScan } from "./auto-archive";
import { createAdapterEventHandler } from "./adapter-events";
import { CliHostClient } from "./cli-host-client";
import { createCliStatusService, createRealCliProbes, createSeededCliProbes } from "./cli-status-service";
import { SQLITE_ENTRY, openDatabase } from "./db";
import { createValidatedSender } from "./event-sender";
import { handleIpc, handleCliStatusIpc, handleConfigIpc, handleDiffIpc, handleMemoryIpc, handleModelsIpc, handleResidueIpc, TRACKER_CLI_BY_APP, type IpcDeps } from "./ipc";
import { defaultGitDiffDeps, readWorkspaceDiff } from "./git-diff-service";
import { handleLogWrite } from "./log-write";
import { createLogger, registerCrashHandlers, resolveKindLog, type Logger } from "./logger";
import { openMemoryService } from "./memory-service";
import { createPtyHost } from "./pty-host";
import { ProjectStore } from "./project-store";
import { detectResidue, killResidue, type ResidueServiceDeps } from "./residue-service";
import { createAdapterSessionProcesses, createSessionLifecycle } from "./session-lifecycle";
import { SessionStore } from "./session-store";
import { createShutdownOrchestrator } from "./shutdown";

// #53：Main 侧唯一日志深模块实例（whenReady 二实例守卫后创建；模块级因 createHostedAdapter/loadResidueSeed 等闭包引用）
let logger: Logger;

/** #53（spec #52 E 节）：cli-host/shutdown/restore 的 (kind, detail) 2 参回调 → 集中映射表 → Logger（签名不变，只换注入目标） */
const logKind = (kind: string, detail: string): void => {
  const mapped = resolveKindLog(kind);
  logger.log(mapped.level, mapped.scope, detail);
};

/** #54（spec #52 C 节）：CLI 子进程 stderr 归 worker 口径 —— worker {log} 消息与进程内回退形态的 adapter 诊断同走 worker source（source 由 Main 入口强制，不信上游自报） */
const logKindAsWorker = (kind: string, detail: string): void => {
  const mapped = resolveKindLog(kind);
  logger.log(mapped.level, mapped.scope, detail, undefined, "worker");
};

/** CliHost 托管形态（ADR-0001：utilityProcess 崩溃隔离 + Job Object）；worker 产物缺失/fork 失败回退 Main 进程内（C5 降级路径，seam 不变） */
function createHostedAdapter(appConfig: AppConfig): CliAdapter {
  const dataDir = app.getPath("userData");
  const workerPath = join(__dirname, "cli-host-worker.js");
  if (existsSync(workerPath)) {
    try {
      // log：Job guard 失败等治理事件不再静默（#29 复盘：guard 脚本缺陷曾长期无感知）；#53 起走集中 kind 映射进统一日志；
      // onWorkerLog：#54 —— worker 经 {log} 消息上报的 CLI stderr/协议异常分派进同一映射表（source 强制 worker）
      return new CliHostClient({ workerPath, dataDir, codexExe: appConfig.cliExe.codex, claudeExe: appConfig.cliExe.claude, opencodeExe: appConfig.cliExe.opencode, fullDisposeWaitMs: appConfig.shutdown.graceMs, log: logKind, onWorkerLog: logKindAsWorker });
    } catch (e) {
      // 告警文本为 packaged-smoke.cjs 的 stderr 断言锚点，字面不可变；warn 级经 Logger 双写仍走 console.error/stderr
      logger.log("warn", "cli-host", `utilityProcess 托管不可用，回退进程内：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return new AdapterRouter(
    // #54：进程内回退形态同一工厂注入点同目标替换 —— CLI stderr 亦可达 Logger（归 worker source，spec #52 C 节）
    createDesktopAdapterFactory({ codexExe: appConfig.cliExe.codex, claudeExe: appConfig.cliExe.claude, opencodeExe: appConfig.cliExe.opencode, cacheDir: dataDir, log: logKindAsWorker }),
  );
}

// Adapter 门面：fake/codex/claude/opencode 经 CliHost 分发（utilityProcess 托管；KANBAN_DISABLE_CODEX/KANBAN_DISABLE_CLAUDE/KANBAN_DISABLE_OPENCODE=1 时对应 CLI 回落 Fake 演示模式）
let adapter: CliAdapter;

let mainWindow: BrowserWindow | null = null;

/** 出站事件目标窗口（未建/已销毁 → null = 静默丢弃；#72 C1 Step3：五处事件发送器样板共用的窗口判定） */
const getMainWindow = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);

// E2E 隔离：测试用 env 指定独立 userData（app.setPath 须在 ready 前调用）
if (process.env.KANBAN_USER_DATA) {
  app.setPath("userData", process.env.KANBAN_USER_DATA);
}

// #51 单实例锁：锁 key 随 userData（须在上方 setPath 覆盖之后请求，E2E 隔离环境各自独立锁）。
// 持锁失败（已有实例运行）→ app.quit 立即退出。实测 quit 前置调用并不能阻止 ready 触发，
// 故 whenReady 回调顶部再设同款守卫（等价官方文档"启动逻辑收进 else 分支"，免整体重排）：
// 二实例不创建窗口、不触碰 SQLite/CLI Host/残留检测（双开曾致 GPU cache 拒绝访问 0x5 + DB 竞争）
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  // 二次启动转发：首实例窗口前置聚焦（最小化则还原）；窗口未建（首实例尚在启动）时静默
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

/** 创建主窗口（暗色底色，防白闪）并加载 renderer：dev 走 electron-vite dev server，生产加载构建产物 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: "#0f1117",
    title: "Kanban Desktop",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  // E2E 免打扰：KANBAN_E2E_NO_FOCUS=1 时显示但不激活（不抢前台输入焦点；窗口仍可见，截图/合成事件不受影响）
  mainWindow.on("ready-to-show", () => {
    if (process.env.KANBAN_E2E_NO_FOCUS === "1") mainWindow?.showInactive();
    else mainWindow?.show();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

/** 原生目录选择（项目注册入口）；E2E 用 env 固定目录跳过模态对话框 */
function pickDirectory(): Promise<string | null> {
  const fixed = process.env.KANBAN_TEST_PICK_DIRECTORY;
  if (fixed) return Promise.resolve(fixed);
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(null);
  return dialog
    .showOpenDialog(mainWindow, { title: "选择项目目录", properties: ["openDirectory"] })
    .then((res) => (res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]));
}

app.whenReady().then(async () => {
  // 二实例兜底：quit 已在模块顶层发起，但 ready 仍可能触发——此处直接返回，不初始化任何资源
  //（含 #53 Logger：二实例不建日志文件、不注册崩溃兜底，保持「一次运行一份」与保留计数语义）
  if (!gotSingleInstanceLock) return;

  // #53（spec #52 A 节）：Logger 创建 —— 二实例守卫后、config 加载前（启动早期 config 首写/DB/worker fork 异常可取证、
  // 无就绪前缓冲）；先用默认参数（config 尚未加载），崩溃兜底同处注册；config 加载后经 start 应用最终参数并写启动横幅
  const bootLogging = defaultConfig().logging;
  logger = createLogger({
    dir: join(app.getPath("userData"), "logs"),
    logging: { ...bootLogging, level: resolveEffectiveLevel(bootLogging.level, process.env.KANBAN_LOG_LEVEL) },
  });
  registerCrashHandlers(process, logger, (code) => app.exit(code));

  // 配置初始化：当前项目 id 持久化在同一 JSON（spec J：不硬编码、落应用数据目录）
  const configPath = join(app.getPath("userData"), "config.json");
  const appConfig: AppConfig = existsSync(configPath) ? loadConfig(configPath) : defaultConfig();
  if (!existsSync(configPath)) {
    saveConfig(configPath, appConfig);
  }

  // #53（spec #52 D 节）：env 覆盖只进 effectiveLevel 不落 appConfig（M11：切换项目 saveConfig 全量写回不误持久化）；
  // start 应用最终 logging 四项 + 按新 retainRuns 重跑清理 + 写启动横幅（正常路径严格首条 info）
  const effectiveLevel = resolveEffectiveLevel(appConfig.logging.level, process.env.KANBAN_LOG_LEVEL);
  logger.start({ ...appConfig.logging, level: effectiveLevel }, {
    app: app.getName(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    cliExeOverridden: {
      codex: appConfig.cliExe.codex != null,
      claude: appConfig.cliExe.claude != null,
      opencode: appConfig.cliExe.opencode != null,
    },
  });

  // SQLite：打开应用数据目录下的数据库并按 C3 建五表（D2 冒烟已验证 node:sqlite 在 Electron 44 主进程可用）
  const db = openDatabase(join(app.getPath("userData"), "kanban.db"));
  const projects = new ProjectStore(db);
  const sessions = new SessionStore(db);
  // Tracker 接线（#9）：SkillObservation 落库驱动状态机；启动即按 stage_events 事件日志重放恢复（需求/关联/幂等集）
  const trackerEngine = new TrackerEngine(db);
  trackerEngine.restore();
  // 启动探测：全部项目目录存在性落库（missing 标记，工单 #7 验收第 1 条）
  projects.refreshStatuses();
  // CliHost 托管 adapter（utilityProcess 优先；config 手动覆盖 exe + env 开关在工厂内生效）
  // —— #32 起先于 memory 装配：提取双桥（readTranscript/runOnce）经它接线
  adapter = createHostedAdapter(appConfig);

  // #32 memory 面装配（spec #27 A/C 节）：打开库即对账（running 批次→failed 等四规则，崩溃窗口收敛不锁死需求）；
  // dataRoot=<userData>/memory（D 节布局根，亦是提取临时 cwd 根）；需求关联会话/标题/项目归属/存在性由 Main 查 tracker 后传入（memory 不依赖 tracker）
  // #32 提取双桥：readTranscript 经 CliAdapter 契约（托管/进程内皆有）；runOnce/cancelRunOnce 经 CliAdapter 可选面探测（issue #73 取代 instanceof CliHostClient）
  //（进程内回退未实现该可选成员——extract 落 cli-unavailable 业务拒绝，C5 降级路径如实声明边界）
  // #72 C1 Step3：事件发送器经共享工厂（出站过 schema 校验失败 throw；窗口不在时静默丢弃转发）
  const sendMemoryEvent = createValidatedSender(memoryEventSchema, "memory:event", getMainWindow);
  const runOnceBridge = adapter.runOnce?.bind(adapter);
  const cancelRunOnceBridge = adapter.cancelRunOnce?.bind(adapter);
  // 需求当前关联会话查询（两闭包同形遍历的共享形状）：按 kind 过滤收集，structured 附加 CLI 名（pty 侧仅取 sessionId）
  const listLinkedSessions = (
    requirementId: string,
    kind: "structured" | "pty",
  ): Array<{ sessionId: string; cli: string }> => {
    const out: Array<{ sessionId: string; cli: string }> = [];
    for (const [sessionId, reqId] of trackerEngine.tracker.sessionToReq) {
      if (reqId !== requirementId) continue;
      const s = sessions.get(sessionId);
      if (s && s.kind === kind) out.push({ sessionId, cli: TRACKER_CLI_BY_APP[s.cli] ?? "claude-code" });
    }
    return out;
  };
  const listLinkedStructuredSessions = (requirementId: string): Array<{ sessionId: string; cli: string }> =>
    listLinkedSessions(requirementId, "structured");
  const listLinkedPtySessions = (requirementId: string): Array<{ sessionId: string }> =>
    listLinkedSessions(requirementId, "pty").map(({ sessionId }) => ({ sessionId }));
  const memoryService = openMemoryService({
    db,
    dataRoot: join(app.getPath("userData"), "memory"),
    listLinkedStructuredSessions,
    listLinkedPtySessions,
    getRequirementProjectId: (requirementId) => trackerEngine.tracker.req(requirementId)?.projectId ?? null,
    getRequirementTitle: (requirementId) => trackerEngine.tracker.req(requirementId)?.title ?? null,
    requirementExists: (requirementId) => trackerEngine.tracker.req(requirementId) != null,
    readTranscriptBridge: (sessionId) => adapter.readTranscript(sessionId),
    runOnceBridge,
    cancelRunOnceBridge,
    emitMemoryEvent: sendMemoryEvent,
  }).service;

  // Adapter 事件流：出站校验 + 会话状态落库 + SkillObservation 进 tracker 落库（#9）→ 转发 renderer；窗口不在时静默丢弃转发
  // #17：tracker 变更出站过 schema 校验后经 tracker:event 转发 renderer（看板事件驱动刷新；与 chat:event/terminal:event 同模式）
  const sendTrackerChange = createValidatedSender(trackerChangeSchema, "tracker:event", getMainWindow);
  adapter.subscribe(
    createAdapterEventHandler({
      sessions,
      engine: trackerEngine,
      send: (event) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("chat:event", event);
        }
      },
      sendChange: sendTrackerChange,
    }),
  );

  // PTY 宿主装配：平台能力注入（shell/CLI exe 覆盖来自 config，不硬编码）；事件出站过 schema 校验并转发 renderer，
  // started/exit 的 sessions 状态落库与 #58/#62 迟到守卫统一经 lifecycle.onTerminalEvent（#70 C2 唯一写入口；
  // 已归档/已删除终端的迟到事件不落库不转发，spec #57 D 节）——四回调退化为「问 lifecycle → 转发」
  const sendTerminalEvent = createValidatedSender(terminalEventSchema, "terminal:event", getMainWindow);
  const ptyHost = createPtyHost(
    {
      pty: nodePty,
      execFileSync,
      execFileTextSync: (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }) as string,
      existsSync,
      resolve: (p) => join(p),
      tmpdir: () => app.getPath("temp"),
      env: process.env,
      platform: process.platform,
      cwd: () => process.cwd(),
      shellOverride: () => appConfig.terminal.shell,
      cliExeOverride: (name) => (appConfig.cliExe as unknown as Record<string, string | null>)[name] ?? null,
    },
    {
      started: (terminalId, payload) => {
        if (!lifecycle.onTerminalEvent(terminalId, "started")) return;
        sendTerminalEvent({ terminalId, type: "started", ...payload });
      },
      data: (terminalId, data) => {
        if (!lifecycle.onTerminalEvent(terminalId, "data")) return;
        sendTerminalEvent({ terminalId, type: "data", data });
      },
      exit: (terminalId, payload) => {
        if (!lifecycle.onTerminalEvent(terminalId, "exit")) return;
        sendTerminalEvent({ terminalId, type: "exit", ...payload });
      },
      error: (terminalId, payload) => {
        if (!lifecycle.onTerminalEvent(terminalId, "error")) return;
        sendTerminalEvent({ terminalId, type: "error", message: payload.message });
      },
    },
  );

  // #70 C2：会话生命周期唯一编排写者（archive/unarchive/remove/终端事件落库收敛；ipc 路由壳 / 自动归档引擎 / PTY 事件泵共用同一实例），
  // 进程能力经 SessionProcesses seam 分派（structured → adapter；pty → 宿主 kill）；
  // 声明于 ptyHost 之后（procs 引用宿主）——上方 PTY 回调闭包捕获本绑定，同步紧邻赋值后才可能发生首个 spawn，无空窗
  const lifecycle = createSessionLifecycle({
    sessions,
    procs: createAdapterSessionProcesses(adapter, ptyHost),
    log: logger.log,
  });

  // 重开恢复编排（#13/spec H，#70 起经 lifecycle 唯一写者）：DB 中未归档结构化会话收养登记 disconnected（readHistory/resume 可续），
  // PTY 统一断开；置于 lifecycle 就绪后（原序为事件泵订阅与 PTY 宿主创建之间，均无 spawn/事件源，顺序等价）
  await lifecycle.adoptRestored();

  // 统一退出序列（#13/spec H §6.1）：停新请求（IPC 拒新 + UI 提示）→ 有序取消 → 有限等待（config.shutdown.graceMs）→
  // Session 粒度受控终止 → 全量 dispose（worker shutdown/kill 兜底）→ PTY 全停；Job Object 覆盖强杀残留
  // #72 C1 Step3：退出通知经事件发送器工厂（parse 提前到窗口判定之前——reason 恒为内部字符串，该 schema 无失败路径，顺序等价）
  const sendShutdownNotice = createValidatedSender(shutdownNoticeSchema, "app:shutdown", getMainWindow);
  const shutdown = createShutdownOrchestrator({
    adapter,
    pty: ptyHost,
    sessions,
    graceMs: appConfig.shutdown.graceMs,
    // #32（spec #27 C 节）：退出序列第 7 步停止 memory 提取（running 批次 → cancelled；adapter/PTY 后、DB 关闭前）
    memory: memoryService,
    notifyShutdown: (reason) => sendShutdownNotice({ reason }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: logKind,
  });
  app.on("before-quit", (event) => {
    if (shutdown.isShuttingDown()) return; // 序列已执行完毕，放行真实退出
    event.preventDefault();
    void shutdown.begin("app-quit").then(() => app.quit());
  });
  app.on("quit", () => {
    trackerEngine.close(); // 关闭 engine 与底层 DB 连接（唯一关闭点）
  });

  const deps: IpcDeps = {
    adapter,
    // PTY 宿主：node-pty 在 main 进程直接使用（main → ConPTY；utilityProcess 是 cli-host 的形态，spec F）
    pty: ptyHost,
    projects,
    sessions,
    // #70 C2：归档/取消归档/删除编排唯一写者（路由壳只做未知会话错误形状与解关联 hook 注入）
    lifecycle,
    // #17：kanban:* 通道经 TrackerEngine 落事件流；变更推送与事件泵共用 sendTrackerChange（tracker:event）
    engine: trackerEngine,
    // #35（spec #27 J 节）：kanban:delete 需求删除级联清理该需求 memory 数据（知识保留、需求级记录清理）
    memory: memoryService,
    emitTrackerChange: sendTrackerChange,
    pickDirectory,
    getCurrentProjectId: () => appConfig.currentProjectId,
    setCurrentProjectId: (id) => {
      appConfig.currentProjectId = id;
      saveConfig(configPath, appConfig);
    },
    isShuttingDown: () => shutdown.isShuttingDown(),
    // #53：入站校验失败/内部异常记统一日志（业务拒绝不记）
    log: logger.log,
  };

  // 注册 IPC 处理器：app:getInfo 冒烟通道 + 五个 :ipc 单通道路由（入站强制 zod 校验，spec E；通道名经 IPC_CHANNELS 单源，#72 Step4）
  ipcMain.handle("app:getInfo", () =>
    appInfoSchema.parse({
      app: app.getName(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      platform: process.platform,
      sqliteEntry: SQLITE_ENTRY,
      // Fake 演示会话 cwd：e2e/部署经 KANBAN_FAKE_DEMO_CWD 固定；缺省用户主目录（不内置开发机路径）
      fakeDemoCwd: process.env.KANBAN_FAKE_DEMO_CWD || homedir(),
      // #46：配置文件绝对路径（spawn 失败卡「复制配置路径」数据源；与配置初始化同一路径）
      configPath,
    }),
  );
  ipcMain.handle(IPC_CHANNELS.kanban.name, (_event, raw: unknown) => handleIpc(deps, raw));
  // #76（spec #75 模型目录）：models:ipc 单通道 —— models:list 按 cli 经 adapter 分发（AdapterError 原码透传：claude 暂未支持/exe 未装）
  ipcMain.handle(IPC_CHANNELS.models.name, (_event, raw: unknown) =>
    handleModelsIpc({ adapter, isShuttingDown: () => shutdown.isShuttingDown(), log: logger.log }, raw),
  );
  // #31：memory:ipc 单通道（入站 zod 强制校验 + 业务拒绝 ok:false+reason，spec #27 H 节）
  ipcMain.handle(IPC_CHANNELS.memory.name, (_event, raw: unknown) =>
    handleMemoryIpc({ memory: memoryService, isShuttingDown: () => shutdown.isShuttingDown(), log: logger.log }, raw),
  );
  // #43：diff:ipc 单通道（spec #40 D 节；git exe 解析 = config gitExe 覆盖 → env → where，解析失败归 git-missing）
  // #47：三类截断上限来自 config.diff（采集字节/文件数/untracked 行数，超限置 truncated）
  ipcMain.handle(IPC_CHANNELS.diff.name, (_event, raw: unknown) =>
    handleDiffIpc(
      {
        projects,
        readWorkspaceDiff: (cwd) => readWorkspaceDiff(cwd, defaultGitDiffDeps(appConfig.gitExe, appConfig.diff), appConfig.diff),
        isShuttingDown: () => shutdown.isShuttingDown(),
        log: logger.log,
      },
      raw,
    ),
  );

  // #61（spec #57 配置链路）：config:ipc 单通道 —— 读 autoArchive 子集 / 写仅接受该子集并字段级合并进 appConfig 闭包对象
  //（先持久化成功再改内存；与 setCurrentProjectId 的全量写回共享同一对象，项目切换与设置保存互不覆盖）
  // #64（spec #57）：保存成功后经 onAutoArchiveSaved 触发一次自动归档扫描（handler 不直接耦合引擎）；getLastScan 缓存跨打开周期反馈
  let lastAutoArchiveScan: AutoArchiveScanSummary | null = null;
  const runAutoArchive = async (): Promise<AutoArchiveScanSummary | null> => {
    if (!appConfig.autoArchive.enabled) return null; // 默认关：零动作（不扫描不缓存，老数据不动）
    const summary = await runAutoArchiveScan({ sessions, pty: ptyHost, lifecycle, log: logger.log }, appConfig.autoArchive);
    lastAutoArchiveScan = summary;
    return summary;
  };
  ipcMain.handle(IPC_CHANNELS.config.name, (_event, raw: unknown) =>
    handleConfigIpc(
      {
        getConfig: () => appConfig,
        persist: (config) => saveConfig(configPath, config),
        onAutoArchiveSaved: runAutoArchive,
        getLastScan: () => lastAutoArchiveScan,
        isShuttingDown: () => shutdown.isShuttingDown(),
        log: logger.log,
      },
      raw,
    ),
  );

  // #80（spec #75 实现决策 7）：cli:status 单通道 —— 三真实 CLI exe 探测聚合（已装进程内缓存、未装每次重探：装完重开菜单即恢复）；
  // e2e 经 KANBAN_TEST_CLI_STATUS_JSON 种子驱动（每次重读支持探测翻转），无种子走真实解析链（config 手动覆盖透传；DISABLE_* 回落 Fake 时点击有效不灰置）
  const cliStatus = createCliStatusService(
    process.env.KANBAN_TEST_CLI_STATUS_JSON
      ? createSeededCliProbes(process.env.KANBAN_TEST_CLI_STATUS_JSON, (m) => logger.child("cli-status").log("warn", m))
      : createRealCliProbes({
          codexExe: appConfig.cliExe.codex,
          claudeExe: appConfig.cliExe.claude,
          opencodeExe: appConfig.cliExe.opencode,
        }),
  );
  ipcMain.handle(IPC_CHANNELS.cliStatus.name, (_event, raw: unknown) =>
    handleCliStatusIpc({ cliStatus, isShuttingDown: () => shutdown.isShuttingDown(), log: logger.log }, raw),
  );

  // #49 残留治理装配（spec #40 A/D/F 节）：检测 = exe 匹配三 CLI 解析链候选并集 + 排除 #44 活跃集合 +
  // 排除注册表核对通过可接管的 OpenCode 孤儿；终止 = 逐 pid 确认式 killed/failed（无自动清理路径）
  // E2E 预置 fake 检测结果（KANBAN_TEST_RESIDUE_JSON 指向残留清单 JSON，参照 memory-seed.ts 预置思路）：
  // 不做真实探测与终止，驱动通知条 Playwright 流程；KANBAN_USER_DATA 隔离环境（整机 e2e）且无种子时跳过
  // 机器级进程枚举——否则开发机上他人打开的真实 CLI 进程会把非密封 banner 带进无关 e2e 断言
  const residueSeed = loadResidueSeed(process.env.KANBAN_TEST_RESIDUE_JSON);
  const residueE2eSkip = !residueSeed && !!process.env.KANBAN_USER_DATA;
  const residueDeps: ResidueServiceDeps = residueSeed
    ? {
        listCandidates: () => ({ codex: [], claude: [], opencode: [] }),
        queryProcesses: () => [],
        listActivePids: async () => [],
        registryPath: join(app.getPath("userData"), "opencode-servers.json"),
        listSessions: () => [],
        killPid: () => ({ ok: true }), // fake pid 不真实存在：统一回报 killed 驱动 UI 流程
      }
    : {
        listCandidates: () => ({
          codex: listCodexExeCandidates({ manualOverride: appConfig.cliExe.codex }),
          claude: listClaudeExeCandidates({ manualOverride: appConfig.cliExe.claude }),
          opencode: listOpenCodeExeCandidates({ manualOverride: appConfig.cliExe.opencode }),
        }),
        // 可选面探测（issue #73）：回退形态 AdapterRouter 实现了 listChildPids——residue 活跃集合如实上报（修复旧 instanceof 探测丢弃回退形态 pid 的少报）
        listActivePids: () => adapter.listChildPids?.() ?? Promise.resolve([]),
        registryPath: join(app.getPath("userData"), "opencode-servers.json"),
        // #58 全量会话记录（含已归档）：残留归属的「最近会话」回落对归档会话仍可归属（spec #57 决策附注）
        listSessions: () => sessions.listAll(),
      };
  // 每次启动只检测一次（spec：就绪后一次、不轮询）；residue:detect 返回同一缓存，renderer 挂载拉取与 app:event 推送同源
  const detectResidueOnce = (() => {
    let p: Promise<ResidueProcess[]> | null = null;
    return () =>
      (p ??= residueSeed ? Promise.resolve(residueSeed) : residueE2eSkip ? Promise.resolve([]) : detectResidue(residueDeps));
  })();
  const sendAppEvent = createValidatedSender(appEventSchema, "app:event", getMainWindow);
  ipcMain.handle(IPC_CHANNELS.residue.name, (_event, raw: unknown) =>
    handleResidueIpc(
      {
        detect: detectResidueOnce,
        kill: (pids) => killResidue(residueDeps, pids),
        isShuttingDown: () => shutdown.isShuttingDown(),
        log: logger.log,
      },
      raw,
    ),
  );

  // #53（spec #52 H 节）：日志最小入口 Main 侧 —— getLogPath 返回当前启动主文件路径（currentFilePath=含横幅主文件，分片不对外）；
  // openLogDir 用 shell.showItemInFolder 传主文件（在资源管理器中定位/选中该文件，M9：文案「打开」实现为定位）
  ipcMain.handle("log:getPath", () => logger.currentFilePath);
  ipcMain.handle("log:openDir", () => {
    shell.showItemInFolder(logger.currentFilePath);
  });

  // #55（spec #52 B/C 节）：Renderer 日志单向通道（全仓首个 ipcMain.on send 形态）——
  // fire-and-forget 无回执；入站 safeParse 失败丢弃记 warn、source 强制 renderer、ts 由 Logger 生成
  ipcMain.on("log:write", (_event, raw: unknown) => handleLogWrite(logger, raw));

  createWindow();

  // #64（spec #57）：启动触发一次自动归档扫描 —— 恢复收养（lifecycle.adoptRestored）与全部依赖就绪后发起；
  // 默认关零动作；不阻塞窗口创建；此后仅配置保存成功时再扫（无常驻定时器）
  void runAutoArchive();

  // 残留检测一次性触发（窗口就绪后推送；无结果不推送任何事件 = 不打扰；renderer 挂载时的 residue:detect 拉取兜底覆盖窗口时序）
  mainWindow?.once("ready-to-show", () => {
    void detectResidueOnce()
      .then((list) => {
        if (list.length > 0) sendAppEvent({ type: "residue-detected", processes: list });
      })
      .catch((e) => logger.child("residue").log("error", `检测失败：${e instanceof Error ? e.message : String(e)}`));
  });
});

/** E2E 残留种子读取：KANBAN_TEST_RESIDUE_JSON 指向的 JSON 数组经 residueProcessSchema 逐条校验过滤（非法条目丢弃、文件缺失/损坏返回 null） */
function loadResidueSeed(seedPath: string | undefined): ResidueProcess[] | null {
  if (!seedPath) return null;
  try {
    const raw = JSON.parse(readFileSync(seedPath, "utf8")) as unknown[];
    return raw.filter((r): r is ResidueProcess => residueProcessSchema.safeParse(r).success);
  } catch (e) {
    logger.child("residue").log("error", `种子文件不可读（${seedPath}）：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// Windows 优先：关窗即退出（before-quit 触发统一退出序列：停新请求→有序取消→有限等待→受控终止→PTY 停止，#13/spec H）
app.on("window-all-closed", () => {
  app.quit();
});
