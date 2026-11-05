// 用途：Electron 主进程入口 —— 创建主窗口、注册 IPC 处理器（app:getInfo + kanban:ipc 路由）、CliHost 托管（utilityProcess 优先，进程内回退）与事件转发/状态落库、TrackerEngine（SkillObservation 落库 + 重启恢复）、PTY 终端宿主（node-pty，main 进程直接使用，t0-03 实证）和有序退出、初始化应用配置与 SQLite（依赖方向：main → cli-host, tracker, ipc-schema，spec A）
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as nodePty from "node-pty";
import { appInfoSchema, terminalEventSchema } from "@kanban/ipc-schema";
import { AdapterRouter, createDesktopAdapterFactory, type CliAdapter } from "@kanban/cli-host";
import { TrackerEngine } from "@kanban/tracker";
import { defaultConfig, loadConfig, saveConfig, type AppConfig } from "./config";
import { createAdapterEventHandler } from "./adapter-events";
import { CliHostClient } from "./cli-host-client";
import { SQLITE_ENTRY, openDatabase } from "./db";
import { handleIpc, type IpcDeps } from "./ipc";
import { createPtyHost } from "./pty-host";
import { ProjectStore } from "./project-store";
import { SessionStore } from "./session-store";

/** CliHost 托管形态（ADR-0001：utilityProcess 崩溃隔离 + Job Object）；worker 产物缺失/fork 失败回退 Main 进程内（C5 降级路径，seam 不变） */
function createHostedAdapter(appConfig: AppConfig): CliAdapter {
  const dataDir = app.getPath("userData");
  const workerPath = join(__dirname, "cli-host-worker.js");
  if (existsSync(workerPath)) {
    try {
      return new CliHostClient({ workerPath, dataDir, codexExe: appConfig.cliExe.codex });
    } catch (e) {
      console.error(`[cli-host] utilityProcess 托管不可用，回退进程内：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return new AdapterRouter(
    createDesktopAdapterFactory({ codexExe: appConfig.cliExe.codex, cacheDir: dataDir, log: (k, d) => console.error(`[cli-host:${k}] ${d}`) }),
  );
}

// Adapter 门面：fake/codex 经 CliHost 分发（utilityProcess 托管；KANBAN_DISABLE_CODEX=1 时 codex 回落 Fake 演示模式）
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

app.whenReady().then(() => {
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
  adapter = createHostedAdapter(appConfig);
  app.on("quit", () => {
    trackerEngine.close(); // 关闭 engine 与底层 DB 连接（唯一关闭点）
    // 有序停止：worker 内 shutdown（停新命令→dispose→有限等待）→ kill 兜底；Job Object 覆盖崩溃场景（spec H）
    void adapter.dispose();
  });

  // 应用退出前有序停止全部 PTY（#13 退出治理的 PTY 部分：killAll 幂等；#8 的 Job Object 属 cli-host 侧）
  app.on("before-quit", () => {
    ptyHost.killAll();
  });

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

  const deps: IpcDeps = {
    adapter,
    // PTY 宿主：node-pty 在 main 进程直接使用（main → ConPTY；utilityProcess 是 cli-host 的形态，spec F）
    pty: ptyHost,
    projects,
    sessions,
    pickDirectory,
    getCurrentProjectId: () => appConfig.currentProjectId,
    setCurrentProjectId: (id) => {
      appConfig.currentProjectId = id;
      saveConfig(configPath, appConfig);
    },
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
    }),
  );
  ipcMain.handle("kanban:ipc", (_event, raw: unknown) => handleIpc(deps, raw));

  // Adapter 事件流：出站校验 + 会话状态落库 + SkillObservation 进 tracker 落库（#9）→ 转发 renderer；窗口不在时静默丢弃转发
  adapter.subscribe(
    createAdapterEventHandler({
      sessions,
      engine: trackerEngine,
      send: (event) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("chat:event", event);
        }
      },
    }),
  );

  createWindow();
});

// Windows 优先：关窗即退出（有序停止 CLI 进程的完整链路属后续工单，spec H）
app.on("window-all-closed", () => {
  app.quit();
});
