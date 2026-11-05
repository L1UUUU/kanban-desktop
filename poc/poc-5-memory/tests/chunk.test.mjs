// 分段逻辑确定性单测：session 边界优先切分、超长累计切分、单事件硬切、空输入。
import test from "node:test";
import assert from "node:assert/strict";
import { chunkEvents, diceSimilarity, mergeCandidates } from "../lib/normalize.mjs";

const ev = (sessionId, cli, role, text, ts = "t") => ({ sessionId, cli, role, text, ts });

test("空输入返回空段", () => {
  assert.deepEqual(chunkEvents([]), []);
});

test("同一 session 的短历史保持一段", () => {
  const out = chunkEvents([ev("s1", "claude", "user", "hello"), ev("s1", "claude", "assistant", "hi")]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].sessions, [{ id: "s1", cli: "claude" }]);
  assert.match(out[0].text, /hello/);
  assert.match(out[0].text, /hi/);
});

test("跨 session 边界强制分段（即使未超长）", () => {
  const out = chunkEvents([
    ev("s1", "claude", "user", "a"),
    ev("s2", "codex", "user", "b"),
    ev("s2", "codex", "assistant", "c"),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].sessions, [{ id: "s1", cli: "claude" }]);
  assert.deepEqual(out[1].sessions, [{ id: "s2", cli: "codex" }]);
  assert.match(out[0].text, /a/);
  assert.doesNotMatch(out[0].text, /b/);
});

test("累计超长在事件边界切分，不撕裂单事件", () => {
  const events = [];
  for (let i = 0; i < 10; i++) events.push(ev("s1", "claude", "user", `msg-${i}-${"x".repeat(300)}`));
  const out = chunkEvents(events, { maxChars: 1000 });
  assert.ok(out.length >= 3, `期望至少 3 段，实际 ${out.length}`);
  for (const c of out) assert.ok(c.text.length <= 1100, `段长 ${c.text.length} 超限`);
  // 事件不被撕裂：每段内的行数与原事件数守恒
  const totalLines = out.reduce((n, c) => n + c.text.split("\n").filter((l) => l.trim()).length, 0);
  assert.equal(totalLines, 10);
});

test("单事件超过 maxChars 时硬切为多片，来源归属保留在段级 sessions", () => {
  const long = "很长。".repeat(2000);
  const out = chunkEvents([ev("s1", "codex", "assistant", long)], { maxChars: 800 });
  assert.ok(out.length >= 2);
  for (const c of out) {
    assert.ok(c.text.length <= 900);
    // 段级元数据保留来源（即使文本片本身不含标签，注入 prompt 时由段头补齐）
    assert.deepEqual(c.sessions, [{ id: "s1", cli: "codex" }]);
  }
  assert.match(out[0].text, /\[codex\/s1/); // 首片带来源标签
});

test("diceSimilarity：相同语义高分、无关低分", () => {
  assert.ok(diceSimilarity("divide 除零必须抛出 Error", "divide 除零时抛出 Error") > 0.5);
  assert.ok(diceSimilarity("divide 除零必须抛出 Error", "multiply 用普通乘法实现") < 0.3);
});

test("mergeCandidates：跨段相似候选合并并取来源并集", () => {
  const a = { claim: "calc.js 的函数都要用 node 直接自测", sourceSessionIds: ["s1"], evidence: "e1", segments: [0] };
  const b = { claim: "calc.js 的函数都要用 node 直接自测", sourceSessionIds: ["s2"], evidence: "e2", segments: [1] };
  const merged = mergeCandidates([a, b]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sourceSessionIds.sort(), ["s1", "s2"]);
  assert.match(merged[0].evidence, /e1 \| e2/);
});
