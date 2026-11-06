// 用途：chunk 密封测试 —— chunkEvents 分段纯函数（会话边界优先 + maxChars 累计 + 单事件硬切，演进自 poc-5；spec #27 F 节 / issue #30）
import { describe, expect, it } from "vitest";
import { MAX_CHUNK_CHARS, chunkEvents, type MemoryEvent } from "./chunk";

const ev = (over: Partial<MemoryEvent> & Pick<MemoryEvent, "sessionId" | "text">): MemoryEvent => ({
  cli: "claude",
  role: "user",
  ...over,
});

describe("chunkEvents（分段纯函数）", () => {
  it("空输入不分段", () => {
    expect(chunkEvents([])).toEqual([]);
  });

  it("会话边界优先：不同会话的事件切为独立段，段内来源归属干净", () => {
    const chunks = chunkEvents([
      ev({ sessionId: "s1", role: "user", text: "开始做任务 A" }),
      ev({ sessionId: "s1", role: "assistant", text: "已完成" }),
      ev({ cli: "codex", sessionId: "s2", role: "user", text: "接着做任务 B" }),
      ev({ cli: "codex", sessionId: "s2", role: "assistant", text: "也完成了" }),
    ]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].sessions).toEqual([{ id: "s1", cli: "claude" }]);
    expect(chunks[1].sessions).toEqual([{ id: "s2", cli: "codex" }]);
    expect(chunks.map((c) => c.index)).toEqual([0, 1]);
    // 双视角都在渲染文本中（user/assistant 标签 + 原文）
    expect(chunks[0].text).toContain("user");
    expect(chunks[0].text).toContain("开始做任务 A");
    expect(chunks[0].text).toContain("assistant");
    expect(chunks[0].text).toContain("已完成");
    expect(chunks[1].text).toContain("接着做任务 B");
  });

  it("同会话事件在字符限额内合并为一段", () => {
    const chunks = chunkEvents([
      ev({ sessionId: "s1", text: "第一句" }),
      ev({ sessionId: "s1", text: "第二句" }),
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("第一句");
    expect(chunks[0].text).toContain("第二句");
  });

  it("交错会话：回到已切走的会话另起新段（段按连续会话集合切分）", () => {
    const chunks = chunkEvents([
      ev({ sessionId: "s1", text: "a" }),
      ev({ cli: "codex", sessionId: "s2", text: "b" }),
      ev({ sessionId: "s1", text: "c" }),
    ]);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].sessions).toEqual([{ id: "s1", cli: "claude" }]);
    expect(chunks[1].sessions).toEqual([{ id: "s2", cli: "codex" }]);
    expect(chunks[2].sessions).toEqual([{ id: "s1", cli: "claude" }]);
  });

  it("累计字符超过 maxChars 另起一段（每段不超过限额）", () => {
    // 每行渲染后约 50 字符（标签+正文 30），两行累计 101 > 60 → 切两段
    const chunks = chunkEvents(
      [ev({ sessionId: "s1", text: "x".repeat(30) }), ev({ sessionId: "s1", text: "y".repeat(30) })],
      { maxChars: 60 },
    );
    expect(chunks).toHaveLength(2);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(60);
    expect(chunks[0].sessions).toEqual([{ id: "s1", cli: "claude" }]);
  });

  it("单事件超过 maxChars 时硬切（每片不超过限额，会话归属保持）", () => {
    const chunks = chunkEvents([ev({ sessionId: "s-long", text: "行一\n行二\n行三\n" + "z".repeat(80) })], {
      maxChars: 40,
    });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(40);
      expect(c.sessions).toEqual([{ id: "s-long", cli: "claude" }]);
    }
    // 硬切不丢内容：各片拼接去掉分隔后仍覆盖原文全部字符
    const joined = chunks.map((c) => c.text).join("\n");
    for (const ch of "行一行二行三") expect(joined).toContain(ch);
    expect(joined).toContain("z".repeat(20));
  });

  it("tool 信息（name/summary）渲染进段文本，不丢失工具视角", () => {
    const chunks = chunkEvents([
      ev({ sessionId: "s1", role: "assistant", text: "", tool: { name: "Bash", summary: "ran tests" } }),
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("Bash");
    expect(chunks[0].text).toContain("ran tests");
  });

  it("默认限额 6000 为具名常量（spec #27 F 节）", () => {
    expect(MAX_CHUNK_CHARS).toBe(6000);
    // 默认走 MAX_CHUNK_CHARS：单事件 6001 字符必然硬切
    const chunks = chunkEvents([ev({ sessionId: "s1", text: "字".repeat(MAX_CHUNK_CHARS + 1) })]);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });
});
