// 用途：TranscriptEvent zod 契约测试 —— C1 演进 readTranscript 的返回形状（issue #28 / spec #27 B 节：user/assistant 双视角 + 可选工具标注）
import { describe, expect, it } from "vitest";
import { transcriptEventSchema } from "./transcript";

// 期望来源独立于实现：spec #27 B 节决策原文
// TranscriptEvent = { role: user|assistant, text, tool?: { name, summary } }
describe("transcriptEventSchema（C1 演进：readTranscript 返回形状）", () => {
  it("user 事件：role+text 合法样例 parse 后等值（无 tool）", () => {
    const sample = { role: "user", text: "请实现需求 #28：Adapter readTranscript" };
    expect(transcriptEventSchema.parse(sample)).toEqual(sample);
  });

  it("assistant 纯文本事件合法", () => {
    const sample = { role: "assistant", text: "我先跑一遍现有测试确认基线。" };
    expect(transcriptEventSchema.parse(sample)).toEqual(sample);
  });

  it("assistant 工具调用事件：text 空串 + tool { name, summary } 合法", () => {
    const sample = { role: "assistant", text: "", tool: { name: "Bash", summary: "pnpm vitest run --filter ipc-schema" } };
    expect(transcriptEventSchema.parse(sample)).toEqual(sample);
  });

  it("assistant 文本 + tool 同时携带合法（text 非空且带工具标注）", () => {
    const sample = { role: "assistant", text: "开始执行", tool: { name: "commandExecution", summary: "echo hi" } };
    expect(transcriptEventSchema.parse(sample)).toEqual(sample);
  });

  it("role 枚举外取值被拒（system/tool 等不是角色）", () => {
    expect(() => transcriptEventSchema.parse({ role: "system", text: "hi" })).toThrow();
    expect(() => transcriptEventSchema.parse({ role: "tool", text: "", tool: { name: "Bash", summary: "" } })).toThrow();
  });

  it("text 缺失被拒（工具事件也须携带空串 text，形状齐一）", () => {
    expect(() => transcriptEventSchema.parse({ role: "user" })).toThrow();
    expect(() => transcriptEventSchema.parse({ role: "assistant", tool: { name: "Bash", summary: "x" } })).toThrow();
  });

  it("tool 形状不完整被拒：缺 name / 缺 summary / name 空串", () => {
    expect(() => transcriptEventSchema.parse({ role: "assistant", text: "", tool: { summary: "x" } })).toThrow();
    expect(() => transcriptEventSchema.parse({ role: "assistant", text: "", tool: { name: "Bash" } })).toThrow();
    expect(() => transcriptEventSchema.parse({ role: "assistant", text: "", tool: { name: "", summary: "x" } })).toThrow();
  });
});
