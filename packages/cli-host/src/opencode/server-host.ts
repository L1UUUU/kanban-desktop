// 用途：OpenCode server-per-project 宿主 —— 项目 cwd 绑定的 server 复用/引用计数（最后一个会话释放才停）、孤儿 server 先核对再接管（t0-01 策略库 TS 演进）、端口分配与冲突重试、权限档位经 OPENCODE_CONFIG_CONTENT 注入（server 级共享）
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import type { PermMode } from "@kanban/ipc-schema";
import { resolveOpenCodeExe } from "./exe";
import { OpenCodeHttpServerClient, type OpenCodeServerClientLike } from "./client";

/** Adapter 消费的宿主面（生产 OpenCodeServerHost；测试注入 FakeHost） */
export interface OpenCodeServerHostLike {
  acquire(cwd: string, mode: PermMode | null, ownerKey: string): Promise<OpenCodeServerClientLike>;
  release(cwd: string, ownerKey: string): Promise<void>;
  /** C5 演进（#44）：运行中 server 的 pid 集合（server-per-project：同 project 一份；含接管的孤儿 server）；未实现的注入宿主按空集处理 */
  listChildPids?(): number[];
}

/** 权限三档 → OPENCODE_CONFIG_CONTENT.permission 注入（spec B OpenCode 列；full=原生默认 *:*:allow 不注入；key 仅用 poc-3/默认权限表实证过的 read/bash/edit） */
export const OPENCODE_PERM_CONFIG: Record<Exclude<PermMode, "full">, Record<string, string>> = {
  ask: { bash: "ask", edit: "ask", read: "ask" },
  auto: { bash: "ask", edit: "ask" },
};

/** spawn 注册表条目：宿主崩溃后重启的孤儿核对依据（t0-01 四要素：pid/exe/命令行签名/创建时间）；导出供残留检测复用（#49：核对通过的孤儿 server 不列残留） */
export interface RegistryEntry {
  cwd: string;
  exe: string;
  pid: number;
  port: number;
  spawnAt: string;
  cmdSignature: string[];
}

/** 运行中的项目 server（host 内部账本条目） */
interface ServerEntry {
  cwd: string;
  port: number;
  pid: number | null;
  mode: PermMode | null;
  client: OpenCodeServerClientLike;
  refs: Set<string>;
}

export interface OpenCodeServerHostOptions {
  /** config cliExe.opencode 手动覆盖（缺省探测链：原生安装 → npm 全局 → where） */
  exe?: string | null;
  /** 注册表落盘路径（缺省 <tmp>/kanban-opencode-servers.json；桌面场景应传 userData 目录实现跨重启接管） */
  registryPath?: string;
  /** 端口选择器（缺省 listen(0) 探测空闲端口；测试注入固定端口制造冲突） */
  portPicker?: () => Promise<number>;
  /** 端口冲突重试次数（缺省 3） */
  portRetries?: number;
  /** server 启动健康检查超时（缺省 30s） */
  startTimeoutMs?: number;
  /** e2e 隔离：XDG_* 重定向根（不设则用用户真实环境，provider 走用户全局配置只读加载） */
  xdgRoot?: string;
  /** OPENCODE_CONFIG_CONTENT 追加字段（e2e provider 只读注入等；permission 字段以档位注入为准） */
  extraConfig?: Record<string, unknown>;
  /** 诊断日志 */
  log?: (kind: string, detail: string) => void;
}

/** 路径比较键（win32 大小写不敏感 + 斜杠方向归一；宿主 cwd/exe 比对与残留检测候选比对共用，S3 归一） */
export function pathCompareKey(p: string): string {
  return p.toLowerCase().replace(/\//g, "\\");
}

/** 归一化 cwd 为注册表/复用键（在路径比较键基础上去尾部斜杠） */
function cwdKey(cwd: string): string {
  return pathCompareKey(cwd).replace(/\\+$/, "");
}

/** 注册表文件读取（文件缺失/损坏时空表；宿主生命周期与残留检测共用同一语义，S3 归一） */
export function readServerRegistry(registryPath: string): RegistryEntry[] {
  if (!existsSync(registryPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(registryPath, "utf8")) as { entries?: RegistryEntry[] };
    return Array.isArray(raw.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}

/** 找一个空闲端口（listen(0) 即时释放；存在被抢占竞态，由 spawn 后健康检查+重试兜底） */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Win32_Process CIM 记录（CreationDate 已转 ISO） */
interface CimRecord {
  ProcessId: number;
  ExecutablePath: string | null;
  CommandLine: string | null;
  CreationDate: string | null;
}

/** 按 exe 名查询 CIM 进程记录（PS 5.1 兼容：CreationDate ToString('o') 转 ISO，t0-01 发现 8） */
function queryCimByName(exePath: string): CimRecord[] {
  const name = exePath.split(/[\\/]/).pop();
  const ps = `Get-CimInstance Win32_Process -Filter "Name='${name}'" | Select-Object ProcessId,ExecutablePath,CommandLine,@{N='CreationDate';E={$_.CreationDate.ToString('o')}} | ConvertTo-Json -Compress`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) return [];
  try {
    const raw = JSON.parse(r.stdout.trim());
    return Array.isArray(raw) ? raw : [raw];
  } catch {
    return [];
  }
}

/** pid 存活探测（signal 0；EPERM 也说明存在） */
function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 孤儿身份核对（t0-01 verifyEntry 演进）：pid 存活 + exe 路径一致 + 命令行签名 + 创建时间 ±10s 防 pid 复用；非 win32 退化为 pid 存活 + 无 CIM */
export function verifyRegistryEntry(entry: RegistryEntry): { match: boolean; reason?: string } {
  if (!pidAlive(entry.pid)) return { match: false, reason: "pid 已退出" };
  if (process.platform !== "win32") return { match: true };
  for (const proc of queryCimByName(entry.exe)) {
    if (Number(proc.ProcessId) !== Number(entry.pid)) continue;
    if (pathCompareKey(proc.ExecutablePath ?? "") !== pathCompareKey(entry.exe)) continue;
    const cmdline = proc.CommandLine ?? "";
    if (!entry.cmdSignature.every((s) => cmdline.includes(s))) continue;
    const created = proc.CreationDate ? new Date(proc.CreationDate).getTime() : NaN;
    const spawnAt = new Date(entry.spawnAt).getTime();
    if (!Number.isFinite(created) || Math.abs(created - spawnAt) > 10_000) continue;
    return { match: true };
  }
  return { match: false, reason: "CIM 身份不匹配（exe/命令行/创建时间）" };
}

/**
 * server-per-project 宿主。生命周期：
 * acquire(cwd, mode, ownerKey) → 命中运行 server 直接复用；孤儿（注册表核对通过且 HTTP 可达）接管不重复 spawn；
 * 否则 spawn（端口冲突→换端口重试→明确报错）。
 * release(cwd, ownerKey) → 引用计数；归零才停 server 并移除注册表条目。
 * 档位为 server 级：同项目运行中复用现有档位；空闲（无会话引用）时按新档位重启生效。
 */
export class OpenCodeServerHost implements OpenCodeServerHostLike {
  private readonly servers = new Map<string, ServerEntry>();
  private readonly registryPath: string;
  private readonly portPicker: () => Promise<number>;
  private readonly portRetries: number;
  private readonly startTimeoutMs: number;
  private readonly log: (kind: string, detail: string) => void;
  private readonly manualExe: string | null;
  private readonly xdgRoot: string | undefined;
  private readonly extraConfig: Record<string, unknown> | undefined;
  private exeCache: string | null = null;

  constructor(options: OpenCodeServerHostOptions = {}) {
    this.manualExe = options.exe ?? null;
    this.registryPath = options.registryPath ?? path.join(tmpdir(), "kanban-opencode-servers.json");
    this.portPicker = options.portPicker ?? freePort;
    this.portRetries = options.portRetries ?? 3;
    this.startTimeoutMs = options.startTimeoutMs ?? 30_000;
    this.xdgRoot = options.xdgRoot;
    this.extraConfig = options.extraConfig;
    this.log = options.log ?? (() => {});
  }

  async acquire(cwd: string, mode: PermMode | null, ownerKey: string): Promise<OpenCodeServerClientLike> {
    const key = cwdKey(cwd);
    const existing = this.servers.get(key);
    if (existing && !existing.client.dead) {
      existing.refs.add(ownerKey);
      if (mode !== null && existing.mode !== mode) {
        // 档位 server 级共享（spec B）：运行中不重启；空闲释放后下次 acquire 按新档位重启
        this.log("perm-mode-shared", `cwd=${cwd} server 档位=${existing.mode}，请求档位=${mode}（同项目共享，待空闲后新档位生效）`);
      }
      return existing.client;
    }
    if (existing) {
      // 死亡条目残留：清理后走全新获取
      this.servers.delete(key);
      this.removeRegistry(key);
    }
    // 孤儿接管：先核对再接管（不重复 spawn、不产生新副作用）
    const adopted = await this.tryAdopt(key, cwd, mode, ownerKey);
    if (adopted) return adopted;
    // 全新 spawn（端口冲突重试）
    return this.spawnServer(key, cwd, mode, ownerKey);
  }

  async release(cwd: string, ownerKey: string): Promise<void> {
    const key = cwdKey(cwd);
    const entry = this.servers.get(key);
    if (!entry) return;
    entry.refs.delete(ownerKey);
    if (entry.refs.size > 0) return; // 还有会话引用：server 保留（最后一个会话释放才停）
    this.servers.delete(key);
    this.removeRegistry(key);
    if (entry.client.dead) return;
    // 等真实退出（≤3s 兜底）：保证 release 返回时 session_exit 已入事件流（与 Claude dispose 同语义）
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      entry.client.onDead(() => {
        clearTimeout(timer);
        resolve();
      });
      entry.client.stop(); // 我方 spawn：kill；接管进程：taskkill 按 pid（数据 turn 级落盘无损，poc-3 §8）
    });
    this.log("server-stop", `cwd=${cwd} port=${entry.port}（最后一个会话已释放）`);
  }

  /** 模拟宿主崩溃：遗弃 server（不停止进程、保留注册表条目）供孤儿接管用例与真实崩溃恢复复用 */
  abandon(cwd: string): void {
    this.servers.delete(cwdKey(cwd));
  }

  /** 全局停机：停全部 server 并等待实际退出（≤3s 兜底） */
  async shutdown(): Promise<void> {
    const entries = [...this.servers.values()];
    this.log("shutdown", `entries=${entries.map((e) => `${e.cwd}@${e.port} refs=${e.refs.size} dead=${e.client.dead}`).join(" | ") || "(空)"}`);
    this.servers.clear();
    for (const entry of entries) this.removeRegistry(cwdKey(entry.cwd));
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.client.dead) return;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3000);
          entry.client.onDead(() => {
            clearTimeout(timer);
            resolve();
          });
          entry.client.stop();
        });
      }),
    );
  }

  /** 内部观察口：运行中的 server 条目快照（e2e 断言复用/接管用） */
  inspect(): Array<{ cwd: string; port: number; pid: number | null; mode: PermMode | null; refs: number }> {
    return [...this.servers.values()].map((e) => ({ cwd: e.cwd, port: e.port, pid: e.pid, mode: e.mode, refs: e.refs.size }));
  }

  /** C5 演进（#44）：运行中 server 的 pid 去重集合（server-per-project：同 project 一份；含接管的孤儿 server——已受本应用管理不属残留） */
  listChildPids(): number[] {
    const pids = new Set<number>();
    for (const e of this.servers.values()) if (e.pid) pids.add(e.pid);
    return [...pids];
  }

  /* ---------------- 内部：孤儿接管与 spawn ---------------- */

  /** 注册表读取（文件缺失/损坏时空表；委托共享实现，残留检测同语义复用，S3 归一） */
  private readRegistry(): RegistryEntry[] {
    return readServerRegistry(this.registryPath);
  }

  private writeRegistry(entries: RegistryEntry[]): void {
    try {
      mkdirSync(path.dirname(this.registryPath), { recursive: true });
      writeFileSync(this.registryPath, `${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
    } catch (e) {
      this.log("registry-write", e instanceof Error ? e.message : String(e)); // 落盘失败不阻断生命周期（接管降级为重新 spawn）
    }
  }

  private removeRegistry(key: string): void {
    const rest = this.readRegistry().filter((e) => cwdKey(e.cwd) !== key);
    this.writeRegistry(rest);
  }

  /** 孤儿接管：核对（exe+签名+创建时间）+ HTTP 可达 → 复用原 server（reattachable，t0-01 T4-A） */
  private async tryAdopt(key: string, cwd: string, mode: PermMode | null, ownerKey: string): Promise<OpenCodeServerClientLike | null> {
    const candidates = this.readRegistry().filter((e) => cwdKey(e.cwd) === key);
    for (const entry of candidates) {
      const v = verifyRegistryEntry(entry);
      if (!v.match) {
        this.log("orphan-reject", `cwd=${cwd} pid=${entry.pid}：${v.reason ?? "身份不匹配"}`);
        continue;
      }
      // HTTP 可重连才接管（HTTP server 特性；不可达则核对通过也不接管，走新 spawn）
      const client = new OpenCodeHttpServerClient({ port: entry.port, pid: entry.pid, log: this.log });
      const healthy = await (async () => {
        try {
          return (await client.api("GET", "/config")).ok;
        } catch {
          return false;
        }
      })();
      if (!healthy) {
        this.log("orphan-unreachable", `cwd=${cwd} pid=${entry.pid} port=${entry.port}：HTTP 不可达，不接管`);
        client.stop();
        continue;
      }
      this.wireEntry(client, key, cwd, entry.port, entry.pid, mode, ownerKey);
      this.log("orphan-adopt", `cwd=${cwd} pid=${entry.pid} port=${entry.port}（复用，未重复 spawn）`);
      return client;
    }
    void mode;
    return null;
  }

  /** 全新 spawn：端口选择→健康等待；端口被占（进程秒退/健康超时）→换端口重试→耗尽明确报错 */
  private async spawnServer(key: string, cwd: string, mode: PermMode | null, ownerKey: string): Promise<OpenCodeServerClientLike> {
    const exe = this.resolveExe();
    let lastError = "";
    for (let attempt = 1; attempt <= Math.max(1, this.portRetries); attempt += 1) {
      const port = await this.portPicker();
      if (!port || port <= 0) {
        throw new Error(`OpenCode server 端口选择失败（portPicker 返回 ${port}）`);
      }
      const proc = spawn(
        exe,
        ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--print-logs", "--log-level", "INFO"],
        { cwd, env: this.serverEnv(mode), stdio: ["ignore", "ignore", "pipe"], detached: false, windowsHide: true },
      );
      proc.stderr?.setEncoding("utf8");
      proc.stderr?.on("data", (d: string) => this.log("server-stderr", d.trimEnd().slice(0, 300)));
      const client = new OpenCodeHttpServerClient({ port, proc, log: this.log });
      const spawnAt = new Date().toISOString();
      const healthy = await this.waitHealthy(client, proc);
      if (healthy) {
        const entry: RegistryEntry = {
          cwd,
          exe,
          pid: proc.pid ?? 0,
          port,
          spawnAt,
          cmdSignature: ["serve", `--port ${port}`],
        };
        this.writeRegistry([...this.readRegistry().filter((e) => cwdKey(e.cwd) !== key), entry]);
        this.wireEntry(client, key, cwd, port, proc.pid ?? null, mode, ownerKey);
        this.log("server-start", `cwd=${cwd} pid=${proc.pid} port=${port} mode=${mode ?? "(原生默认)"} attempt=${attempt}`);
        return client;
      }
      lastError = `port=${port} 健康检查失败（进程 ${proc.exitCode === null ? "仍在运行但不响应" : `已退出 code=${proc.exitCode}`}）`;
      client.stop();
      try {
        proc.kill();
      } catch {
        /* 已退出 */
      }
      this.log("port-retry", `cwd=${cwd} ${lastError}（第 ${attempt} 次尝试）`);
    }
    throw new Error(`OpenCode server 启动失败：端口冲突或启动异常，已重试 ${this.portRetries} 次（${lastError}）。请检查 opencode 安装或指定其他端口。`);
  }

  /** 登记运行条目并挂接死亡清理（client 死亡 → 移除条目，下次 acquire 重新获取） */
  private wireEntry(client: OpenCodeServerClientLike, key: string, cwd: string, port: number, pid: number | null, mode: PermMode | null, ownerKey: string): void {
    const entry: ServerEntry = { cwd, port, pid, mode, client, refs: new Set([ownerKey]) };
    this.servers.set(key, entry);
    client.onDead(() => {
      const cur = this.servers.get(key);
      if (cur === entry) this.servers.delete(key); // 注册表条目保留（pid 已死核对不过，等下次 acquire 覆写）
      this.log("server-dead", `cwd=${cwd} port=${port}（条目${cur === entry ? "已移除" : "已被替换"}）`);
    });
  }

  /** 等待 /config 可达（或进程退出/启动失败判失败） */
  private async waitHealthy(client: OpenCodeHttpServerClient, proc: ChildProcess): Promise<boolean> {
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      if (client.dead || proc.exitCode !== null || !proc.pid) return false;
      try {
        if ((await client.api("GET", "/config")).ok) return true;
      } catch {
        /* 尚未就绪 */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }

  /** server 进程 env：OPENCODE_CONFIG_CONTENT 注入权限档位（最高优先级字段覆盖，不阻断用户全局/项目配置加载——provider 走用户配置只读加载）；可选 XDG 隔离（e2e） */
  private serverEnv(mode: PermMode | null): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.OPENCODE_CONFIG;
    const content: Record<string, unknown> = { ...this.extraConfig };
    if (mode && mode !== "full") content.permission = OPENCODE_PERM_CONFIG[mode];
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(content);
    if (this.xdgRoot) {
      env.XDG_CONFIG_HOME = path.join(this.xdgRoot, "config");
      env.XDG_DATA_HOME = path.join(this.xdgRoot, "data");
      env.XDG_STATE_HOME = path.join(this.xdgRoot, "data", "state");
      env.XDG_CACHE_HOME = path.join(this.xdgRoot, "data", "cache");
    }
    return env;
  }

  private resolveExe(): string {
    if (this.exeCache) return this.exeCache;
    const exe = resolveOpenCodeExe({ manualOverride: this.manualExe });
    this.exeCache = exe;
    return exe;
  }
}
