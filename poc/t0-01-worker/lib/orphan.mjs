// 用途：孤儿 CLI「先核对再接管」策略库 —— spawn 注册表 + CIM 进程发现 + 身份核对（exe 路径/命令行签名/创建时间防 pid 复用）+ 按可重连性分派的接管决策
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { queryByExe, alive } from "./procs.mjs";

// 注册表：记录本宿主 spawn 的全部 CLI 进程身份（宿主崩溃后重启的核对依据）
export class SpawnRegistry {
  constructor(file) {
    this.file = file;
    this.entries = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).entries : [];
  }
  record(entry) {
    this.entries.push({ createdAt: new Date().toISOString(), ...entry });
    this.#flush();
    return this.entries[this.entries.length - 1];
  }
  #flush() {
    writeFileSync(this.file, JSON.stringify({ entries: this.entries }, null, 2), "utf8");
  }
}

// 进程身份核对：返回与注册条目匹配的 CIM 记录，不匹配返回 {match:false}。
// 匹配条件（全部满足）：
//   1) pid 存活；2) ExecutablePath 与注册 exe 一致（大小写/斜杠归一）；
//   3) 命令行签名命中（如 opencode：含 "serve" 与 "--port <P>"）；
//   4) 进程创建时间与注册的 spawnAt 接近（±10s 容差，防 pid 复用：复用进程创建时间会显著晚于注册时刻之后的新生命周期）
export function verifyEntry(entry) {
  const norm = (p) => (p || "").toLowerCase().replace(/\//g, "\\");
  for (const proc of queryByExe(entry.exe)) {
    if (Number(proc.ProcessId) !== Number(entry.pid)) continue;
    const cmdline = proc.CommandLine || "";
    if (entry.cmdSignature && !entry.cmdSignature.every((s) => cmdline.includes(s))) continue;
    const created = new Date(proc.CreationDate).getTime();
    const spawnAt = new Date(entry.spawnAt ?? entry.createdAt).getTime();
    if (Math.abs(created - spawnAt) > 10000) continue; // 创建时间差过大 → pid 已被复用或非本进程
    return { match: true, pid: Number(proc.ProcessId), cmdline, createdMs: created, cim: proc };
  }
  return { match: false };
}

// 接管决策：可重连（HTTP server，如 opencode）→ 复用进程不重 spawn；不可重连（stdio，如 codex app-server）→ 受控终止后按原生历史 resume（不重放）
export function adoptDecision(entry) {
  const v = verifyEntry(entry);
  if (!v.match) {
    return { action: "none", reason: v.reason || "进程已退出或身份不匹配（pid 复用/命令行不符）", verify: v };
  }
  if (entry.reattachable === true) {
    return { action: "reattach", pid: entry.pid, reason: "HTTP server 可重连：直接复用，不重复 spawn、不产生新副作用", verify: v };
  }
  return { action: "terminate-then-resume", pid: entry.pid, reason: "stdio 进程无法重连 stdin/stdout：受控终止，随后按原生历史 resume（只读，不重放副作用）", verify: v };
}
