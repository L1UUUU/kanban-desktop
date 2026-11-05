// 用途：Electron 主进程入口 —— 创建主窗口、注册 IPC 处理器、初始化应用配置与 SQLite（依赖方向：main → cli-host, tracker, ipc-schema，spec A）
import { app, BrowserWindow, ipcMain } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appInfoSchema } from "@kanban/ipc-schema";
import { CLI_HOST_PLACEHOLDER } from "@kanban/cli-host";
import { TRACKER_PLACEHOLDER } from "@kanban/tracker";
import { defaultConfig, loadConfig, saveConfig } from "./config";
import { SQLITE_ENTRY, openDatabase } from "./db";

// 占位引用：确保依赖方向在构建图上成立（真实消费自 #6/阶段 2 接入）
void CLI_HOST_PLACEHOLDER;
void TRACKER_PLACEHOLDER;

let mainWindow: BrowserWindow | null = null;

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

/** 注册 IPC 处理器（本工单仅 app:getInfo 冒烟通道；入站校验按 spec E 自 #6 扩充） */
function registerIpc(): void {
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
}

app.whenReady().then(() => {
  // 配置初始化：首次运行生成默认配置文件（三 CLI exe 探测占位，spec J：不硬编码、落应用数据目录）
  const configPath = join(app.getPath("userData"), "config.json");
  if (!existsSync(configPath)) {
    saveConfig(configPath, defaultConfig());
  } else {
    loadConfig(configPath); // 校验可读性；损坏内容按默认值忽略
  }

  // SQLite：打开应用数据目录下的数据库并按 C3 建五表（D2 冒烟已验证 node:sqlite 在 Electron 44 主进程可用）
  const db = openDatabase(join(app.getPath("userData"), "kanban.db"));
  app.on("quit", () => db.close());

  registerIpc();
  createWindow();
});

// Windows 优先：关窗即退出（有序停止 CLI 进程的完整链路属后续工单，spec H）
app.on("window-all-closed", () => {
  app.quit();
});
