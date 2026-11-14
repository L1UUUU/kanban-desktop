// 用途：事件发送器工厂密封测试 —— 非法载荷 throw / 目标窗口缺失静默丢弃 / 正常发送通道与载荷透传（#72 C1 Step3 新增）；arch C10 增 parse 前置变体（免二次校验，仅窗口判定与发送）
import { describe, expect, it } from "vitest";
import { createPassthroughSender, createValidatedSender, type EventTarget } from "./event-sender";

/** fake 载荷契约：非空字符串才合法（结构面 EventPayloadSchema，等价 zod z.string().min(1) 的判定面） */
const nameSchema = {
  parse: (payload: unknown): string => {
    if (typeof payload === "string" && payload.length > 0) return payload;
    throw new Error("invalid payload");
  },
};

/** fake 窗口（记录 send 调用） */
function makeTarget(): { target: EventTarget; sent: Array<{ channel: string; payload: unknown }> } {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return { target: { webContents: { send: (channel, payload) => sent.push({ channel, payload }) } }, sent };
}

describe("createValidatedSender", () => {
  it("正常路径：合法载荷经校验后按通道透传", () => {
    const { target, sent } = makeTarget();
    const send = createValidatedSender(nameSchema, "test:event", () => target);
    send("hello");
    expect(sent).toEqual([{ channel: "test:event", payload: "hello" }]);
  });

  it("非法载荷：parse 抛错冒泡（DEV 出站校验语义），不发送", () => {
    const { target, sent } = makeTarget();
    const send = createValidatedSender(nameSchema, "test:event", () => target);
    expect(() => send("")).toThrow("invalid payload");
    expect(sent).toHaveLength(0);
  });

  it("目标窗口缺失（未建/已销毁 → getWindow 返回 null）：静默丢弃不抛不发", () => {
    const send = createValidatedSender(nameSchema, "test:event", () => null);
    expect(() => send("hello")).not.toThrow();
  });
});

describe("createPassthroughSender（parse 前置变体）", () => {
  it("载荷原样透传（不校验：空串等上游已校验形态直接发送）", () => {
    const { target, sent } = makeTarget();
    const send = createPassthroughSender<string>("chat:event", () => target);
    send("");
    send("hello");
    expect(sent).toEqual([
      { channel: "chat:event", payload: "" },
      { channel: "chat:event", payload: "hello" },
    ]);
  });

  it("目标窗口缺失：静默丢弃不抛不发（与校验变体同语义）", () => {
    const send = createPassthroughSender<string>("chat:event", () => null);
    expect(() => send("hello")).not.toThrow();
  });
});
