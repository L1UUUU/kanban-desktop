// 用途：IPC 消息集（session:create/send/interrupt/resolveApproval + project/session CRUD）与错误码形状的 zod 往返测试（spec E/C4）
import { describe, expect, it } from "vitest";
import { errorCodeSchema, ipcRequestSchema, ipcResultSchema, projectRowSchema, sessionRowSchema } from "./ipc";

const demoProject = {
  id: "p-1",
  name: "kanban-desktop",
  canonicalPath: "C:\\project2\\kanban-desktop",
  status: "ok",
  createdAt: "2026-11-05T00:00:00.000Z",
};

const demoSession = {
  id: "s-1",
  kind: "structured",
  cli: "claude",
  nativeSessionId: null,
  projectId: "p-1",
  title: "新会话 · Claude",
  cwd: "C:\\project2\\kanban-desktop",
  permMode: "auto",
  status: "disconnected",
  lastActiveAt: null,
  dirIdentity: "main",
  worktreeName: null,
};

describe("project/session 行 schema（wire 形状）", () => {
  it("projectRow：合法往返；status 枚举外被拒", () => {
    expect(projectRowSchema.parse(demoProject)).toEqual(demoProject);
    expect(() => projectRowSchema.parse({ ...demoProject, status: "gone" })).toThrow();
    expect(() => projectRowSchema.parse({ ...demoProject, canonicalPath: "" })).toThrow();
  });

  it("sessionRow：合法往返（可空列 + 目录身份）；kind/dirIdentity 枚举外被拒", () => {
    expect(sessionRowSchema.parse(demoSession)).toEqual(demoSession);
    expect(sessionRowSchema.parse({ ...demoSession, dirIdentity: "worktree", worktreeName: "poc7" })).toMatchObject({
      dirIdentity: "worktree",
      worktreeName: "poc7",
    });
    expect(() => sessionRowSchema.parse({ ...demoSession, kind: "tty" })).toThrow();
    expect(() => sessionRowSchema.parse({ ...demoSession, dirIdentity: "submodule" })).toThrow();
  });
});

describe("ipcRequestSchema 最小消息集", () => {
  it("session:create：合法（cli=fake 最小集；三 CLI 枚举随 #7/#9/#10 放开）", () => {
    const req = { channel: "session:create", cli: "fake", cwd: "C:\\project2\\kanban-desktop" };
    expect(ipcRequestSchema.parse(req)).toEqual(req);
  });

  it("session:create：可选字段 permMode/model/title/projectId 合法，permMode 枚举外被拒；三 CLI 枚举已放开（#8）", () => {
    const req = {
      channel: "session:create",
      cli: "claude",
      cwd: "C:\\p",
      projectId: "p-1",
      permMode: "ask",
      model: "gpt-5.6-luna",
      title: "演示会话",
    };
    expect(ipcRequestSchema.parse(req)).toEqual(req);
    expect(() => ipcRequestSchema.parse({ ...req, permMode: "yolo" })).toThrow();
    expect(() => ipcRequestSchema.parse({ ...req, cli: "unknown-cli" })).toThrow();
  });

  it("project:list / project:register：无参数请求合法", () => {
    expect(ipcRequestSchema.parse({ channel: "project:list" })).toEqual({ channel: "project:list" });
    expect(ipcRequestSchema.parse({ channel: "project:register" })).toEqual({ channel: "project:register" });
  });

  it("project:switch：projectId 非空", () => {
    const req = { channel: "project:switch", projectId: "p-1" };
    expect(ipcRequestSchema.parse(req)).toEqual(req);
    expect(() => ipcRequestSchema.parse({ channel: "project:switch", projectId: "" })).toThrow();
  });

  it("session:list：projectId 可选（不传=全部）", () => {
    expect(ipcRequestSchema.parse({ channel: "session:list" })).toEqual({ channel: "session:list" });
    expect(ipcRequestSchema.parse({ channel: "session:list", projectId: "p-1" })).toEqual({
      channel: "session:list",
      projectId: "p-1",
    });
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

  it("session:readHistory / session:resume：仅需 sessionId（断开会话恢复入口，#9）", () => {
    const read = { channel: "session:readHistory", sessionId: "s-1" };
    expect(ipcRequestSchema.parse(read)).toEqual(read);
    const resume = { channel: "session:resume", sessionId: "s-1" };
    expect(ipcRequestSchema.parse(resume)).toEqual(resume);
    expect(() => ipcRequestSchema.parse({ channel: "session:readHistory", sessionId: "" })).toThrow();
    expect(() => ipcRequestSchema.parse({ channel: "session:resume" })).toThrow();
  });

  it("未知 channel / 非 discriminated 对象被拒", () => {
    expect(() => ipcRequestSchema.parse({ channel: "session:nuke", sessionId: "s-1" })).toThrow();
    expect(() => ipcRequestSchema.parse(null)).toThrow();
    expect(() => ipcRequestSchema.parse("session:send")).toThrow();
  });
});

describe("错误码与结果形状", () => {
  it("错误码枚举（首版四枚 + E_PROJECT_NOT_FOUND）", () => {
    expect(errorCodeSchema.parse("E_SCHEMA")).toBe("E_SCHEMA");
    expect(errorCodeSchema.parse("E_SESSION_NOT_FOUND")).toBe("E_SESSION_NOT_FOUND");
    expect(errorCodeSchema.parse("E_APPROVAL_EXPIRED")).toBe("E_APPROVAL_EXPIRED");
    expect(errorCodeSchema.parse("E_INTERNAL")).toBe("E_INTERNAL");
    expect(errorCodeSchema.parse("E_PROJECT_NOT_FOUND")).toBe("E_PROJECT_NOT_FOUND");
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

  it("成功结果：project 通道载荷（register 取消 / 注册成功 / 重复注册 / 列表 + 当前项目）", () => {
    expect(ipcResultSchema.parse({ ok: true, canceled: true })).toEqual({ ok: true, canceled: true });
    expect(ipcResultSchema.parse({ ok: true, project: demoProject })).toEqual({ ok: true, project: demoProject });
    expect(ipcResultSchema.parse({ ok: true, project: demoProject, duplicate: true })).toEqual({
      ok: true,
      project: demoProject,
      duplicate: true,
    });
    expect(
      ipcResultSchema.parse({ ok: true, projects: [demoProject], currentProjectId: "p-1" }),
    ).toEqual({ ok: true, projects: [demoProject], currentProjectId: "p-1" });
    expect(ipcResultSchema.parse({ ok: true, currentProjectId: null })).toEqual({ ok: true, currentProjectId: null });
  });

  it("成功结果：session:create 附目录身份载荷（徽标即时渲染）；session:list 载荷（含目录身份的会话行数组）", () => {
    expect(
      ipcResultSchema.parse({ ok: true, sessionId: "s-1", cli: "claude", title: "t", dirIdentity: "worktree", worktreeName: "poc7" }),
    ).toMatchObject({ dirIdentity: "worktree", worktreeName: "poc7" });
    expect(ipcResultSchema.parse({ ok: true, sessions: [demoSession] })).toEqual({ ok: true, sessions: [demoSession] });
    expect(() => ipcResultSchema.parse({ ok: true, sessions: [{ ...demoSession, status: "busy" }] })).toThrow();
  });

  it("成功结果：session:readHistory 附 events（ChatEvent 快照数组，#9 恢复载荷）", () => {
    const delta = {
      sessionId: "s-1",
      seq: 3,
      at: "2026-11-05T10:00:03.000Z",
      type: "message_delta",
      itemId: "m-1",
      partId: "0",
      delta: "好的",
    };
    expect(ipcResultSchema.parse({ ok: true, events: [delta] })).toEqual({ ok: true, events: [delta] });
    expect(() => ipcResultSchema.parse({ ok: true, events: [{ ...delta, seq: -1 }] })).toThrow();
    expect(() => ipcResultSchema.parse({ ok: true, events: [{ ...delta, type: "made_up" }] })).toThrow();
  });
});
