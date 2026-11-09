// 用途：Electron 主进程入口 —— 创建主窗口、注册 IPC 处理器（app:getInfo + kanban:ipc 路由）、CliHost 托管（utilityProcess 优先，进程内回退）与事件转发/状态落库、TrackerEngine（SkillObservation 落库 + 重启恢复）、PTY 终端宿主（node-pty，main 进程直接使用，t0-03 实证）和有序退出、初始化应用配置与 SQLite（依赖方向：main → cli-host, tracker, ipc-schema，spec A）
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as nodePty from "node-pty";
import {
  appInfoSchema,
  memoryEventSchema,
  shutdownNoticeSchema,
  terminalEventSchema,
  trackerChangeSchema,
  type MemoryEventWire,
} from "@kanban/ipc-schema";
import { AdapterRouter, createDesktopAdapterFactory, type CliAdapter } from "@kanban/cli-host";
import { TrackerEngine, type TrackerChange } from "@kanban/tracker";
import { defaultConfig, loadConfig, saveConfig, type AppConfig } from "./config";
import { createAdapterEventHandler } from "./adapter-events";
import { CliHostClient } from "./cli-host-client";
import { SQLITE_ENTRY, openDatabase } from "./db";
import { handleIpc, handleDiffIpc, handleMemoryIpc, TRACKER_CLI_BY_APP, type IpcDeps } from "./ipc";
import { defaultGitDiffDeps, readWorkspaceDiff } from "./git-diff-service";
import { openMemoryService } from "./memory-service";
import { createPtyHost } from "./pty-host";
import { ProjectStore } from "./project-store";
import { SessionStore } from "./session-store";
import { adoptRestoredSessions, createShutdownOrchestrator } from "./shutdown";

/** CliHost 托管形态（ADR-0001：utilityProcess 崩溃隔离 + Job Object）；worker 产物缺失/fork 失败回退 Main 进程内（C5 降级路径，seam 不变） */
function createHostedAdapter(appConfig: AppConfig): CliAdapter {
  const dataDir = app.getPath("userData");
  const workerPath = join(__dirname, "cli-host-worker.js");
  if (existsSync(workerPath)) {
    try {
      // log：Job guard 失败等治理事件不再静默（#29 复盘：guard 脚本缺陷曾长期无感知）
      return new CliHostClient({ workerPath, dataDir, codexExe: appConfig.cliExe.codex, claudeExe: appConfig.cliExe.claude, opencodeExe: appConfig.cliExe.opencode, fullDisposeWaitMs: appConfig.shutdown.graceMs, log: (k, d) => console.error(`[cli-host:${k}] ${d}`) });
    } catch (e) {
      console.error(`[cli-host] utilityProcess 托管不可用，回退进程内：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return new AdapterRouter(
    createDesktopAdapterFactory({ codexExe: appConfig.cliExe.codex, claudeExe: appConfig.cliExe.claude, opencodeExe: appConfig.cliExe.opencode, cacheDir: dataDir, log: (k, d) => console.error(`[cli-host:${k}] ${d}`) }),
  );
}

// Adapter 门面：fake/codex/claude/opencode 经 CliHost 分发（utilityProcess 托管；KANBAN_DISABLE_CODEX/KANBAN_DISABLE_CLAUDE/KANBAN_DISABLE_OPENCODE=1 时对应 CLI 回落 Fake 演示模式）
let adapter: CliAdapter;

let mainWindow: BrowserWindow | null = null;

// E2E 隔离：测试用 env 指定独立 userData（app.setPath 须在 ready 前调用）
if (process.env.KANBAN_USER_DATA) {
  app.setPath("userData", process.env.KANBAN_USER_DATA);
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

  mainWindow.on("ready-to-show", () => mainWindow?.show());

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
  // 配置初始化：当前项目 id 持久化在同一 JSON（spec J：不硬编码、落应用数据目录）
  const configPath = join(app.getPath("userData"), "config.json");
  const appConfig: AppConfig = existsSync(configPath) ? loadConfig(configPath) : defaultConfig();
  if (!existsSync(configPath)) {
    saveConfig(configPath, appConfig);
  }

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

  // #31 memory 面装配（spec #27 A/C 节）：打开库即对账（running 批次→failed 等四规则，崩溃窗口收敛不锁死需求）；
  // dataRoot=<userData>/memory（D 节布局根，亦是提取临时 cwd 根）；需求关联会话/标题/项目归属/存在性由 Main 查 tracker 后传入（memory 不依赖 tracker）
  // #32 提取双桥：readTranscript 经 CliAdapter 契约（托管/进程内皆有）；runOnce/cancelRunOnce 仅 utilityProcess 托管形态具备
  //（进程内回退无该能力——extract 落 cli-unavailable 业务拒绝，C5 降级路径如实声明边界）
  const sendMemoryEvent = (event: MemoryEventWire): void => {
    memoryEventSchema.parse(event);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("memory:event", event);
    }
  };
  const hostedAdapter = adapter instanceof CliHostClient ? adapter : null;
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
    runOnceBridge: hostedAdapter ? (input) => hostedAdapter.runOnce(input) : undefined,
    cancelRunOnceBridge: hostedAdapter ? (runId) => hostedAdapter.cancelRunOnce(runId) : undefined,
    emitMemoryEvent: sendMemoryEvent,
  }).service;

  // Adapter 事件流：出站校验 + 会话状态落库 + SkillObservation 进 tracker 落库（#9）→ 转发 renderer；窗口不在时静默丢弃转发
  // #17：tracker 变更出站过 schema 校验后经 tracker:event 转发 renderer（看板事件驱动刷新；与 chat:event/terminal:event 同模式）
  const sendTrackerChange = (change: TrackerChange): void => {
    trackerChangeSchema.parse(change);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("tracker:event", change);
    }
  };
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

  // 重开恢复编排（#13/spec H）：DB 中 status 非 disconnected 的结构化会话收养登记 disconnected（readHistory/resume 可续），PTY 统一断开
  await adoptRestoredSessions({ adapter, sessions, log: (k, d) => console.error(`[kanban:${k}] ${d}`) });

  // PTY 宿主装配：平台能力注入（shell/CLI exe 覆盖来自 config，不硬编码）；事件出站过 schema 校验并转发 renderer，
  // started/exit 顺带落 sessions 状态（PTY 活=空闲徽标，退出=已断开徽标）
  const sendTerminalEvent = (event: unknown): void => {
    terminalEventSchema.parse(event);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("terminal:event", event);
    }
  };
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
        sessions.updateStatus(terminalId, "idle");
        sendTerminalEvent({ terminalId, type: "started", ...payload });
      },
      data: (terminalId, data) => sendTerminalEvent({ terminalId, type: "data", data }),
      exit: (terminalId, payload) => {
        sessions.updateStatus(terminalId, "disconnected");
        sessions.touch(terminalId, new Date().toISOString());
        sendTerminalEvent({ terminalId, type: "exit", ...payload });
      },
      error: (terminalId, payload) => sendTerminalEvent({ terminalId, type: "error", message: payload.message }),
    },
  );

  // 统一退出序列（#13/spec H §6.1）：停新请求（IPC 拒新 + UI 提示）→ 有序取消 → 有限等待（config.shutdown.graceMs）→
  // Session 粒度受控终止 → 全量 dispose（worker shutdown/kill 兜底）→ PTY 全停；Job Object 覆盖强杀残留
  const shutdown = createShutdownOrchestrator({
    adapter,
    pty: ptyHost,
    sessions,
    graceMs: appConfig.shutdown.graceMs,
    // #32（spec #27 C 节）：退出序列第 7 步停止 memory 提取（running 批次 → cancelled；adapter/PTY 后、DB 关闭前）
    memory: memoryService,
    notifyShutdown: (reason) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("app:shutdown", shutdownNoticeSchema.parse({ reason }));
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (k, d) => console.error(`[kanban:${k}] ${d}`),
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
  };

  // 注册 IPC 处理器：app:getInfo 冒烟通道 + kanban:ipc 单通道路由（入站强制 zod 校验，spec E）
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
    }),
  );
  ipcMain.handle("kanban:ipc", (_event, raw: unknown) => handleIpc(deps, raw));
  // #31：memory:ipc 单通道（入站 zod 强制校验 + 业务拒绝 ok:false+reason，spec #27 H 节）
  ipcMain.handle("memory:ipc", (_event, raw: unknown) =>
    handleMemoryIpc({ memory: memoryService, isShuttingDown: () => shutdown.isShuttingDown() }, raw),
  );
  // #43：diff:ipc 单通道（spec #40 D 节；git exe 解析 = config gitExe 覆盖 → env → where，解析失败归 git-missing）
  // #47：三类截断上限来自 config.diff（采集字节/文件数/untracked 行数，超限置 truncated）
  ipcMain.handle("diff:ipc", (_event, raw: unknown) =>
    handleDiffIpc(
      {
        projects,
        readWorkspaceDiff: (cwd) => readWorkspaceDiff(cwd, defaultGitDiffDeps(appConfig.gitExe, appConfig.diff), appConfig.diff),
        isShuttingDown: () => shutdown.isShuttingDown(),
      },
      raw,
    ),
  );

  createWindow();
});

// Windows 优先：关窗即退出（before-quit 触发统一退出序列：停新请求→有序取消→有限等待→受控终止→PTY 停止，#13/spec H）
app.on("window-all-closed", () => {
  app.quit();
});
