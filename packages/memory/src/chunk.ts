// 用途：会话历史分段纯函数（演进自 poc-5 lib/normalize.mjs chunkEvents）—— 会话边界优先 + maxChars 累计 + 单事件硬切（spec #27 F 节）
// 输入事件类型本包本地定义（role/text/tool 与 #28 readTranscript 的 TranscriptEvent 同形，避免跨票依赖；#32 接线时统一 import）

/** 默认分段累计字符上限（spec #27 F 节：会话边界优先 + maxChars 6000 + 单事件硬切） */
export const MAX_CHUNK_CHARS = 6000;

/** 分段输入事件：一条会话消息（双视角 role + 工具调用摘要），附会话归属用于边界切段 */
export interface MemoryEvent {
  cli: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  tool?: { name: string; summary: string } | null;
}

/** 分段产出来源会话 */
export interface ChunkSessionRef {
  id: string;
  cli: string;
}

/** 一个分段：index 为全序、sessions 为段内出现过的会话、text 为可直接注入提取 prompt 的历史文本 */
export interface EventChunk {
  index: number;
  sessions: ChunkSessionRef[];
  text: string;
}

/** 把多会话事件流切段：优先在会话边界切，段累计字符超 maxChars 再切，单事件过长按行/句边界硬切 */
export function chunkEvents(events: MemoryEvent[], opts?: { maxChars?: number }): EventChunk[] {
  const maxChars = opts?.maxChars ?? MAX_CHUNK_CHARS;
  const chunks: EventChunk[] = [];
  // cur 永远指向当前段（初始化即非空，pushChunk 后立即换新段），避免可空状态
  let cur = { sessions: [] as ChunkSessionRef[], sessionSet: new Set<string>(), lines: [] as string[], chars: 0 };

  const pushChunk = (): void => {
    if (cur.lines.length > 0) {
      chunks.push({ index: chunks.length, sessions: cur.sessions, text: cur.lines.join("\n") });
    }
    cur = { sessions: [], sessionSet: new Set(), lines: [], chars: 0 };
  };
  const addSessionOf = (e: MemoryEvent): void => {
    const key = `${e.cli}:${e.sessionId}`;
    if (!cur.sessionSet.has(key)) {
      cur.sessionSet.add(key);
      cur.sessions.push({ id: e.sessionId, cli: e.cli });
    }
  };

  for (const e of events) {
    // 规则 1：跨会话边界且当前段已有内容 → 新开一段（来源归属干净）
    if (cur.lines.length > 0 && !cur.sessionSet.has(`${e.cli}:${e.sessionId}`)) {
      pushChunk();
    }
    const label = `[${e.cli}/${e.sessionId.slice(0, 8)} ${e.role}]`;
    const toolSuffix = e.tool ? `（工具 ${e.tool.name}：${e.tool.summary}）` : "";
    const pieces = splitLongText(`${label} ${e.text}${toolSuffix}`, maxChars);
    for (const piece of pieces) {
      // 累计字符含行间换行符，保证段文本长度恰好不超过 maxChars
      if (cur.chars + piece.length + (cur.lines.length > 0 ? 1 : 0) > maxChars && cur.lines.length > 0) {
        pushChunk();
      }
      addSessionOf(e);
      cur.lines.push(piece);
      cur.chars += piece.length + (cur.lines.length > 1 ? 1 : 0);
    }
  }
  pushChunk();
  return chunks;
}

// 单事件文本超过 maxChars 时按行/句边界硬切，保证每片不超过 maxChars（找不到边界则原位硬切）
function splitLongText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n", maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf("。", maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf("；", maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf(". ", maxChars);
    if (cut < maxChars * 0.5) cut = maxChars - 1; // 找不到边界则原位硬切
    const end = Math.min(cut + 1, maxChars); // 切点恰在 maxChars 时封顶，保证每片不超限
    pieces.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest.trim()) pieces.push(rest);
  return pieces;
}
