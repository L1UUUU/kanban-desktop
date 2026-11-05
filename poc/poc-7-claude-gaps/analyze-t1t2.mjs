// 用途：从 logs/t1t2-raw-stream.jsonl 重算 T1/T2 判定并更新 logs/t1t2-result.json —— 修正运行脚本内联判定的两处时序口径缺陷（session id 竞态读取、interrupt 后 delta 观察窗口提前退出），重算只基于已落盘原始流，不发起模型调用
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOGS = join(import.meta.dirname, "logs");
const raw = readFileSync(join(LOGS, "t1t2-raw-stream.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const resultPath = join(LOGS, "t1t2-result.json");
const report = JSON.parse(readFileSync(resultPath, "utf8"));

// T1：全部 result 消息的 session_id 一致
const results = raw.filter((m) => m.type === "result");
const sessionIds = results.map((m) => m.session_id).filter(Boolean);
report.judgments.t1_same_session_id = sessionIds.length === results.length && sessionIds.every((s) => s === sessionIds[0]);
report.judgments.t1_result_count = results.length;

// T2：interrupt 发送行之后、turn-2 result 之前的 text_delta 计数；partial 数字 < 30
const sentIdx = raw.findIndex((m) => m.__sent?.request?.subtype === "interrupt");
let deltasAfter = 0;
for (let i = sentIdx + 1; i < raw.length; i++) {
  const m = raw[i];
  if (m.type === "stream_event" && m.event?.delta?.type === "text_delta") deltasAfter++;
  if (m.type === "result") break; // interrupt 后的第一个 result 即被中断轮的终止
}
const interruptedResult = raw.find((m, i) => i > sentIdx && m.type === "result");
const partialText = report.t2.partialText ?? "";
const numbersSeen = (partialText.match(/\b\d+\b/g) ?? []).length;
report.judgments.t2_deltas_after_interrupt = deltasAfter;
report.judgments.t2_output_stopped_partial = deltasAfter === 0 && numbersSeen < 30;
report.judgments.t2_interrupted_result_subtype = interruptedResult?.subtype ?? null;
report.judgments._recomputedFromRaw = "analyze-t1t2.mjs（运行脚本内联判定存在 session id 竞态读取与 interrupt 观察窗口提前退出的口径缺陷，本重算仅依据 t1t2-raw-stream.jsonl）";

writeFileSync(resultPath, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report.judgments, null, 2));
