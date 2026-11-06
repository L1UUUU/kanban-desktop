// 用途：similarity 密封测试 —— Dice 相似度（归一化 + 字符 bigram）、双阈值具名常量边界、跨段候选合并去重（spec #27 F 节）
import { describe, expect, it } from "vitest";
import {
  CONFLICT_THRESHOLD,
  MERGE_THRESHOLD,
  diceSimilarity,
  mergeCandidates,
  normalizeClaimText,
  type ExtractedCandidate,
} from "./similarity";

describe("diceSimilarity（归一化 + 字符 bigram Dice）", () => {
  it("相同文本相似度为 1；空文本与任意比较为 0", () => {
    expect(diceSimilarity("配置项必须放配置文件", "配置项必须放配置文件")).toBe(1);
    expect(diceSimilarity("", "任意")).toBe(0);
    expect(diceSimilarity("任意", "")).toBe(0);
  });

  it("大小写与标点归一化后比较（形式差异不拉低相似度）", () => {
    expect(diceSimilarity("Use node:sqlite DatabaseSync", "use node sqlite databasesync")).toBe(1);
  });

  it("手工演算值：英文词 token（3/3 交集 2 → 0.667）", () => {
    // A={node, sqlite, databasesync} B={node, sqlite, database} → 2*2/(3+3)=0.666...
    expect(diceSimilarity("node sqlite DatabaseSync", "node sqlite Database")).toBeCloseTo(0.6667, 3);
  });

  it("手工演算值：中文按字符 bigram（『做测试』→{做测,测试}）", () => {
    // A={使用, vitest, 做测, 测试} B={使用, vitest, 测试} → 2*3/(4+3)=0.857...
    expect(diceSimilarity("使用 vitest 做测试", "使用 vitest 测试")).toBeCloseTo(0.8571, 3);
  });

  it("完全无关文本相似度为 0", () => {
    expect(diceSimilarity("alpha beta", "zzz yyy xxx www")).toBe(0);
  });
});

describe("判重双阈值具名常量（spec #27 F 节）", () => {
  it("冲突阈值 0.5 / 合并去重阈值 0.75", () => {
    expect(CONFLICT_THRESHOLD).toBe(0.5);
    expect(MERGE_THRESHOLD).toBe(0.75);
  });

  it("冲突边界：相似度恰为 0.5 判冲突（>= 含等号），0.4 不判", () => {
    // A={alpha,beta} B={alpha,gamma} → 2*1/4 = 0.5（恰在阈值上）
    expect(diceSimilarity("alpha beta", "alpha gamma")).toBe(0.5);
    // A={alpha,beta} B={alpha,gamma,delta} → 2*1/5 = 0.4（阈值下）
    expect(diceSimilarity("alpha beta", "alpha gamma delta")).toBe(0.4);
  });

  it("合并边界：0.8 合并、0.667 不合并", () => {
    // A={alpha,beta} B={alpha,beta,gamma} → 4/5 = 0.8
    expect(diceSimilarity("alpha beta", "alpha beta gamma")).toBe(0.8);
    // A={alpha,beta} B={alpha,beta,gamma,delta} → 4/6 ≈ 0.667
    expect(diceSimilarity("alpha beta", "alpha beta gamma delta")).toBeCloseTo(0.6667, 3);
  });
});

describe("normalizeClaimText", () => {
  it("小写化、去标点、折叠空白", () => {
    expect(normalizeClaimText("Hello, World! （测试）")).toBe("hello world 测试");
  });
});

describe("mergeCandidates（跨段合并去重，阈值 MERGE_THRESHOLD）", () => {
  const mk = (claim: string, sessions: string[], evidence = ""): ExtractedCandidate => ({
    claim,
    scope: "项目级",
    evidence,
    sourceSessionIds: sessions,
  });

  it("相似候选（Dice >= 0.75）合并为一条：来源取并集、证据拼接、保留先出现者", () => {
    const out = mergeCandidates([
      mk("node sqlite DatabaseSync 双入口兼容", ["s1"], "e1"),
      mk("完全无关的另一条经验规则", ["s9"], "e9"),
      mk("node sqlite DatabaseSync 双入口兼容（重复提取）", ["s2"], "e2"),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].claim).toBe("node sqlite DatabaseSync 双入口兼容");
    expect(out[0].sourceSessionIds).toEqual(["s1", "s2"]);
    expect(out[0].evidence).toBe("e1 | e2");
    expect(out[1].claim).toBe("完全无关的另一条经验规则");
  });

  it("低于阈值不合并、保持原顺序", () => {
    const out = mergeCandidates([mk("alpha beta", ["s1"]), mk("alpha beta gamma delta", ["s2"])]);
    expect(out).toHaveLength(2);
    expect(out[0].sourceSessionIds).toEqual(["s1"]);
  });

  it("空入参返回空数组", () => {
    expect(mergeCandidates([])).toEqual([]);
  });
});
