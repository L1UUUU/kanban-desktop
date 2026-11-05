// 手动触发提取 pipeline（等价产品中的「点击提取需求经验」按钮，无任何自动调度）：
// 读需求关联的多 CLI 原生历史 → 归一化 → 分段 → 每段用独立临时 Claude Session 提取 JSON →
// 合并去重 → 写 summary.md（人工编辑检测）与 candidates.jsonl（批次 + 冲突提示）→ 前后指纹隔离校验。
// 用法：node scripts/extract.mjs --req REQ-001 --batch B1 [--max-chars 6000]
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chunkEvents, mergeCandidates } from "../lib/normalize.mjs";
import { readClaudeHistory, fileFingerprint, claudeHistoryFile } from "../lib/history-claude.mjs";
import { withCodexReader, readCodexHistory } from "../lib/history-codex.mjs";
import { runExtractionSession, clampExtraction } from "../lib/extract.mjs";
import * as store from "../lib/store.mjs";
import { detectConflicts } from "../lib/review.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const EXTRACT_CWD = path.join(ROOT, "extract-tmp"); // 临时提取 session 的隔离 cwd（与开发 cwd 不同 project 目录）
const LOG_DIR = path.join(ROOT, "logs");
const MODEL_LOG = path.join(LOG_DIR, "model-calls.jsonl");
mkdirSync(EXTRACT_CWD, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

// ---- 参数 ----
const argv = process.argv.slice(2);
const argOf = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const REQ_ID = argOf("--req", "REQ-001");
const BATCH = argOf("--batch", "B1");
const MAX_CHARS = Number(argOf("--max-chars", "6000"));

const logModel = (entry) =>
  appendFileSync(MODEL_LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");

// 读一个 session 的原生历史；缺失时归入 missing（明确提示，不声称分析完整）
async function readSessionHistory(session) {
  if (session.cli === "claude") {
    try {
      return { session, events: readClaudeHistory({ cwd: session.cwd, sessionId: session.id }) };
    } catch (e) {
      return { session, events: null, error: e.message };
    }
  }
  if (session.cli === "codex") {
    try {
      return await withCodexReader(() => {}, async (c) => {
        const { events, threadPath } = await readCodexHistory(c, { threadId: session.id });
        return { session, events, threadPath };
      });
    } catch (e) {
      return { session, events: null, error: e.message };
    }
  }
  return { session, events: null, error: `未知 CLI: ${session.cli}` };
}

// 段提取 prompt：注入需求上下文 + 段历史，要求纯 JSON 输出
function segmentPrompt(req, chunk, total) {
  const src = chunk.sessions.map((s) => `${s.id} (${s.cli})`).join(", ");
  return [
    `你是「需求经验提取器」。以下是需求《${req.title}》（${req.id}）开发历史的第 ${chunk.index + 1}/${total} 段。`,
    `本段来源 Session：${src}。历史事件每行开头带 [cli/session角色 时间] 标签。`,
    "",
    "----- 历史开始 -----",
    chunk.text,
    "----- 历史结束 -----",
    "",
    "不要使用任何工具，只基于以上历史输出 JSON，不要输出 JSON 以外的任何内容：",
    "{",
    '  "summary": "本段开发小结：做了什么、关键决策、错误与修复、验证方式（3-5 句）",',
    '  "candidates": [',
    '    {"claim": "一条可复用的项目级规则/边界/经验（一句话）", "evidence": "历史中的依据（引用关键行为或原句）", "scope": "适用范围（如 calc.js / 项目级）", "sourceSessionIds": ["本段 session id"]}',
    "  ]",
    "}",
    "缺失的信息不要编造；只提取这段历史真正支撑的内容。",
    "格式硬约束：输出必须是单个合法 JSON 对象；所有字符串值内部禁止出现英文双引号（需要引用时用中文引号『』或单引号）；不要输出注释、围栏或 JSON 以外的任何文字。",
  ].join("\n");
}

// ---- main ----
const reqs = JSON.parse(readFileSync(path.join(ROOT, "fixture", "requirements.json"), "utf8"));
const req = reqs.requirements.find((r) => r.id === REQ_ID);
if (!req) throw new Error(`需求不存在: ${REQ_ID}`);

console.log(`[extract] ${REQ_ID} 批次 ${BATCH}：读取 ${req.sessions.length} 个关联 Session`);

// 1) 提取前指纹（隔离校验基线）
const preFingerprints = {};
for (const s of req.sessions) {
  if (s.cli === "claude") {
    const f = claudeHistoryFile(s.cwd, s.id);
    if (existsSync(f)) preFingerprints[s.id] = { ...fileFingerprint(f), cli: "claude" };
  }
  // codex rollout 指纹在读取后由 thread.path 补充
}

// 2) 读取各 session 原生历史
const results = [];
for (const s of req.sessions) results.push(await readSessionHistory(s));
const readable = results.filter((r) => r.events && r.events.length >= 0);
const missing = results.filter((r) => !r.events);
const codexReadable = readable.filter((r) => r.session.cli === "codex" && r.threadPath);
for (const r of codexReadable) {
  if (existsSync(r.threadPath)) {
    const { createHash } = await import("node:crypto");
    const buf = readFileSync(r.threadPath);
    preFingerprints[r.session.id] = {
      file: r.threadPath,
      sha256: createHash("sha256").update(buf).digest("hex"),
      size: buf.length,
      cli: "codex",
    };
  }
}
console.log(`[extract] 可读 ${readable.length} 个；缺失 ${missing.length} 个：${missing.map((m) => m.session.id).join(", ") || "无"}`);

// 3) 归一化合并 + 分段（session 边界优先）
const allEvents = readable.flatMap((r) => r.events);
const chunks = chunkEvents(allEvents, { maxChars: MAX_CHARS });
console.log(`[extract] 事件 ${allEvents.length} 条 → 分 ${chunks.length} 段`);

// 4) 每段独立临时 Claude Session 提取（全新 UUID、隔离 cwd，不触碰开发 session）
const segResults = [];
for (const chunk of chunks) {
  const prompt = segmentPrompt(req, chunk, chunks.length);
  const r = await runExtractionSession({
    cwd: EXTRACT_CWD,
    prompt,
    timeoutMs: 300000,
    onParseFailure: (raw) => {
      writeFileSync(path.join(LOG_DIR, `parse-failure-${BATCH}-seg${chunk.index}.txt`), raw, "utf8");
    },
  });
  const segSessions = chunk.sessions.map((s) => s.id);
  const clamped = clampExtraction(r.json, segSessions, chunk.index);
  segResults.push({ chunkIndex: chunk.index, sessions: segSessions, extractionSessionId: r.sessionId, ...clamped });
  logModel({ kind: "extract-segment", batch: BATCH, chunk: chunk.index, extractionSessionId: r.sessionId, usage: r.usage });
  console.log(`[extract] 段 ${chunk.index + 1}/${chunks.length} 完成：summary ${clamped.summary.length} 字，候选 ${clamped.candidates.length} 条（临时 session ${r.sessionId.slice(0, 8)}）`);
}

// 5) 合并去重（确定性）
const mergedCandidates = mergeCandidates(segResults.flatMap((s) => s.candidates));

// 6) 组装 summary.md（含来源清单与缺失提示）
const genAt = new Date().toISOString();
const summaryLines = [
  `# ${req.id} 需求开发总结（批次 ${BATCH}）`,
  "",
  `- 生成时间：${genAt}`,
  `- 生成方式：手动提取（Kanban Desktop PoC-5，用户触发）`,
  `- 提取分段：${chunks.length} 段 / 事件 ${allEvents.length} 条`,
  "",
  "## 来源 Session",
  ...readable.map((r) => `- ${r.session.id} (${r.session.cli}) — 可读，事件 ${r.events.length} 条`),
  ...missing.map((m) => `- ${m.session.id} (${m.session.cli}) — ❌ 历史不可读：${m.error}`),
  "",
];
if (missing.length > 0) {
  summaryLines.push(
    "## 缺失历史提示",
    "",
    `本次提取未包含以下 ${missing.length} 个 Session 的历史，分析不覆盖其内容：`,
    ...missing.map((m) => `- ${m.session.id} (${m.session.cli})：${m.error}${m.session.note ? `（${m.session.note}）` : ""}`),
    "",
  );
}
summaryLines.push("## 分段开发小结");
for (const s of segResults) {
  summaryLines.push("", `### 段 ${s.chunkIndex + 1}（来源：${s.sessions.join(", ")}）`, "", s.summary || "（本段无小结）");
}
summaryLines.push("", "## 长期知识候选（待审核）", "");
for (const c of mergedCandidates) {
  summaryLines.push(`- ${c.claim}`);
  summaryLines.push(`  - 证据：${c.evidence}`);
  summaryLines.push(`  - 范围：${c.scope}；来源：${c.sourceSessionIds.join(", ")}`);
}
summaryLines.push("");
const summaryContent = summaryLines.join("\n");

// 7) 落盘：summary（人工编辑检测）+ 候选（批次 + 冲突提示）
const summaryRes = store.writeSummary(DATA, REQ_ID, summaryContent, { batchId: BATCH, generatedAt: genAt });
store.appendCandidates(DATA, REQ_ID, mergedCandidates, { batchId: BATCH });
// 冲突检测必须作用于「从磁盘重读的本批记录」，保证标记随 writeCandidates 落盘
const all = store.readCandidates(DATA, REQ_ID);
const batchRecords = all.filter((r) => r.batchId === BATCH);
detectConflicts(batchRecords, all);
store.writeCandidates(DATA, REQ_ID, all);
const appendedWithFlags = batchRecords;

// 8) 提取后指纹对比（隔离校验：开发 session 原生历史必须无变化）
const postFingerprints = {};
let isolated = true;
const details = [];
for (const [sid, pre] of Object.entries(preFingerprints)) {
  let post = null;
  if (existsSync(pre.file)) {
    post = pre.cli === "claude" ? fileFingerprint(pre.file) : { sha256: null };
    if (pre.cli === "codex") {
      const { createHash } = await import("node:crypto");
      const buf = readFileSync(pre.file);
      post = { sha256: createHash("sha256").update(buf).digest("hex"), size: buf.length };
    }
  }
  const same = post && post.sha256 === pre.sha256;
  if (!same) isolated = false;
  details.push({ sessionId: sid, cli: pre.cli, unchanged: !!same, pre, post });
}
const isolationReport = {
  batch: BATCH, at: genAt, isolated,
  extractionSessions: segResults.map((s) => ({ id: s.extractionSessionId, cwd: EXTRACT_CWD })),
  details,
};
writeFileSync(path.join(LOG_DIR, `isolation-${BATCH}.json`), JSON.stringify(isolationReport, null, 2), "utf8");

// 9) 汇总报告
const report = {
  batch: BATCH,
  reqId: REQ_ID,
  chunks: chunks.length,
  events: allEvents.length,
  readableSessions: readable.map((r) => ({ id: r.session.id, cli: r.session.cli, events: r.events.length })),
  missingSessions: missing.map((m) => ({ id: m.session.id, cli: m.session.cli, error: m.error })),
  extractionSessionIds: segResults.map((s) => s.extractionSessionId),
  summaryWritten: summaryRes,
  candidates: appendedWithFlags.map((a) => ({ id: a.id, claim: a.claim, conflicts: a.conflicts, notes: a.notes })),
  isolated,
};
writeFileSync(path.join(LOG_DIR, `extract-${BATCH}.json`), JSON.stringify(report, null, 2), "utf8");
console.log(`[extract] summary 覆盖=${summaryRes.overwritten}${summaryRes.reason ? `（${summaryRes.reason}）` : ""}；候选 ${appendedWithFlags.length} 条（冲突标记 ${appendedWithFlags.filter((a) => a.conflicts.length).length} 条）；隔离校验 ${isolated ? "通过（开发历史无变化）" : "失败"}`);
console.log(`[extract] 报告：logs/extract-${BATCH}.json`);
