// 用途：claim 相似度判重纯函数（演进自 poc-5 lib/normalize.mjs）—— 归一化 + 字符 bigram Dice、冲突/合并双阈值具名常量、跨段候选合并去重（spec #27 F 节）
// Dice 是启发式首版（spec 已知诚实边界）：对同义改写召回有限，产品化升级判重另评。

/** 冲突检测阈值（spec #27 F）：对 accepted/edited 标 conflicts、对 ignored 标 notes，仅标注不阻断；宁多提示不静默 */
export const CONFLICT_THRESHOLD = 0.5;

/** 跨段候选合并去重阈值（spec #27 F）：提取管线内合并相似 claim，比冲突提示更保守 */
export const MERGE_THRESHOLD = 0.75;

/** 提取候选（分段产出、落库前形态；#32 提取管线经 mergeCandidates 去重后传入 store） */
export interface ExtractedCandidate {
  claim: string;
  scope: string;
  evidence: string;
  sourceSessionIds: string[];
}

/** claim 归一化：小写、去标点空白，用于相似度比较 */
export function normalizeClaimText(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[。，、；：""''（）()[\]{}.,;:!?'"`~_\-*/\\|<>@#$%^&+=]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 文本相似度（确定性）：归一化后取字符 bigram（中文无空格分词，bigram 对中英混合最稳），Dice 系数 2|A∩B|/(|A|+|B|) */
export function diceSimilarity(a: string, b: string): number {
  const ta = bigrams(normalizeClaimText(a));
  const tb = bigrams(normalizeClaimText(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

// bigram 集合：中文词按相邻两字切、英文词整词为一个 token（poc-5 实证形态）
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const word of s.split(" ").filter(Boolean)) {
    if (/[\u4e00-\u9fff]/.test(word)) {
      for (let i = 0; i + 1 < word.length; i++) out.add(word.slice(i, i + 2));
    } else {
      out.add(word);
    }
  }
  return out;
}

/** 跨段候选合并：不同段提取出的相似 claim（Dice >= threshold，默认 MERGE_THRESHOLD）合并为一条，来源取并集、证据拼接、保留先出现者 */
export function mergeCandidates(all: ExtractedCandidate[], opts?: { threshold?: number }): ExtractedCandidate[] {
  const threshold = opts?.threshold ?? MERGE_THRESHOLD;
  const merged: ExtractedCandidate[] = [];
  for (const cand of all) {
    const hit = merged.find((m) => diceSimilarity(m.claim, cand.claim) >= threshold);
    if (hit) {
      hit.sourceSessionIds = [...new Set([...hit.sourceSessionIds, ...cand.sourceSessionIds])];
      hit.evidence = [hit.evidence, cand.evidence].filter(Boolean).join(" | ");
    } else {
      merged.push({ ...cand, sourceSessionIds: [...cand.sourceSessionIds] });
    }
  }
  return merged;
}
