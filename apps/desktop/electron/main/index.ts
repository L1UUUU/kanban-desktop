// 用途：Electron 主进程入口 —— 创建主窗口、注册 IPC 处理器（app:getInfo + kanban:ipc 路由）、FakeAdapter 事件转发、初始化应用配置与 SQLite（依赖方向：main → cli-host, tracker, ipc-schema，spec A）
import { app, BrowserWindow, ipcMain } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { adapterEventSchema, appInfoSchema } from "@kanban/ipc-schema";
import { FakeAdapter } from "@kanban/cli-host";
import { TRACKER_PLACEHOLDER } from "@kanban/tracker";
import { defaultConfig, loadConfig, saveConfig } from "./config";
import { SQLITE_ENTRY, openDatabase } from "./db";
import { handleIpc } from "./ipc";

// 占位引用：确保依赖方向在构建图上成立（真实消费自阶段 2 接入）
void TRACKER_PLACEHOLDER;

// FakeAdapter：#6 Fake 链路宿主（自建 SystemClock；真实三 CLI Adapter 自 #7/#9/#10 接入）
const adapter = new FakeAdapter();

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

/** 注册 IPC 处理器：app:getInfo 冒烟通道 + kanban:ipc 单通道路由（入站强制 zod 校验，spec E） */
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
  ipcMain.handle("kanban:ipc", (_event, raw: unknown) => handleIpc(adapter, raw));

  // Adapter 事件流 → renderer：出站也过 schema 校验（廉价，全量），窗口不在时静默丢弃
  adapter.subscribe((event) => {
    adapterEventSchema.parse(event);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("chat:event", event);
    }
  });
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
  app.on("quit", () => {
    db.close();
    // 有序停止：Fake 时钟停泵（真实 CLI 进程有序终止链路属 #10，spec H）
    void adapter.dispose();
  });

  registerIpc();
  createWindow();
});

// Windows 优先：关窗即退出（有序停止 CLI 进程的完整链路属后续工单，spec H）
app.on("window-all-closed", () => {
  app.quit();
});
