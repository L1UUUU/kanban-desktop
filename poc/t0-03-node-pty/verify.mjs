// 验证编排器：依次跑 Node ABI 冒烟与 Electron 42 窗口冒烟，汇总 PASS/FAIL 并以退出码反映结果
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
// Windows 下直接调 electron.exe（Node 20+ 不允许无 shell 执行 .cmd）
const electronBin = process.platform === 'win32'
  ? path.join(dir, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(dir, 'node_modules', '.bin', 'electron');
const steps = [
  { name: 'node-abi-smoke', cmd: process.execPath, args: ['verify-node-abi.mjs'] },
  { name: 'electron-window-smoke', cmd: electronBin, args: ['smoke-main.js'] },
];

const results = [];
for (const step of steps) {
  console.log(`\n=== STEP ${step.name} ===`);
  const r = spawnSync(step.cmd, step.args, { cwd: dir, stdio: 'inherit', timeout: 120000, shell: false });
  const ok = r.status === 0;
  results.push({ name: step.name, ok, status: r.status, error: r.error ? String(r.error) : null });
  console.log(`--- ${step.name}: ${ok ? 'PASS' : 'FAIL'} (exit=${r.status}${r.error ? ' err=' + r.error : ''})`);
}

console.log('\n===== T0-03 SUMMARY =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
const allPass = results.every(r => r.ok);
console.log(`OVERALL: ${allPass ? 'PASS' : 'FAIL'}`);
process.exit(allPass ? 0 : 1);
