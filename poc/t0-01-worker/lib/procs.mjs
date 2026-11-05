// 用途：进程查询与终止工具 —— CIM/Win32_Process 枚举（pid/exe/命令行/创建时间）、存活检查、taskkill 强杀与树杀
import { spawnSync, spawn } from "node:child_process";

// 查询一组进程名（如 ["codex.exe","claude.exe"]）的 Win32_Process 记录（CreationDate 转 ISO，避免 PS DateTime JSON 序列化不可解析）
export function queryProcesses(names) {
  const filter = names.map((n) => `Name='${n}'`).join(" OR ");
  const ps = `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,Name,ExecutablePath,CommandLine,@{N='CreationDate';E={$_.CreationDate.ToString('o')}} | ConvertTo-Json -Compress`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`CIM query failed: ${r.stderr.slice(0, 300)}`);
  const raw = r.stdout.trim();
  if (!raw) return [];
  const arr = JSON.parse(raw);
  return Array.isArray(arr) ? arr : [arr];
}

// 按可执行文件路径查询（含路径大小写归一），exePath 为完整路径
export function queryByExe(exePath) {
  const name = exePath.split(/[\\/]/).pop();
  const norm = (p) => (p || "").toLowerCase().replace(/\//g, "\\");
  return queryProcesses([name]).filter((p) => norm(p.ExecutablePath) === norm(exePath));
}

// pid 存活检查（signal 0 探测；Windows 下等价 OpenProcess 探测）
export function alive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // 权限拒绝也说明进程存在
  }
}

// 批量存活快照
export function aliveMap(pids) {
  const m = {};
  for (const pid of pids) m[pid] = alive(pid);
  return m;
}

// taskkill /F 强杀单个 pid（同步；返回是否成功）
export function killPid(pid) {
  if (!alive(pid)) return true;
  const r = spawnSync("taskkill.exe", ["/F", "/PID", String(pid)], { encoding: "utf8" });
  return r.status === 0 || !alive(pid);
}

// taskkill /F /T 杀整棵进程树（同步）
export function killTree(pid) {
  if (!alive(pid)) return true;
  const r = spawnSync("taskkill.exe", ["/F", "/T", "/PID", String(pid)], { encoding: "utf8" });
  return r.status === 0 || !alive(pid);
}

// 异步 taskkill（测试脚本用，避免阻塞事件循环）
export function killPidAsync(pid) {
  return new Promise((resolve) => {
    if (!alive(pid)) return resolve(true);
    const p = spawn("taskkill.exe", ["/F", "/PID", String(pid)], { stdio: "ignore" });
    p.on("exit", () => resolve(!alive(pid)));
    p.on("error", () => resolve(!alive(pid)));
  });
}

// 等待 pid 消失（轮询；超时返回 false）
export async function waitGone(pid, timeoutMs = 10000, intervalMs = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return !alive(pid);
}

// 等待 pid 出现
export async function waitAlive(pid, timeoutMs = 10000, intervalMs = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (alive(pid)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return alive(pid);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
