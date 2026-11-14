// 用途：OpenCode wire 快照读取器（arch C2）—— GET /session/{id}/message 与 GET /command 的「请求 + 解析 + 双形态兜底」单源件，收敛 opencode-adapter 六个散点解析；响应壳再漂移（#97 同类事件）时唯一修复落点
import type { OpenCodeServerClientLike } from "./client";

/** 读取器对 client 的真实依赖面（仅 api；注入 fake 只需实现此方法） */
type SnapshotClient = Pick<OpenCodeServerClientLike, "api">;

/** message 快照单条（wire 宽松形态：info 元数据 + parts 部件；字段判型由各消费点自理） */
export interface OpenCodeMessageItem {
  info?: Record<string, unknown>;
  parts?: unknown[];
}

/** /command 快照单条（wire 宽松 record；条目可为 null——消费点按 c?.x 判空） */
export type OpenCodeCommandItem = Record<string, unknown> | null;

/** 快照读取结果：ok=HTTP 层成败；items 无论成败都已按双形态兜底解析（knownCommands 语义：失败也消费名单而非异常）；error=!ok 时的 HTTP 错误或请求异常 */
export type SnapshotResult<T> = { ok: true; items: T[]; error: null } | { ok: false; items: T[]; error: Error };

/** GET /session/{id}/message?limit=500 → message 快照。双形态兜底：{items} 壳优先（items 非 null/undefined 即采用），裸数组兜底，否则 []。读取失败不抛，经 result.error 交调用方定策略 */
export async function readMessageSnapshot(client: SnapshotClient, nativeSessionId: string): Promise<SnapshotResult<OpenCodeMessageItem>> {
  try {
    const r = await client.api("GET", `/session/${nativeSessionId}/message?limit=500`);
    const json = r.json as { items?: OpenCodeMessageItem[] } | null;
    const items = json?.items ?? (Array.isArray(r.json) ? (r.json as OpenCodeMessageItem[]) : []);
    return r.ok
      ? { ok: true, items, error: null }
      : { ok: false, items, error: new Error(`HTTP ${r.status} ${r.text.slice(0, 160)}`) };
  } catch (e) {
    return { ok: false, items: [], error: e instanceof Error ? e : new Error(String(e)) };
  }
}

/** GET /command → command 快照。双形态兜底：{items} 壳须 items 为数组才采用（与 message 的空值判定不同序），裸数组兜底，否则 []。读取失败不抛，经 result.error 交调用方定策略 */
export async function readCommandSnapshot(client: SnapshotClient): Promise<SnapshotResult<OpenCodeCommandItem>> {
  try {
    const r = await client.api("GET", "/command");
    const items = Array.isArray((r.json as { items?: OpenCodeCommandItem[] } | null)?.items)
      ? (r.json as { items: OpenCodeCommandItem[] }).items
      : Array.isArray(r.json)
        ? (r.json as OpenCodeCommandItem[])
        : [];
    return r.ok
      ? { ok: true, items, error: null }
      : { ok: false, items, error: new Error(`HTTP ${r.status} ${r.text.slice(0, 160)}`) };
  } catch (e) {
    return { ok: false, items: [], error: e instanceof Error ? e : new Error(String(e)) };
  }
}
