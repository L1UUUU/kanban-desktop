// 冒烟 preload：contextBridge 暴露最小 terminalApi（spawn/write/onData/report），模拟正式应用的 IPC 边界
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('terminalApi', {
  spawn: () => ipcRenderer.invoke('pty-spawn'),
  write: (data) => ipcRenderer.send('pty:write', data),
  onData: (cb) => ipcRenderer.on('pty:data', (_e, d) => cb(d)),
  onExit: (cb) => ipcRenderer.on('pty:exit', (code) => cb(code)),
  report: (result) => ipcRenderer.send('smoke-result', result),
});
