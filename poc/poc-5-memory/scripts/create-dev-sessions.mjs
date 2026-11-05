// 创建 REQ-001 的真实开发 Session：1 个 Claude（含早期错误→自测失败→纠正的完整情节）+ 1 个 Codex（multiply 微任务），
// 结束后写 fixture/requirements.json（含真实 session id 与 1 个指向不存在 id 的假 session）并记录提取前基线指纹。
// 真实模型调用：claude 1 次 + codex 1 次（计数写入 logs/model-calls.jsonl）。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runClaudePrint } from "../lib/extract.mjs";
import { fileFingerprint, claudeHistoryFile } from "../lib/history-claude.mjs";
import { CodexAppServerClient } from "../lib/codex-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKDIR = path.join(__dirname, "..", "fixture", "workdir");
const LOG_DIR = path.join(__dirname, "..", "logs");
const MODEL_LOG = path.join(LOG_DIR, "model-calls.jsonl");
mkdirSync(LOG_DIR, { recursive: true });

const logModel = (entry) =>
  appendFileSync(MODEL_LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");

const DEV_CLAUDE_PROMPT = [
  "在 calc.js 添加 divide(a,b)，严格按三步做：",
  "1) 先实现成 b 为 0 时返回 0，并在文件末尾加自测断言 if (divide(4,0) !== 0) throw new Error('bad')，运行 node calc.js 确认通过；",
  "2) 把断言改成要求 divide(4,0) 必须抛出 Error（try/catch 检查），运行 node calc.js 观察它失败；",
  "3) 修正 divide 为 b 为 0 时 throw new Error('divide by zero')，再运行 node calc.js 使全部自测通过。",
  "完成后只输出一行结果报告，不要输出其他解释。",
].join("\n");

const DEV_CODEX_PROMPT = [
  "在 calc.js 添加 multiply(a,b)（普通乘法）并加入 module.exports，",
  "在文件末尾自测区加断言 multiply(3,4) === 12，运行 node calc.js 确认通过。",
  "完成后用一行话报告结果。",
].join("");

async function createClaudeSession() {
  const sessionId = randomUUID();
  const r = await runClaudePrint({
    cwd: WORKDIR,
    prompt: DEV_CLAUDE_PROMPT,
    sessionId,
    // 仅放行本微任务必需的工具（文件编辑 + node 自测），不改任何全局配置
    extraArgs: ["--allowedTools", "Edit,Write,Read,Bash(node:*)"],
    timeoutMs: 420000,
  });
  logModel({ kind: "dev-session", cli: "claude", sessionId: r.sessionId, usage: r.usage });
  const file = claudeHistoryFile(WORKDIR, r.sessionId);
  if (!existsSync(file)) throw new Error(`claude 开发 session 历史文件未生成: ${file}`);
  return { id: r.sessionId, cli: "claude", cwd: WORKDIR, report: r.rawText.trim().slice(0, 300) };
}

async function createCodexSession() {
  const c = new CodexAppServerClient({ log: () => {} });
  c.start();
  try {
    await c.initialize();
    const ts = await c.threadStart({
      cwd: WORKDIR,
      model: "gpt-5.6-luna", // poc-1 证实本账号实际可用模型
      approvalPolicy: "never", // 微任务无审批交互；sandbox 限制写范围
      sandbox: "workspace-write",
    });
    const threadId = ts.thread.id;
    const r = await c.runTurn(threadId, DEV_CODEX_PROMPT);
    logModel({ kind: "dev-session", cli: "codex", threadId, model: "gpt-5.6-luna" });
    const answer = [...r.collected.agentItems.values()].map((i) => i.text).join("");
    if (!r.turn || r.turn.status !== "completed") {
      throw new Error(`codex turn 未完成: ${r.turn?.status}`);
    }
    return { id: threadId, cli: "codex", cwd: WORKDIR, rolloutPath: ts.thread.path || null, report: answer.trim().slice(0, 300) };
  } finally {
    c.stop();
  }
}

// ---- main ----
const sessionsFile = path.join(__dirname, "..", "fixture", "requirements.json");
const baselineFile = path.join(LOG_DIR, "baseline-fingerprints.json");

const claudeSession = await createClaudeSession();
console.log("[dev-claude]", claudeSession.id, "—", claudeSession.report);

const codexSession = await createCodexSession();
console.log("[dev-codex]", codexSession.id, "—", codexSession.report);

// 假 session：指向不存在的 claude id，用于「缺失历史明确提示」验证
const fakeSession = {
  id: "00000000-dead-0000-0000-00000000beef",
  cli: "claude",
  cwd: WORKDIR,
  note: "假 session（历史不存在），验证缺失提示",
};

const requirements = {
  requirements: [
    {
      id: "REQ-001",
      title: "为 calc.js 添加基础运算函数（divide 含除零纠错、multiply）",
      sessions: [claudeSession, codexSession, fakeSession],
    },
  ],
};
writeFileSync(sessionsFile, JSON.stringify(requirements, null, 2), "utf8");

// 提取前基线指纹（claude 原生 jsonl + codex rollout），供提取后隔离对比
const baseline = {
  claude: fileFingerprint(claudeHistoryFile(WORKDIR, claudeSession.id)),
  codex: codexSession.rolloutPath && existsSync(codexSession.rolloutPath)
    ? { file: codexSession.rolloutPath, ...sha256Size(codexSession.rolloutPath) }
    : { file: codexSession.rolloutPath, note: "rollout 路径未提供，提取后以 thread/read 可读性代替对比" },
};
writeFileSync(baselineFile, JSON.stringify(baseline, null, 2), "utf8");
console.log("[baseline] 写入", baselineFile);
console.log("[done] requirements.json:", sessionsFile);

function sha256Size(file) {
  const buf = readFileSync(file);
  return { sha256: createHash("sha256").update(buf).digest("hex"), size: buf.length };
}
