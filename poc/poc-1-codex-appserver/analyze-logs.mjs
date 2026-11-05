// 离线校验：解析 abc 测试的协议日志，校验流式 delta 拼接与最终 agentMessage 文本一致（b 项复核，零模型调用）。
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logFile = path.join(__dirname, "logs", "abc-startup-chat-tools.leaky-run.log");

const deltas = new Map(); // itemId -> 拼接文本
const finals = new Map(); // itemId -> 最终文本（item/completed）
const MAGIC = "ZEBRA-47";

for (const line of readFileSync(logFile, "utf8").trim().split("\n")) {
  const j = JSON.parse(line);
  if (j.kind !== "notify") continue;
  const sp = j.data.indexOf(" ");
  const method = j.data.slice(0, sp);
  let params;
  try { params = JSON.parse(j.data.slice(sp + 1)); } catch { continue; }
  if (method === "item/agentMessage/delta") {
    deltas.set(params.itemId, (deltas.get(params.itemId) || "") + params.delta);
  } else if (method === "item/completed" && params.item?.type === "agentMessage") {
    finals.set(params.item.id, params.item.text);
  }
}

const rows = [];
let allConsistent = true;
for (const [id, text] of finals) {
  const joined = deltas.get(id);
  const consistent = joined !== undefined && joined === text;
  if (!consistent) allConsistent = false;
  rows.push({ itemId: id.slice(0, 12), finalLen: text.length, joinedLen: joined === undefined ? null : joined.length, consistent });
}
const magicHit = [...finals.values()].some((t) => t.includes(MAGIC));
const result = {
  source: path.basename(logFile),
  agentMessages: rows,
  allConsistent,
  magicInFinals: magicHit,
  verdict: allConsistent && magicHit && finals.size >= 2 ? "PASS" : "FAIL",
};
writeFileSync(path.join(__dirname, "logs", "b-delta-verification.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
