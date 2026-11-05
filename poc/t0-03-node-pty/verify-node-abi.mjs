// Node ABI 冒烟：在纯 Node 运行时 require node-pty，spawn PowerShell 并断言输入回显，验证随包 prebuilt 在本机 Node ABI 可加载
import pty from 'node-pty';

const TOKEN = 'T0NODEABI';
const TIMEOUT_MS = 30000;
const startedAt = Date.now();

console.log(`runtime: node ${process.version} (modules ABI ${process.versions.modules})`);

const proc = pty.spawn('powershell.exe', ['-NoLogo', '-NoProfile'], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: { ...process.env, TERM: 'xterm-256color' },
});

let out = '';
let sawFirstData = false;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  console.error('---- pty output so far ----');
  console.error(JSON.stringify(out.slice(-800)));
  try { proc.kill(); } catch { /* 退出清理，忽略 */ }
  setTimeout(() => process.exit(1), 300);
};

// 基于 setTimeout 的等待：让出事件循环，保证 onData 回调能执行
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (pred, what) => {
  while (!pred()) {
    if (Date.now() - startedAt > TIMEOUT_MS) fail(`timeout waiting for ${what}`);
    await sleep(100);
  }
};

proc.onData((d) => {
  if (!sawFirstData) { sawFirstData = true; console.log('first pty data received (prompt)'); }
  out += d;
});
proc.onExit(({ exitCode }) => console.log(`pty exited code=${exitCode}`));

// 第一步：等 shell 出首个输出（提示符），证明 PTY 通道已建立
await waitUntil(() => sawFirstData, 'first pty data');

// 第二步：程序化发送输入，等待回显（ConPTY 下输入回显与命令输出都经 pty 流回）
proc.write(`echo ${TOKEN}\r`);
await waitUntil(() => out.includes(TOKEN), `echo of ${TOKEN}`);
console.log(`echo round-trip OK, output tail: ${JSON.stringify(out.slice(-160))}`);

// 第三步：干净退出 shell
proc.write('exit\r');
await waitUntil(() => out.includes('exit') || proc.exitCode !== undefined, 'shell exit');
console.log('PASS: node-pty prebuilt loads under pure Node and PTY echo round-trip works');
await sleep(400);
try { proc.kill(); } catch { /* 已退出则忽略 */ }
process.exit(0);
