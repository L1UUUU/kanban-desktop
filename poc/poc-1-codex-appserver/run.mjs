// PoC 1 测试运行器：对 Codex app-server 逐项执行启动/聊天/工具/审批/取消/并发/恢复/异常 8 项验证并写日志。
// 用法：node run.mjs [--only a,b,d,e,f,g,h] [--model <name>]  （--only 选子集，默认全部）
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient, resolveCodexCommand } from "./client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "logs");
const WORKDIR = path.join(__dirname, "fixture", "workdir");
mkdirSync(LOG_DIR, { recursive: true });

// ---- 参数 ----
const argv = process.argv.slice(2);
const onlyArg = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
const ONLY = onlyArg ? new Set(onlyArg.split(",").map((s) => s.trim())) : null;
const MODEL = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : "gpt-5.6-luna"; // 本账号实际可用模型（rollout 历史证实；config 默认 gpt-6.1-terra 与 model/list 列出的多数模型均报 400）
const PICK = (id) => !ONLY || ONLY.has(id);

// ---- 全局状态 ----
const results = [];
let modelCallCount = 0; // 真实 turn/start 次数（成本计数，上限 10）
const MAGIC = "ZEBRA-47";
const turnIdsByThread = new Map(); // threadId -> 最新 turnId（从 turn/started 通知捕获）

function makeLogger(name) {
  const file = path.join(LOG_DIR, `${name}.log`);
  writeFileSync(file, "");
  return {
    file,
    write(kind, data) {
      appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), kind, data }) + "\n");
    },
  };
}

function record(id, name, status, notes) {
  results.push({ id, name, status, notes });
  console.log(`[${status}] ${id} ${name}${notes ? " — " + notes : ""}`);
}

// 启动客户端 + initialize + 全局 turn/started 捕获
async function bootClient(logger) {
  const c = new CodexAppServerClient({ log: (k, ...rest) => logger.write(k, rest.join(" ")) });
  c.on("*", (e) => {
    if (e.method === "turn/started" && e.params?.threadId) turnIdsByThread.set(e.params.threadId, e.params.turn?.id);
    const s = JSON.stringify(e.params);
    logger.write("notify", `${e.method} ${s.length > 2000 ? s.slice(0, 2000) + `...(${s.length}B)` : s}`);
  });
  c.on("dead", (err) => logger.write("dead", err.message));
  c.start();
  const init = await c.initialize();
  logger.write("initialize-response", JSON.stringify(init).slice(0, 2000));
  return c;
}

async function waitFor(cond, { timeoutMs = 120000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function startOpts(extra = {}) {
  const o = { cwd: WORKDIR, ...extra };
  if (MODEL) o.model = MODEL;
  return o;
}

// ---- a+b+c：启动 / 聊天 / 工具 ----
async function testABC() {
  const logger = makeLogger("abc-startup-chat-tools");
  const c = await bootClient(logger);
  try {
    // a: thread/start 拿原生 thread id
    const ts = await c.threadStart(startOpts());
    logger.write("thread-start-response", JSON.stringify(ts).slice(0, 2000));
    const threadId = ts.thread.id;
    const a_ok =
      typeof threadId === "string" &&
      threadId.length > 10 &&
      ts.thread.cwd.replace(/\\/g, "/").endsWith("fixture/workdir") &&
      typeof ts.thread.path === "string" &&
      ts.thread.path.length > 0;
    record("a", "启动：指定 cwd thread/start 拿原生 id", a_ok ? "PASS" : "FAIL",
      `threadId=${threadId} cwd=${ts.thread.cwd} path=${ts.thread.path || "(null)"}`);
    if (!a_ok) return { c, chatThreadId: null };
    if (!(PICK("b") || PICK("c"))) return { c, chatThreadId: null };

    // b 第 1 轮：埋暗号；b 第 2 轮（多轮上下文）+ c 工具（echo）合并为一个 turn，控制模型调用次数
    modelCallCount++;
    const r1 = await c.runTurn(threadId, `请只回复这一句话：暗号是 ${MAGIC}，收到请重复一次。`);
    logger.write("turn1-result", JSON.stringify(r1.collected).slice(0, 4000));

    modelCallCount++;
    const r2 = await c.runTurn(threadId,
      `两步任务：1) 只输出我上一句话里的暗号本身；2) 然后用 shell 运行命令 echo poc-tool-ok 并告诉我输出。`);
    logger.write("turn2-result", JSON.stringify(r2.collected).slice(0, 6000));

    // b 校验：每个 itemId 的 delta 拼接 === item/completed 最终 text
    const byItem = new Map();
    for (const d of [...r1.collected.deltas, ...r2.collected.deltas]) {
      byItem.set(d.itemId, (byItem.get(d.itemId) || "") + d.delta);
    }
    const finals = new Map();
    for (const [id, item] of [...r1.collected.agentItems, ...r2.collected.agentItems]) finals.set(id, item.text);
    let deltaConsistent = byItem.size > 0 && finals.size > 0;
    const mismatch = [];
    for (const [id, finalText] of finals) {
      const joined = byItem.get(id);
      if (joined === undefined) {
        deltaConsistent = false;
        mismatch.push(`itemId=${id} 无任何 delta`);
      } else if (joined !== finalText) {
        deltaConsistent = false;
        mismatch.push(`itemId=${id} 拼接(${joined.length}字)!=最终(${finalText.length}字)`);
      }
    }
    const turn2Texts = [...r2.collected.agentItems.values()].map((i) => i.text).join("\n");
    const b_ok = r1.turn?.status === "completed" && r2.turn?.status === "completed" &&
      turn2Texts.includes(MAGIC) && deltaConsistent;
    record("b", "聊天：≥2 轮流式无重复丢失", b_ok ? "PASS" : "FAIL",
      `turn1=${r1.turn?.status} turn2=${r2.turn?.status} 暗号复现=${turn2Texts.includes(MAGIC)} delta一致=${deltaConsistent}${mismatch.length ? " " + mismatch.join(";") : ""}`);

    // c 校验：commandExecution 工具条目
    const cmdSlots = [...r2.collected.cmdItems.values()];
    const echoSlot = cmdSlots.find((s) => (s.completed?.command || s.started?.command || "").includes("echo"));
    const c_ok = !!echoSlot?.completed &&
      (echoSlot.completed.aggregatedOutput || "").includes("poc-tool-ok") &&
      echoSlot.completed.exitCode === 0;
    record("c", "工具：命令调用开始/参数/输出/结束", c_ok ? "PASS" : "FAIL",
      echoSlot?.completed
        ? `cmd="${echoSlot.completed.command}" exit=${echoSlot.completed.exitCode} out="${(echoSlot.completed.aggregatedOutput || "").trim().slice(0, 80)}"`
        : `未捕获 echo 命令条目（cmdItems=${cmdSlots.length}）`);
    return { c, chatThreadId: threadId };
  } catch (e) {
    logger.write("fatal", e.stack || String(e));
    if (!results.find((r) => r.id === "a")) record("a", "启动", "FAIL", e.message);
    if (!results.find((r) => r.id === "b")) record("b", "聊天", "FAIL", e.message);
    if (!results.find((r) => r.id === "c")) record("c", "工具", "FAIL", e.message);
    return { c, chatThreadId: null };
  }
}

// ---- d：审批（单 turn 内先 accept 后 decline，写文件命令在 read-only 沙箱必触发审批；文件存在性硬校验） ----
async function testD() {
  const logger = makeLogger("d-approval");
  const c = await bootClient(logger);
  try {
    const ts = await c.threadStart(startOpts({ approvalPolicy: "on-request", sandbox: "read-only" }));
    const threadId = ts.thread.id;
    logger.write("thread-start-response", JSON.stringify({ threadId, approvalPolicy: ts.approvalPolicy, sandbox: ts.sandbox }));

    const approvals = [];
    const probeAccept = "probe-accept.txt";
    const probeDeny = "probe-deny.txt";
    c.onServerRequest("item/commandExecution/requestApproval", (params) => {
      approvals.push(params);
      const decision = approvals.length === 1 ? "accept" : "decline"; // 第一次 accept，第二次起 decline
      logger.write("approval-decision", JSON.stringify({ n: approvals.length, decision, command: params.command, itemId: params.itemId }).slice(0, 800));
      return { decision };
    });

    modelCallCount++;
    const r = await c.runTurn(threadId,
      `请严格分两次、分别运行下面两条独立命令（不要合并成一条）：\n1) echo approved > ${probeAccept}\n2) echo denied > ${probeDeny}\n运行完告诉我每个命令的结果。`);
    logger.write("approval-turn-result", JSON.stringify(r.collected).slice(0, 6000));
    const { existsSync } = await import("node:fs");
    const acceptFile = existsSync(path.join(WORKDIR, probeAccept));
    const denyFile = existsSync(path.join(WORKDIR, probeDeny));
    // d1 approve：至少一次审批请求、accept 后文件真实创建、turn 完成
    const d1_ok = approvals.length >= 1 && acceptFile && r.turn?.status === "completed";
    record("d1", "审批 approve：收到请求→accept→执行完成", d1_ok ? "PASS" : "FAIL",
      `审批请求数=${approvals.length} turn=${r.turn?.status} ${probeAccept}创建=${acceptFile}`);
    // d2 deny：收到第二次审批、decline 后文件未创建（命令未执行）
    const d2_ok = approvals.length >= 2 && !denyFile;
    record("d2", "审批 deny：decline 后不执行（文件未创建）", d2_ok ? "PASS" : "FAIL",
      `审批请求数=${approvals.length} ${probeDeny}不存在=${!denyFile}`);
  } catch (e) {
    logger.write("fatal", e.stack || String(e));
    if (!results.find((x) => x.id === "d1")) record("d1", "审批 approve", "FAIL", e.message);
    if (!results.find((x) => x.id === "d2")) record("d2", "审批 deny", "FAIL", e.message);
  } finally {
    c.stop();
  }
}

// ---- e+f：取消 / 并发 ----
async function testEF() {
  const logger = makeLogger("ef-interrupt-concurrency");
  const c = await bootClient(logger);
  try {
    const ts = await c.threadStart(startOpts());
    const threadId = ts.thread.id;
    logger.write("thread-start-response", JSON.stringify({ threadId }));

    // e1：长 turn 进行中 interrupt
    modelCallCount++;
    let liveDeltas = 0;
    const deltaListener = (e) => {
      if (e.detail.method === "item/agentMessage/delta" && e.detail.params?.threadId === threadId) liveDeltas++;
    };
    c.addEventListener("*", deltaListener);
    const turnP = c.runTurn(threadId, "从 1 慢慢数到 40，每行一个数字，必须完整输出所有数字，不要省略任何数字。");
    await waitFor(() => liveDeltas >= 1, { timeoutMs: 60000 });
    logger.write("interrupting", `deltas so far=${liveDeltas}`);
    const turnId = turnIdsByThread.get(threadId) || "";
    const interruptRes = await c.request("turn/interrupt", { threadId, turnId });
    logger.write("interrupt-response", JSON.stringify(interruptRes).slice(0, 500));
    const rInt = await turnP;
    c.removeEventListener("*", deltaListener);
    logger.write("interrupted-turn-result", JSON.stringify(rInt.collected).slice(0, 4000));
    const e1_ok = rInt.turn?.status === "interrupted";
    record("e1", "取消：interrupt 后 turn 状态 interrupted", e1_ok ? "PASS" : "FAIL", `turn=${rInt.turn?.status}`);

    // e2 + f 合并：interrupt 过的 thread-E 作为 3 个并发 thread 之一继续新 turn——
    // 其成功同时证明「取消后 Session 仍可继续」(e2) 与「多 thread 并发互不干扰」(f)，节省模型调用
    const newThreads = [];
    for (let i = 0; i < 2; i++) newThreads.push((await c.threadStart(startOpts())).thread.id);
    const threads = [threadId, ...newThreads]; // thread-E 在列
    logger.write("concurrent-threads", JSON.stringify(threads));
    modelCallCount += 3;
    const keywords = ["recovered", "banana", "cherry"]; // thread-E 的关键词兼作 e2 恢复信号
    const rs = await Promise.all(threads.map((tid, i) =>
      c.runTurn(tid, `请只回复一个英文单词：${keywords[i]}`).then((r) => ({ tid, i, r }))));
    logger.write("concurrent-results", JSON.stringify(rs.map(({ tid, i, r }) => ({
      tid, i, status: r.turn?.status,
      texts: [...r.collected.agentItems.values()].map((x) => x.text.slice(0, 40)),
    }))).slice(0, 3000));
    const rE = rs[0]; // thread-E 的结果
    const e2_ok = rE.r.turn?.status === "completed" &&
      [...rE.r.collected.agentItems.values()].map((x) => x.text).join("").toLowerCase().includes(keywords[0]);
    record("e2", "取消后：同 thread 新 turn 正常继续", e2_ok ? "PASS" : "FAIL", `turn=${rE.r.turn?.status}（作为并发 t0 完成）`);
    const f_ok = rs.slice(1).every(({ i, r }) => {
      const text = [...r.collected.agentItems.values()].map((x) => x.text).join("");
      return r.turn?.status === "completed" && text.toLowerCase().includes(keywords[i]);
    }) && e2_ok;
    record("f", "并发：3 thread 同时运行互不干扰", f_ok ? "PASS" : "FAIL",
      rs.map(({ i, r }) => `t${i}=${r.turn?.status}:"${[...r.collected.agentItems.values()].map((x) => x.text.trim().slice(0, 20)).join("|")}"`).join(" ; "));
    return { c };
  } catch (e) {
    logger.write("fatal", e.stack || String(e));
    if (!results.find((r) => r.id === "e1")) record("e1", "取消 interrupt", "FAIL", e.message);
    if (!results.find((r) => r.id === "e2")) record("e2", "取消后继续", "FAIL", e.message);
    if (!results.find((r) => r.id === "f")) record("f", "并发", "FAIL", e.message);
    return { c };
  }
}

// ---- g：恢复（读 abc 阶段的 thread；正常退出 → 新进程 → read + resume + 上下文延续） ----
async function testG(chatThreadId) {
  const logger = makeLogger("g-resume");
  const stateFile = path.join(LOG_DIR, "g-thread-state.json");
  let c = null;
  try {
    if (chatThreadId) writeFileSync(stateFile, JSON.stringify({ chatThreadId }, null, 2));
    const { chatThreadId: tid } = JSON.parse(readFileSync(stateFile, "utf8"));
    c = await bootClient(logger);
    // g1: thread/read 直接读磁盘历史
    const read1 = await c.request("thread/read", { threadId: tid, includeTurns: true });
    logger.write("thread-read-1", JSON.stringify(read1).slice(0, 4000));
    const turns1 = read1.thread.turns || [];
    const g1_ok = turns1.length >= 2 &&
      turns1.flatMap((t) => t.items).some((i) => i.type === "userMessage" && i.content.some((u) => u.type === "text" && u.text.includes(MAGIC)));
    // g2: resume 后问依赖上一轮内容的问题
    const resumed = await c.request("thread/resume", { threadId: tid });
    logger.write("thread-resume", JSON.stringify({ id: resumed.thread.id, turns: resumed.thread.turns?.length }));
    const g2_ok = resumed.thread.id === tid && (resumed.thread.turns || []).length >= 2;
    modelCallCount++;
    const r = await c.runTurn(tid, "我最早告诉你的暗号是什么？只输出暗号本身，不要其他文字。");
    logger.write("resume-turn-result", JSON.stringify(r.collected).slice(0, 4000));
    const answer = [...r.collected.agentItems.values()].map((i) => i.text).join("");
    const g3_ok = r.turn?.status === "completed" && answer.includes(MAGIC);
    record("g", "恢复：read 历史 + resume + 上下文延续", g1_ok && g2_ok && g3_ok ? "PASS" : "FAIL",
      `read含暗号=${g1_ok}(turns=${turns1.length}) resume=${g2_ok} 回答含暗号=${g3_ok}("${answer.trim().slice(0, 40)}")`);
  } catch (e) {
    logger.write("fatal", e.stack || String(e));
    record("g", "恢复", "FAIL", e.message);
  } finally {
    if (c) c.stop();
  }
}

// ---- h：异常（kill 子进程 → 明确报错、不崩溃、不自动重放） ----
async function testH() {
  const logger = makeLogger("h-crash");
  try {
    const c = await bootClient(logger);
    const ts = await c.threadStart(startOpts());
    logger.write("thread-start-response", JSON.stringify({ threadId: ts.thread.id }));
    await new Promise((r) => setTimeout(r, 1000)); // 进程就绪
    logger.write("killing", "proc.kill(SIGKILL) — Windows 等效 TerminateProcess");
    c.proc.kill("SIGKILL");
    let rpcError = null;
    try {
      await c.request("thread/list", {});
    } catch (e) {
      rpcError = e.message;
    }
    await new Promise((r) => setTimeout(r, 500));
    let secondError = null;
    try {
      await c.request("thread/read", { threadId: ts.thread.id });
    } catch (e) {
      secondError = e.message;
    }
    const h_ok = c.dead && !!rpcError && !!secondError && !c.autoRestarted;
    record("h", "异常：kill 后明确报错、不自动重放", h_ok ? "PASS" : "FAIL",
      `dead=${c.dead} 首个请求错误="${rpcError}" 后续请求错误="${secondError}"`);
  } catch (e) {
    logger.write("fatal", e.stack || String(e));
    record("h", "异常", "FAIL", e.message);
  }
}

// ---- main ----
(async () => {
  console.log(`codex command: ${JSON.stringify(resolveCodexCommand())}`);
  console.log(`workdir: ${WORKDIR}`);
  let chatThreadId = null;
  let abcClient = null;

  if (PICK("a") || PICK("b") || PICK("c")) {
    const r = await testABC();
    chatThreadId = r.chatThreadId;
    abcClient = r.c;
  }
  if (PICK("d")) await testD();
  if (PICK("e") || PICK("f")) {
    const r = await testEF();
    if (r.c) r.c.stop();
  }
  if (PICK("g")) await testG(chatThreadId);
  if (PICK("h")) await testH();
  if (abcClient) abcClient.stop();

  console.log("\n==== 汇总 ====");
  for (const r of results) console.log(`${r.status.padEnd(6)} ${r.id.padEnd(3)} ${r.name}`);
  console.log(`真实模型 turn 调用次数：${modelCallCount}（上限 10）`);
  writeFileSync(path.join(LOG_DIR, "summary.json"), JSON.stringify({ results, modelCallCount }, null, 2));
  setTimeout(() => process.exit(0), 1500);
})().catch((e) => {
  console.error("RUNNER FATAL:", e);
  process.exit(1);
});
