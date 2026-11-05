// 归一化层：统一事件模型、历史分段（chunkEvents）与 claim 文本相似度（Jaccard），全部为确定性纯函数。
import path from "node:path";

// 归一化事件：{ sessionId, cli, role: "user"|"assistant", text, ts }
// 两种 CLI 的原生历史都先转成该模型，再做分段与提取。

// 把多来源事件流切段：优先在 session 边界切，超长再按累计字符切，单事件过长则硬切文本。
// 返回 [{ index, sessions:[{id,cli}], header, text }]，text 为可直接注入提取 prompt 的历史文本。
export function chunkEvents(events, { maxChars = 6000 } = {}) {
  const chunks = [];
  let cur = null;

  const pushChunk = () => {
    if (cur && cur.lines.length > 0) {
      chunks.push({
        index: chunks.length,
        sessions: cur.sessions,
        text: cur.lines.join("\n"),
      });
    }
    cur = null;
  };

  const startChunk = () => {
    cur = { sessions: [], sessionSet: new Set(), lines: [], chars: 0 };
  };

  const addSessionOf = (ev) => {
    const key = `${ev.cli}:${ev.sessionId}`;
    if (!cur.sessionSet.has(key)) {
      cur.sessionSet.add(key);
      cur.sessions.push({ id: ev.sessionId, cli: ev.cli });
    }
  };

  for (const ev of events) {
    if (!cur) startChunk();
    const isBoundary = cur.lines.length > 0 && !cur.sessionSet.has(`${ev.cli}:${ev.sessionId}`);
    // 规则 1：跨 session 边界且当前段已有内容 → 新开一段（不同 CLI/session 的历史天然分段，来源归属更干净）
    if (isBoundary) pushChunk(), startChunk();
    const label = `[${ev.cli}/${ev.sessionId.slice(0, 8)} ${ev.role} ${ev.ts || ""}]`;
    const pieces = splitLongText(`${label} ${ev.text}`, maxChars);
    for (const piece of pieces) {
      if (!cur) startChunk();
      if (cur.chars + piece.length > maxChars && cur.lines.length > 0) pushChunk(), startChunk();
      addSessionOf(ev);
      cur.lines.push(piece);
      cur.chars += piece.length;
    }
  }
  pushChunk();
  return chunks;
}

// 单事件文本超过 maxChars 时按句子/行边界硬切，保证每片不超过 maxChars
function splitLongText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const pieces = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n", maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf("。", maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf("；", maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf(". ", maxChars);
    if (cut < maxChars * 0.5) cut = maxChars; // 找不到边界则硬切
    pieces.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) pieces.push(rest);
  return pieces;
}

// claim 归一化：小写、去标点空白，用于相似度比较
export function normalizeClaimText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[。，、；：""''（）()\[\]{}.,;:!?'"`~_\-*/\\|<>@#$%^&+=]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 文本相似度（确定性）：claim 先归一化，再取「字符 bigram」（中文无空格分词，bigram 对中英混合最稳），
// 用 Dice 系数（2|A∩B|/(|A|+|B|)）——短文本上比 Jaccard 更贴近直觉。用于重复候选合并与冲突检测。
export function diceSimilarity(a, b) {
  const ta = bigrams(normalizeClaimText(a));
  const tb = bigrams(normalizeClaimText(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

function bigrams(s) {
  const out = new Set();
  for (const word of s.split(" ").filter(Boolean)) {
    if (/[\u4e00-\u9fff]/.test(word)) {
      for (let i = 0; i + 1 < word.length; i++) out.add(word.slice(i, i + 2));
    } else {
      out.add(word);
    }
  }
  return out;
}

// cwd → Claude Code 原生 projects 目录名（盘符冒号与路径分隔符均替换为 '-'）
export function claudeProjectDirName(cwd) {
  return String(cwd).replace(/[:\\\/]/g, "-");
}

// 跨段候选合并：不同段提取出的相似 claim（Dice ≥ threshold）合并为一条，来源/证据取并集
export function mergeCandidates(allCandidates, { threshold = 0.75 } = {}) {
  const merged = [];
  for (const cand of allCandidates) {
    const hit = merged.find(
      (m) => diceSimilarity(m.claim, cand.claim) >= threshold,
    );
    if (hit) {
      hit.sourceSessionIds = [...new Set([...hit.sourceSessionIds, ...cand.sourceSessionIds])];
      hit.evidence = [hit.evidence, cand.evidence].filter(Boolean).join(" | ");
      hit.segments.push(...cand.segments);
    } else {
      merged.push({ ...cand, segments: [...(cand.segments || [])] });
    }
  }
  return merged;
}

// 便捷：本地路径工具（供各模块统一使用）
export { path };
