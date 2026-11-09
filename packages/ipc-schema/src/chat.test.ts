// 用途：ChatEvent 全成员 zod 往返测试 —— 13 成员（spec B 冻结清单）逐个合法样例等值 parse、非法形状被拒（spec Testing seam 3）
import { describe, expect, it } from "vitest";
import { adapterEventSchema, chatEventSchema, sessionErrorCodeSchema, skillObservationSchema } from "./chat";

// 独立于实现的期望来源：spec B 的成员清单与合并键语义（itemId/partId/seq）
const base = { sessionId: "s-1", seq: 3, at: "2026-11-05T10:00:00.000Z" };

const validSamples: Record<string, Record<string, unknown>> = {
  turn_started: { ...base, type: "turn_started", turnId: "t-1" },
  message_delta: { ...base, type: "message_delta", itemId: "m-1", partId: "0", delta: "你" },
  message_completed: { ...base, type: "message_completed", itemId: "m-1", partId: "0" },
  tool_started: { ...base, type: "tool_started", itemId: "tl-1", tool: "Bash", argsSummary: "pnpm test" },
  tool_update: { ...base, type: "tool_update", itemId: "tl-1", outputDelta: " ✓ 1 passed\n" },
  tool_completed: {
    ...base,
    type: "tool_completed",
    itemId: "tl-1",
    status: "completed",
    durationMs: 3600,
    output: "Tests 13 passed",
  },
  approval_requested: {
    ...base,
    type: "approval_requested",
    requestId: "ap-1",
    itemId: "tl-2",
    command: "Edit packages/ipc-schema/src/index.ts",
    suggestions: [
      { kind: "addRules", label: "允许规则", detail: "Edit(src/**) 后续免询问" },
      { kind: "addDirectories", label: "允许目录", detail: "packages/ipc-schema/** 整目录" },
    ],
  },
  approval_expired: { ...base, type: "approval_expired", requestId: "ap-1", reason: "timed_out" },
  turn_completed: { ...base, type: "turn_completed" },
  turn_interrupted: { ...base, type: "turn_interrupted" },
  turn_interrupted_with_reason: { ...base, type: "turn_interrupted", reason: "user" },
  session_status_running: { ...base, type: "session_status", status: "running" },
  session_status_waiting: { ...base, type: "session_status", status: "waiting" },
  session_status_interrupted: { ...base, type: "session_status", status: "interrupted" },
  session_status_disconnected: { ...base, type: "session_status", status: "disconnected" },
  session_error: { ...base, type: "session_error", code: "INTERNAL", message: "turn 失败" },
  session_exit: { ...base, type: "session_exit", exitCode: 1 },
  session_exit_with_reason: { ...base, type: "session_exit", exitCode: 0, reason: "正常退出" },
};

describe("chatEventSchema 全成员往返（spec B 13 成员）", () => {
  it.each(Object.entries(validSamples))("%s：合法样例 parse 后等值", (_name, sample) => {
    expect(chatEventSchema.parse(sample)).toEqual(sample);
  });

  it("非法成员名被拒（不在 13 成员冻结清单内）", () => {
    expect(() => chatEventSchema.parse({ ...base, type: "user_message", text: "hi" })).toThrow();
  });

  it("合并键缺失被拒：message_delta 无 itemId / tool_update 无 itemId", () => {
    const { itemId: _omit, ...noItemId } = validSamples.message_delta;
    expect(() => chatEventSchema.parse(noItemId)).toThrow();
    const { itemId: _omit2, ...noToolItemId } = validSamples.tool_update;
    expect(() => chatEventSchema.parse(noToolItemId)).toThrow();
  });

  it("seq 必须是非负整数（快照/增量拼接依据，不变量 3/4）", () => {
    expect(() => chatEventSchema.parse({ ...validSamples.turn_started, seq: -1 })).toThrow();
    expect(() => chatEventSchema.parse({ ...validSamples.turn_started, seq: 1.5 })).toThrow();
    expect(() => chatEventSchema.parse({ ...validSamples.turn_started, seq: "3" })).toThrow();
  });

  it("session_status 枚举外取值被拒", () => {
    expect(() => chatEventSchema.parse({ ...validSamples.session_status_running, status: "paused" })).toThrow();
  });

  // #41 C1 演进：code 收紧为六成员闭枚举（AUTH_EXPIRED/SPAWN_NOT_FOUND/PROTOCOL_DISCONNECT/CLI_EXIT/INTERNAL/UNKNOWN）
  it("session_error.code 六成员闭枚举逐个合法（round-trip 等值）", () => {
    for (const code of sessionErrorCodeSchema.options) {
      const sample = { ...base, type: "session_error", code, message: "m" };
      expect(chatEventSchema.parse(sample)).toEqual(sample);
    }
  });

  it("session_error.code 枚举外取值被拒（旧 E_* 前缀值不再合法）", () => {
    expect(() => chatEventSchema.parse({ ...validSamples.session_error, code: "E_INTERNAL" })).toThrow();
    expect(() => chatEventSchema.parse({ ...validSamples.session_error, code: "E_FAKE_CRASH" })).toThrow();
    expect(() => chatEventSchema.parse({ ...validSamples.session_error, code: "" })).toThrow();
  });

  it("tool_completed 状态枚举外取值被拒", () => {
    expect(() =>
      chatEventSchema.parse({ ...validSamples.tool_completed, status: "running" }),
    ).toThrow();
  });

  it("approval_requested 的 suggestions 为对象数组（label/detail/kind）", () => {
    expect(() =>
      chatEventSchema.parse({
        ...validSamples.approval_requested,
        suggestions: [{ kind: "addRules", label: "允许规则" }],
      }),
    ).toThrow();
  });
});

describe("skillObservationSchema / adapterEventSchema（C2 冻结形状）", () => {
  const skillEvent = {
    eventId: "ev-1",
    kind: "skill",
    sessionId: "s-1",
    cli: "codex",
    skill: "design-feature",
    stage: "design",
    requirementId: null,
    occurredAt: "2026-11-05T10:00:00.000Z",
    receivedAt: "2026-11-05T10:00:01.000Z",
    seq: null,
    evidenceLevel: "self_reported",
    source: "codex-adapter",
  };

  it("skill 观察事件合法样例等值（#6 只需形状，不消费）", () => {
    expect(skillObservationSchema.parse(skillEvent)).toEqual(skillEvent);
  });

  it("adapterEvent 接受 ChatEvent 与 SkillObservation 两类", () => {
    expect(adapterEventSchema.parse(validSamples.turn_started)).toEqual(validSamples.turn_started);
    expect(adapterEventSchema.parse(skillEvent)).toEqual(skillEvent);
  });

  it("evidenceLevel 枚举外取值被拒", () => {
    expect(() => skillObservationSchema.parse({ ...skillEvent, evidenceLevel: "strong" })).toThrow();
  });
});
