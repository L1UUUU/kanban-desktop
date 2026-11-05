// 用途：Codex 模型可用性探测与回退 —— model/list 不可信（poc-1 发现 2），用 ephemeral thread + 最小 turn 真试探，候选链：显式→缓存→最近 rollout→model/list；探测结果落盘缓存
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

/** 模型探测所需的最小 client 面（request + 通知订阅） */
export interface ProbeClient {
  request(method: string, params?: unknown): Promise<unknown>;
  on(method: string, fn: (p: unknown) => void): () => void;
}

/** 模型解析器：返回该账号真实可用的模型 id（不可用即抛错，含中文原因） */
export type ModelResolver = (requested: string | undefined, client: ProbeClient) => Promise<string>;

/** 探测缓存文件形状（应用数据目录；spec §7-7 探针/模型缓存归属） */
interface ProbeCache {
  model: string;
  version: string | null;
  probedAt: string;
}

const PROBE_CACHE_FILE = "codex-model-probe.json";
/** 单个候选试探的超时（最小 turn 正常几秒内） */
const PROBE_TURN_TIMEOUT_MS = 60_000;
/** model/list 兜底候选最多试探数（控制真实调用成本） */
const MAX_LIST_CANDIDATES = 3;

/** 创建默认解析器（探测链 + 内存/磁盘缓存；options.exe/version 用于缓存键；rolloutModel 测试注入隔离本机环境） */
export function createDefaultModelResolver(options: { exe?: string | null; version?: string | null; cacheDir?: string; rolloutModel?: string | null }): ModelResolver {
  let cachedModel: string | null = null;
  const cachePath = options.cacheDir ? path.join(options.cacheDir, PROBE_CACHE_FILE) : null;

  return async (requested, client) => {
    // 0) 内存缓存
    if (cachedModel) return cachedModel;
    // 1) 磁盘缓存
    const disk = readCache(cachePath);
    if (disk) {
      cachedModel = disk.model;
      return disk.model;
    }
    // 2) 候选链（去重保序）：显式 → 最近 rollout → model/list 前 N
    const candidates: string[] = [];
    const push = (m: string | undefined | null) => {
      if (typeof m === "string" && m && !candidates.includes(m)) candidates.push(m);
    };
    push(requested);
    push(options.rolloutModel !== undefined ? options.rolloutModel : latestRolloutModel());
    for (const m of await listModels(client).catch(() => [])) push(m);
    const limited = candidates.slice(0, Math.max(candidates.indexOf(requested ?? "\0") + 1, MAX_LIST_CANDIDATES) || MAX_LIST_CANDIDATES);
    // 3) 逐个试探（真 turn：400 拒绝不产生推理成本，poc-1 实证）
    const failures: string[] = [];
    for (const model of limited.length ? limited : candidates) {
      const ok = await probeModelWithMinimalTurn(client, model).catch(() => false);
      if (ok) {
        cachedModel = model;
        writeCache(cachePath, { model, version: options.version ?? null, probedAt: new Date().toISOString() });
        return model;
      }
      failures.push(model);
    }
    throw new Error(`未探测到可用的 Codex 模型（已尝试：${[...new Set(failures)].join("、") || "无候选"}）。请确认 codex 已登录且账号可用，或在会话中显式指定模型。`);
  };
}

/** 最小 turn 试探：ephemeral thread（不落盘）+「只回复 ok」；turn completed 即可用 */
export async function probeModelWithMinimalTurn(
  client: { request(method: string, params?: unknown): Promise<unknown>; on(method: string, fn: (p: unknown) => void): () => void },
  model: string,
): Promise<boolean> {
  const ts = (await client.request("thread/start", {
    model,
    cwd: tmpdir(),
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
  })) as { thread?: { id?: string } };
  const threadId = ts.thread?.id;
  if (!threadId) return false;
  return new Promise<boolean>((resolve) => {
    const offs: Array<() => void> = [];
    const finish = (ok: boolean) => {
      offs.splice(0).forEach((off) => off());
      resolve(ok);
    };
    offs.push(
      client.on("turn/completed", (p) => {
        const n = p as { threadId: string; turn: { status: string } };
        if (n.threadId === threadId) finish(n.turn.status === "completed");
      }),
    );
    offs.push(
      client.on("error", (p) => {
        const n = p as { threadId: string; willRetry: boolean };
        if (n.threadId === threadId && !n.willRetry) finish(false);
      }),
    );
    const timer = setTimeout(() => finish(false), PROBE_TURN_TIMEOUT_MS);
    offs.push(() => clearTimeout(timer));
    void client
      .request("turn/start", {
        threadId,
        input: [{ type: "text", text: "只回复两个字符：ok", text_elements: [] }],
        effort: "low",
      })
      .catch(() => finish(false));
  });
}

/** 扫描 ~/.codex/sessions 最新 rollout 的 model 字段（poc-1 §3.2 零成本定位法；目录结构 YYYY/MM/DD） */
export function latestRolloutModel(): string | null {
  try {
    const root = path.join(homedir(), ".codex", "sessions");
    if (!existsSync(root)) return null;
    let latest: { file: string; mtime: number } | null = null;
    const walk = (dir: string, depth: number): void => {
      if (depth > 4) return;
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full, depth + 1);
        else if (name.startsWith("rollout-") && name.endsWith(".jsonl")) {
          if (!latest || st.mtimeMs > latest.mtime) latest = { file: full, mtime: st.mtimeMs };
        }
      }
    };
    walk(root, 0);
    if (!latest) return null;
    const head = readFileSync((latest as { file: string }).file, "utf8").slice(0, 65_536);
    const m = head.match(/"model"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** model/list 候选（不可信，仅兜底来源；isDefault 优先） */
async function listModels(client: { request(method: string, params?: unknown): Promise<unknown> }): Promise<string[]> {  const res = (await client.request("model/list", {})) as { data?: Array<{ id?: string; isDefault?: boolean }> };
  const data = Array.isArray(res.data) ? res.data : [];
  const ids = data.filter((m) => m.id).map((m) => String(m.id));
  const defaults = data.filter((m) => m.isDefault && m.id).map((m) => String(m.id));
  return [...defaults, ...ids.filter((id) => !defaults.includes(id))];
}

function readCache(cachePath: string | null): ProbeCache | null {
  if (!cachePath || !existsSync(cachePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf8")) as ProbeCache;
    if (typeof raw.model === "string" && raw.model) return raw;
  } catch {
    /* 损坏缓存忽略 */
  }
  return null;
}

function writeCache(cachePath: string | null, cache: ProbeCache): void {
  if (!cachePath) return;
  try {
    mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  } catch {
    /* 缓存写失败不阻塞 */
  }
}
