// 用途：最小 IPC 消息集（session:create/send/interrupt/resolveApproval）与错误码形状的 zod 往返测试（spec E/C4）
import { describe, expect, it } from "vitest";
import { errorCodeSchema, ipcRequestSchema, ipcResultSchema } from "./ipc";

describe("ipcRequestSchema 最小消息集", () => {
  it("session:create：合法（cli=fake 最小集；三 CLI 枚举随 #7/#9/#10 放开）", () => {
    const req = { channel: "session:create", cli: "fake", cwd: "C:\\project2\\kanban-desktop" };
    expect(ipcRequestSchema.parse(req)).toEqual(req);
  });

  it("session:create：可选字段 permMode/model/title 合法，permMode 枚举外被拒", () => {
    const req = {
      channel: "session:create",
      cli: "fake",
      cwd: "C:\\p",
      permMode: "ask",
      model: "gpt-5.6-luna",
      title: "演示会话",
    };
    expect(ipcRequestSchema.parse(req)).toEqual(req);
    expect(() => ipcRequestSchema.parse({ ...req, permMode: "yolo" })).toThrow();
    expect(() => ipcRequestSchema.parse({ ...req, cli: "codex" })).toThrow();
  });

  it("session:send：text 非空、sessionId 非空", () => {
    const req = { channel: "session:send", sessionId: "s-1", text: "把 ipc-schema 的类型拆成独立文件" };
    expect(ipcRequestSchema.parse(req)).toEqual(req);
    expect(() => ipcRequestSchema.parse({ channel: "session:send", sessionId: "s-1", text: "" })).toThrow();
    expect(() => ipcRequestSchema.parse({ channel: "session:send", sessionId: "", text: "hi" })).toThrow();
  });

  it("session:interrupt：仅需 sessionId", () => {
    const req = { channel: "session:interrupt", sessionId: "s-1" };
    expect(ipcRequestSchema.parse(req)).toEqual(req);
  });

  it("session:resolveApproval：decision 为统一枚举（spec B 审批映射）", () => {
    const req = {
      channel: "session:resolveApproval",
      sessionId: "s-1",
      requestId: "ap-1",
      decision: "allow-always",
    };
    expect(ipcRequestSchema.parse(req)).toEqual(req);
    expect(() => ipcRequestSchema.parse({ ...req, decision: "approved" })).toThrow();
  });

  it("未知 channel / 非 discriminated 对象被拒", () => {
    expect(() => ipcRequestSchema.parse({ channel: "session:nuke", sessionId: "s-1" })).toThrow();
    expect(() => ipcRequestSchema.parse(null)).toThrow();
    expect(() => ipcRequestSchema.parse("session:send")).toThrow();
  });
});

describe("错误码与结果形状", () => {
  it("错误码枚举（首版四枚）", () => {
    expect(errorCodeSchema.parse("E_SCHEMA")).toBe("E_SCHEMA");
    expect(errorCodeSchema.parse("E_SESSION_NOT_FOUND")).toBe("E_SESSION_NOT_FOUND");
    expect(errorCodeSchema.parse("E_APPROVAL_EXPIRED")).toBe("E_APPROVAL_EXPIRED");
    expect(errorCodeSchema.parse("E_INTERNAL")).toBe("E_INTERNAL");
    expect(() => errorCodeSchema.parse("E_WHATEVER")).toThrow();
  });

  it("错误结果：ok=false + code/message", () => {
    const res = { ok: false as const, error: { code: "E_SCHEMA", message: "入站消息不符合契约" } };
    expect(ipcResultSchema.parse(res)).toEqual(res);
    expect(() => ipcResultSchema.parse({ ok: false, error: { code: "E_NOPE", message: "x" } })).toThrow();
  });

  it("成功结果：ok=true（create 附会话元数据，其余通道仅 ok）", () => {
    expect(ipcResultSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(ipcResultSchema.parse({ ok: true, sessionId: "s-1", cli: "fake", title: "演示会话" })).toEqual({
      ok: true,
      sessionId: "s-1",
      cli: "fake",
      title: "演示会话",
    });
  });
});
