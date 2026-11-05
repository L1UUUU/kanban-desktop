// 用途：Electron 主进程入口 —— 创建主窗口、注册 IPC 处理器（app:getInfo + kanban:ipc 路由）、CliHost 托管（utilityProcess 优先，进程内回退）与事件转发/状态落库、初始化应用配置与 SQLite（依赖方向：main → cli-host, tracker, ipc-schema，spec A）
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { adapterEventSchema, appInfoSchema } from "@kanban/ipc-schema";
import { AdapterRouter, createDesktopAdapterFactory, type CliAdapter } from "@kanban/cli-host";
import { TRACKER_PLACEHOLDER } from "@kanban/tracker";
import { defaultConfig, loadConfig, saveConfig, type AppConfig } from "./config";
import { CliHostClient } from "./cli-host-client";
import { SQLITE_ENTRY, openDatabase } from "./db";
import { handleIpc, type IpcDeps } from "./ipc";
import { ProjectStore } from "./project-store";
import { SessionStore } from "./session-store";

// 占位引用：确保依赖方向在构建图上成立（真实消费自阶段 2 接入）
void TRACKER_PLACEHOLDER;

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

// Adapter 门面：fake/codex 经 CliHost 分发（KANBAN_DISABLE_CODEX=1 时 codex 回落 Fake 演示模式）
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
  // 启动探测：全部项目目录存在性落库（missing 标记，工单 #7 验收第 1 条）
  projects.refreshStatuses();
  // CliHost 托管 adapter（utilityProcess 优先；config 手动覆盖 exe + env 开关在工厂内生效）
  adapter = createHostedAdapter(appConfig);
  app.on("quit", () => {
    db.close();
    // 有序停止：worker 内 shutdown（停新命令→dispose→有限等待）→ kill 兜底；Job Object 覆盖崩溃场景（spec H）
    void adapter.dispose();
  });

  const deps: IpcDeps = {
    adapter,
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
