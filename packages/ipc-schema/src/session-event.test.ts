// 用途：session:event 轻通道 schema 密封测试（#95 / ADR 0003 决策 2 摘要段）—— main→renderer 标题推送契约（独立于 ChatEvent 冻结 union，seq 不变量不受影响）
import { describe, expect, it } from "vitest";
import { sessionEventSchema } from "./session-event";

describe("sessionEventSchema（#95 session:event 轻通道）", () => {
  it("合法 title 事件通过校验", () => {
    expect(() =>
      sessionEventSchema.parse({ type: "title", sessionId: "s-1", title: "摘要标题" }),
    ).not.toThrow();
    expect(sessionEventSchema.parse({ type: "title", sessionId: "s-1", title: "摘要标题" })).toEqual({
      type: "title",
      sessionId: "s-1",
      title: "摘要标题",
    });
  });

  it("缺字段 / 空串 / 未知成员类型被拒绝", () => {
    expect(() => sessionEventSchema.parse({ type: "title", sessionId: "s-1" })).toThrow(); // 缺 title
    expect(() => sessionEventSchema.parse({ type: "title", title: "t" })).toThrow(); // 缺 sessionId
    expect(() => sessionEventSchema.parse({ type: "title", sessionId: "", title: "t" })).toThrow(); // 空 sessionId
    expect(() => sessionEventSchema.parse({ type: "title", sessionId: "s-1", title: "" })).toThrow(); // 空标题无意义
    expect(() => sessionEventSchema.parse({ type: "archived", sessionId: "s-1", title: "t" })).toThrow(); // 未知成员
    expect(() => sessionEventSchema.parse({ sessionId: "s-1", title: "t" })).toThrow(); // 缺判别字段
  });

  it("契约形状冻结：成员类型仅 title（新增成员须扩 discriminatedUnion 并回归本套）", () => {
    const shape = sessionEventSchema.options.map((o) => o.shape.type.value);
    expect(shape).toEqual(["title"]);
  });
});
