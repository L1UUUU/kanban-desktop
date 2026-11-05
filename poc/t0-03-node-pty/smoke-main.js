// Electron 42 冒烟主进程：BrowserWindow + node-pty spawn PowerShell，转发 PTY 数据到渲染进程，回收断言结果并截图存证
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const pty = require('node-pty');

const DIR = __dirname;
const EVIDENCE_DIR = path.join(DIR, 'evidence');
const TIMEOUT_MS = 60000;

let win = null;
let ptyProc = null;
let finished = false;

// 统一收口：写结果 JSON、清理 PTY、按 PASS/FAIL 退出
function finish(result) {
  if (finished) return;
  finished = true;
  result.pass = result.pass === true;
  console.log(`finish: ${result.pass ? 'PASS' : 'FAIL'} reason=${result.reason ?? 'renderer assertions'}`);
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'electron-smoke-result.json'), JSON.stringify(result, null, 2));
  const shot = () => {
    try {
      const img = win.webContents.capturePage();
      // capturePage 返回 Promise<NativeImage>（Electron 42）
      Promise.resolve(img).then((native) => {
        fs.writeFileSync(path.join(EVIDENCE_DIR, 'electron-smoke.png'), native.toPNG());
        app.exit(result.pass ? 0 : 1);
      }).catch(() => app.exit(result.pass ? 0 : 1));
    } catch { app.exit(result.pass ? 0 : 1); }
  };
  if (win && !win.isDestroyed()) shot(); else app.exit(result.pass ? 0 : 1);
}

ipcMain.handle('pty-spawn', () => {
  if (ptyProc) return { ok: true, already: true };
  ptyProc = pty.spawn('powershell.exe', ['-NoLogo', '-NoProfile'], {
    name: 'Windows PowerShell',
    cols: 80,
    rows: 24,
    cwd: DIR,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  ptyProc.onData((d) => { if (win && !win.isDestroyed()) win.webContents.send('pty:data', d); });
  ptyProc.onExit(({ exitCode }) => {
    if (win && !win.isDestroyed()) win.webContents.send('pty:exit', exitCode);
  });
  return { ok: true, pid: ptyProc.pid };
});

ipcMain.on('pty:write', (_e, data) => { if (ptyProc) ptyProc.write(data); });

ipcMain.on('smoke-result', (_e, result) => {
  console.log(`renderer result: ${JSON.stringify(result)}`);
  setTimeout(() => finish(result), 600); // 留出最后一屏渲染时间再截图
});

app.whenReady().then(() => {
  console.log(`electron ${process.versions.electron} / node ${process.versions.node} (modules ABI ${process.versions.modules}) / chrome ${process.versions.chrome}`);
  win = new BrowserWindow({
    width: 900,
    height: 560,
    show: true,
    webPreferences: {
      preload: path.join(DIR, 'smoke-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('smoke-renderer.html');
  setTimeout(() => finish({ pass: false, reason: `timeout after ${TIMEOUT_MS}ms` }), TIMEOUT_MS);
});

app.on('window-all-closed', () => {
  if (!finished) finish({ pass: false, reason: 'window closed before smoke completed' });
  app.exit(finished ? 0 : 1);
});
