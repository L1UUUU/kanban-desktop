// 用途：残留进程治理 Main 服务（#49 spec #40 A/F 节）—— detectResidue（CIM 进程枚举 + exe 匹配三 CLI 解析链候选并集 + 排除本应用活跃集合 + 排除注册表核对通过可接管的 OpenCode 孤儿 server + best-effort 会话归属）与 killResidue（逐 pid 确认式终止，killed/failed 逐个回报）；全部外部探测经依赖注入，无任何自动清理路径
import { spawnSync } from "node:child_process";
import { pathCompareKey, readServerRegistry, verifyRegistryEntry, type RegistryEntry } from "@kanban/cli-host";
import type { ResidueKillResult, ResidueProcess } from "@kanban/ipc-schema";
import type { SessionRecord } from "./session-store";

/** CIM 进程记录（queryProcesses 返回形状；CreationDate 已转 ISO） */
export interface CimProcessRecord {
  pid: number;
  exePath: string;
  commandLine: string | null;
  startedAt: string | null;
}

/** 三 CLI 候选并集（键为应用侧 cli 名；值为该 CLI 解析链全量候选路径） */
export type CliExeCandidateSets = { codex: string[]; claude: string[]; opencode: string[] };

/** 残留服务依赖（全部注入：候选集来自 cli-host listXxxExeCandidates、活跃集合来自 CliHostClient.listChildPids、会话来自 SessionStore） */
export interface ResidueServiceDeps {
  /** 三 CLI 解析链候选路径并集（exe 匹配粒度，spec F 节） */
  listCandidates(): CliExeCandidateSets;
  /** 按 exe 名枚举进程（缺省 CIM Win32_Process；测试注入 fake 清单） */
  queryProcesses?(exeNames: string[]): CimProcessRecord[];
  /** 本应用活跃 CLI 子进程 pid 集合（#44 listChildPids；已受管理不属残留） */
  listActivePids(): Promise<number[]>;
  /** OpenCode server 注册表路径（<userData>/opencode-servers.json） */
  registryPath: string;
  /** 注册表条目核对（缺省复用 server-host verifyRegistryEntry 的 match 布尔：pid 存活 + CIM 四要素；测试注入） */
  verifyRegistry?(entry: RegistryEntry): boolean;
  /** 会话记录（关联会话记录归属查询；按 created_at 倒序传入） */
  listSessions(): SessionRecord[];
  /** 单 pid 终止（缺省 taskkill /F；测试注入）；detectResidue 永不调用 */
  killPid?(pid: number): { ok: boolean; error?: string };
}

/**
 * 检测疑似残留 CLI 进程：候选并集匹配 → 排除活跃集合 → 排除可接管 OpenCode server → 会话归属。
 * 只读不终止（确认式：清理仅经 killResidue 由用户显式触发）。
 */
export async function detectResidue(deps: ResidueServiceDeps): Promise<ResidueProcess[]> {
  const candidates = deps.listCandidates();
  // exe 名 → 命中该名的 CLI 集合（CIM 按 Name 过滤，多 CLI 同名 exe 不存在但结构上允许）
  const byName = new Map<string, Array<"codex" | "claude" | "opencode">>();
  for (const kind of ["codex", "claude", "opencode"] as const) {
    for (const exe of candidates[kind]) {
      const name = exe.split(/[\\/]/).pop() ?? "";
      if (!name) continue;
      const list = byName.get(name) ?? [];
      if (!list.includes(kind)) list.push(kind);
      byName.set(name, list);
    }
  }
  const procs = (deps.queryProcesses ?? queryCimByNames)([...byName.keys()]);
  const activePids = new Set(await deps.listActivePids());
  // 可接管 OpenCode 孤儿：注册表核对通过（恢复会话时 tryAdopt 自动接管，不列残留，spec US22/F16）；读取复用 server-host readServerRegistry（S3）
  const registry = readServerRegistry(deps.registryPath);
  const verifiedPids = new Set<number>();
  for (const entry of registry) {
    // 默认适配取 .match：verifyRegistryEntry 返回 {match, reason} 对象恒 truthy，直接当布尔用会把核对不通过的孤儿也排除（P1）
    const verify = deps.verifyRegistry ?? ((e) => verifyRegistryEntry(e).match);
    if (verify(entry)) verifiedPids.add(entry.pid);
  }
  const registryByPid = new Map<number, RegistryEntry>(registry.map((e) => [e.pid, e]));
  // 候选路径 → CLI 归属查找表
  const candidateKind = new Map<string, "codex" | "claude" | "opencode">();
  for (const kind of ["codex", "claude", "opencode"] as const) {
    for (const exe of candidates[kind]) candidateKind.set(pathCompareKey(exe), kind);
  }
  const sessions = deps.listSessions();
  const out: ResidueProcess[] = [];
  for (const p of procs) {
    const kind = candidateKind.get(pathCompareKey(p.exePath));
    if (!kind) continue; // 候选外 exe：不属本应用 CLI 生态
    if (activePids.has(p.pid)) continue; // 本应用活跃集合（#44）
    if (verifiedPids.has(p.pid)) continue; // 可接管 OpenCode 孤儿 server
    const { sessionTitle, suspectedSessionTitle } = associateSession(kind, p, registryByPid, sessions);
    out.push({ pid: p.pid, exePath: p.exePath, startedAt: p.startedAt, sessionTitle, suspectedSessionTitle });
  }
  out.sort((a, b) => a.pid - b.pid); // 确定性输出（按 pid 升序）
  return out;
}

/**
 * 确认式逐 pid 终止：每 pid 独立回报 killed/failed（单点失败不影响其余）。
 * 仅由用户在通知条勾选并点「清理选中」触发（residue:kill），无任何自动调用路径。
 */
export async function killResidue(deps: ResidueServiceDeps, pids: number[]): Promise<ResidueKillResult[]> {
  const results: ResidueKillResult[] = [];
  for (const pid of pids) {
    const r = (deps.killPid ?? taskkillPid)(pid);
    results.push(r.ok ? { pid, status: "killed" } : { pid, status: "failed", error: r.error ?? "终止失败" });
  }
  return results;
}

/**
 * best-effort 会话归属（P2：仅精确匹配进 sessionTitle，回落不得触发默认勾选）：
 * claude 按命令行 nativeSessionId 精确匹配 / opencode 按注册表 pid→cwd 匹配 → sessionTitle（UI 默认勾选依据）；
 * 同 CLI 最近会话回落 → 仅 suspectedSessionTitle「疑似」提示（不参与默认勾选）；均无 → 双 null（「无会话记录」）。
 */
function associateSession(
  kind: "codex" | "claude" | "opencode",
  proc: CimProcessRecord,
  registryByPid: Map<number, RegistryEntry>,
  sessions: SessionRecord[],
): { sessionTitle: string | null; suspectedSessionTitle: string | null } {
  const structured = sessions.filter((s) => s.kind === "structured" && s.cli === kind);
  if (kind === "claude" && proc.commandLine) {
    const hit = structured.find((s) => s.nativeSessionId && proc.commandLine!.includes(s.nativeSessionId));
    if (hit?.title) return { sessionTitle: hit.title, suspectedSessionTitle: null };
  }
  if (kind === "opencode") {
    const entry = registryByPid.get(proc.pid);
    if (entry) {
      const hit = structured.find((s) => s.cwd && pathCompareKey(s.cwd) === pathCompareKey(entry.cwd));
      if (hit?.title) return { sessionTitle: hit.title, suspectedSessionTitle: null };
    }
  }
  // 回落：同 CLI 最近一条会话（列表按 created_at 倒序传入）——非精确匹配，只作「疑似」提示，不进 sessionTitle（防误杀默认勾选，见已知限制文档）
  const recent = structured.find((s) => s.title)?.title ?? null;
  return { sessionTitle: null, suspectedSessionTitle: recent };
}

/** CIM 按 exe 名集合枚举（与 server-host queryCimByName 同语义但不复用：单名原始 PS 记录 vs 多名 OR 一次查询并映射为 pid/exePath/commandLine/startedAt，且 server-host 侧是 t0-01 演进的四要素核对路径，统一需改动已验证核对代码，收益不抵风险；PS 5.1 兼容 CreationDate ToString('o')） */
function queryCimByNames(exeNames: string[]): CimProcessRecord[] {
  if (exeNames.length === 0) return [];
  const filter = exeNames.map((n) => `Name='${n.replace(/'/g, "''")}'`).join(" OR ");
  const ps = `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,ExecutablePath,CommandLine,@{N='CreationDate';E={$_.CreationDate.ToString('o')}} | ConvertTo-Json -Compress`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) return [];
  try {
    const raw = JSON.parse(r.stdout.trim()) as Array<Record<string, unknown>>;
    const rows = Array.isArray(raw) ? raw : [raw];
    return rows
      .filter((row) => typeof row.ExecutablePath === "string")
      .map((row) => ({
        pid: Number(row.ProcessId),
        exePath: row.ExecutablePath as string,
        commandLine: typeof row.CommandLine === "string" ? row.CommandLine : null,
        startedAt: typeof row.CreationDate === "string" ? row.CreationDate : null,
      }));
  } catch {
    return [];
  }
}

/** 单 pid 强制终止（win32 taskkill /F；posix process.kill；失败带可读原因） */
function taskkillPid(pid: number): { ok: boolean; error?: string } {
  if (process.platform === "win32") {
    const r = spawnSync("taskkill", ["/F", "/PID", String(pid)], { encoding: "utf8" });
    if (r.status === 0) return { ok: true };
    const detail = (r.stderr || r.stdout || "").trim();
    if (r.status === 128) return { ok: false, error: "进程不存在（可能已退出）" };
    return { ok: false, error: `taskkill 退出码 ${r.status}${detail ? `：${detail}` : ""}` };
  }
  try {
    process.kill(pid, "SIGTERM");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 供装配层复用的默认探测实现导出（index.ts 无需另行包装） */
export { queryCimByNames as defaultQueryProcesses, taskkillPid as defaultKillPid };
