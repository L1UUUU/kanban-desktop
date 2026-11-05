// 用途：T4 宿主 B-turn 持有者 —— 以 detached 方式 spawn codex app-server，完成埋暗号 turn 后（或进行中的长 turn）持续存活，把 thread/delta 进度写入状态文件供外层观察；宿主被外层强杀后 codex 成为孤儿
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexClient } from "./codex-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const statePath = arg("--state");
const cwd = arg("--cwd") || path.join(__dirname, "..", "fixture", "workdir-codex");
const model = arg("--model") || process.env.T0_CODEX_MODEL || "gpt-5.6-luna";
const mode = arg("--mode") || "plant-then-idle"; // plant-then-idle：埋暗号 turn 后闲置；counting：埋暗号 turn 后再来一个长数数 turn 且不等它结束
mkdirSync(cwd, { recursive: true });
mkdirSync(path.dirname(statePath), { recursive: true });

const MAGIC = arg("--magic") || `T4-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const st = { hostPid: process.pid, magic: MAGIC, phase: "boot", deltas: 0, threadId: null, turn1Status: null, preCrashTurns: null };
const flush = () => writeFileSync(statePath, JSON.stringify(st, null, 2));

const c = new CodexClient({ cwd, detached: true, log: () => {} }); // detached：宿主死亡后 codex 孤儿存续
try {
  c.start();
  st.codexPid = c.pid;
  st.codexSpawnAt = new Date().toISOString();
  await c.initialize();
  st.phase = "thread";
  flush();
  const ts = await c.request("thread/start", { cwd, model });
  st.threadId = ts.thread.id;
  st.phase = "turn1";
  flush();
  // 轮 1：埋暗号（完成）
  const r1 = await c.runTurn(st.threadId, `请记住暗号 ${MAGIC}。只回复两个字：好的。`);
  st.turn1Status = r1.turn?.status;
  st.phase = "turn1-done";
  flush();
  // 快照：崩溃前已完成 turn 列表（不重放的对照基线）
  const read1 = await c.request("thread/read", { threadId: st.threadId, includeTurns: true });
  st.preCrashTurns = (read1.thread.turns || []).map((t) => ({ id: t.id, status: t.status ?? null }));
  if (mode === "counting") {
    st.phase = "counting";
    flush();
    // 轮 2：长数数 turn，不等待结束（外层看到 delta 增长后强杀本宿主）
    c.runTurn(st.threadId, "请从 1 慢慢数到 200，每个数字一行，不要解释。", { onDelta: () => { st.deltas++; if (st.deltas % 5 === 0) flush(); } }).then(() => {
      st.phase = "counting-done";
      flush();
    });
  } else {
    st.phase = "idle";
    flush();
  }
  // 长驻等外层指令/强杀；安全兜底 10 分钟
  let ended = false;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { if (d.includes("END") && !ended) { ended = true; flush(); c.stop(); process.exit(0); } });
  process.stdin.on("close", () => { if (!ended) { ended = true; flush(); process.exit(0); } }); // stdin 关闭=外层退出，宿主自然退出（codex 保持 detached 存续）
  setTimeout(() => { flush(); process.exit(0); }, 600000).unref();
  setInterval(() => { flush(); }, 2000);
} catch (e) {
  st.phase = "error";
  st.error = e.message;
  flush();
  process.exit(1);
}
