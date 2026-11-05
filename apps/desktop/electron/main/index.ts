// 用途：Electron 主进程入口 —— 创建主窗口、注册 IPC 处理器（app:getInfo + kanban:ipc 路由）、FakeAdapter 事件转发与会话状态落库、PTY 终端宿主（node-pty，main 进程直接使用，t0-03 实证）与有序退出、初始化应用配置与 SQLite（依赖方向：main → cli-host, tracker, ipc-schema，spec A）
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as nodePty from "node-pty";
import { adapterEventSchema, appInfoSchema, terminalEventSchema } from "@kanban/ipc-schema";
import { FakeAdapter } from "@kanban/cli-host";
import { TRACKER_PLACEHOLDER } from "@kanban/tracker";
import { defaultConfig, loadConfig, saveConfig, type AppConfig } from "./config";
import { SQLITE_ENTRY, openDatabase } from "./db";
import { handleIpc, type IpcDeps } from "./ipc";
import { createPtyHost } from "./pty-host";
import { ProjectStore } from "./project-store";
import { SessionStore } from "./session-store";

// 占位引用：确保依赖方向在构建图上成立（真实消费自阶段 2 接入）
void TRACKER_PLACEHOLDER;

// FakeAdapter：#6 Fake 链路宿主（自建 SystemClock；真实三 CLI Adapter 自 #8/#10/#11 接入）
const adapter = new FakeAdapter();

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
  // 启动探测：全部项目目录存在性落库（missing 标记，工单 #7 验收第 1 条）
  projects.refreshStatuses();
  app.on("quit", () => {
    db.close();
    // 有序停止：Fake 时钟停泵（真实 CLI 进程有序终止链路属 #10，spec H）
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

  // Adapter 事件流 → renderer：出站也过 schema 校验（廉价，全量），窗口不在时静默丢弃；
  // session_status/turn_started 顺带落库（sessions.status 与 last_active_at 随运行更新）
  adapter.subscribe((event) => {
    adapterEventSchema.parse(event);
    if ("type" in event) {
      if (event.type === "session_status") sessions.updateStatus(event.sessionId, event.status);
      else if (event.type === "turn_started") sessions.touch(event.sessionId, new Date().toISOString());
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("chat:event", event);
    }
  });

  createWindow();
});

// Windows 优先：关窗即退出（有序停止 CLI 进程的完整链路属后续工单，spec H）
app.on("window-all-closed", () => {
  app.quit();
});
