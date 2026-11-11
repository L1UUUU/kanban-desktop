// 用途：terminal wire 契约往返测试（spec E / Testing seam 3）—— terminal:* 请求 × terminalId 参数化并入 kanban:ipc 单通道 + terminal:event 四成员（started/data/exit/error）载荷形状（沿用旧 Kanban 载荷，PoC 6 0 diff 实证）
import { describe, expect, it } from "vitest";
import { ipcRequestSchema } from "./ipc";
import { terminalCreatePayloadSchema, terminalEventSchema, terminalIdSchema } from "./terminal";

describe("terminal 请求契约（× terminalId 多路复用，spec E）", () => {
  // 渲染端预生成终端 id 样例（uuid 格式与 randomUUID 一致；#60 起草稿首输入触发创建时携带）
  const TID = "3f2a9c1e-8b7d-4e5f-9a2b-1c3d5e7f9a1b";

  it("terminal:create 载荷：terminalId（渲染端预生成 uuid）与 cwd 必填，command/projectId/requirementId/尺寸/firstInput 可选", () => {
    const p = terminalCreatePayloadSchema.parse({ terminalId: TID, cwd: "C:\\repo", command: { exe: "claude", args: [] } });
    expect(p.terminalId).toBe(TID);
    expect(p.cwd).toBe("C:\\repo");
    expect(p.command?.exe).toBe("claude");
    expect(p.command?.args).toEqual([]);

    const bare = terminalCreatePayloadSchema.parse({ terminalId: TID, cwd: "C:\\repo" });
    expect(bare.command).toBeUndefined();
    expect(bare.cols).toBeUndefined();
    expect(bare.firstInput).toBeUndefined();

    // #20：从需求卡片建 PTY 终端——requirementId 可选透传（空串被拒）
    const withReq = terminalCreatePayloadSchema.parse({ terminalId: TID, cwd: "C:\\repo", projectId: "p-1", requirementId: "REQ-001" });
    expect(withReq.requirementId).toBe("REQ-001");
    expect(terminalCreatePayloadSchema.safeParse({ terminalId: TID, cwd: "C:\\repo", requirementId: "" }).success).toBe(false);

    // #60：首输入缓冲可选透传（含中文/多字符原样到达，Main 启动成功后重放）
    const withInput = terminalCreatePayloadSchema.parse({ terminalId: TID, cwd: "C:\\repo", firstInput: "中文abc" });
    expect(withInput.firstInput).toBe("中文abc");
  });

  it("四条 terminal 请求经 ipcRequestSchema（kanban:ipc 单通道）parse 通过", () => {
    expect(ipcRequestSchema.safeParse({ channel: "terminal:create", terminalId: TID, cwd: "C:\\repo", cols: 100, rows: 30 }).success).toBe(true);
    expect(
      ipcRequestSchema.safeParse({ channel: "terminal:create", terminalId: TID, cwd: "C:\\repo", projectId: "p-1", command: { exe: "claude" } }).success,
    ).toBe(true);
    expect(ipcRequestSchema.safeParse({ channel: "terminal:write", terminalId: "t-1", data: "echo hi\r" }).success).toBe(true);
    expect(ipcRequestSchema.safeParse({ channel: "terminal:resize", terminalId: "t-1", cols: 120, rows: 40 }).success).toBe(true);
    expect(ipcRequestSchema.safeParse({ channel: "terminal:kill", terminalId: "t-1" }).success).toBe(true);
  });

  it("非法载荷被拒：缺 terminalId / 非 uuid 终端 id / 空 cwd / 非法尺寸 / 未知通道", () => {
    expect(ipcRequestSchema.safeParse({ channel: "terminal:write", data: "x" }).success).toBe(false);
    expect(ipcRequestSchema.safeParse({ channel: "terminal:write", terminalId: "", data: "x" }).success).toBe(false);
    // #60：terminal:create 的 terminalId 由渲染端预生成，Main 按 uuid 同格式校验（单一 id 空间保护）
    expect(ipcRequestSchema.safeParse({ channel: "terminal:create", cwd: "C:\\repo" }).success).toBe(false);
    expect(ipcRequestSchema.safeParse({ channel: "terminal:create", terminalId: "t-1", cwd: "C:\\repo" }).success).toBe(false);
    expect(ipcRequestSchema.safeParse({ channel: "terminal:create", cwd: "" }).success).toBe(false);
    expect(ipcRequestSchema.safeParse({ channel: "terminal:resize", terminalId: "t-1", cols: 0, rows: 40 }).success).toBe(false);
    expect(terminalIdSchema.safeParse("").success).toBe(false);
  });
});

describe("terminal:event 事件契约（按 terminalId 路由）", () => {
  it("started/data/exit/error 四成员 parse 通过，terminalId 为路由键", () => {
    expect(terminalEventSchema.parse({ terminalId: "t-1", type: "started", shell: "pwsh.exe", cwd: "C:\\repo", pid: 4242 })).toMatchObject({
      type: "started",
      terminalId: "t-1",
    });
    expect(terminalEventSchema.parse({ terminalId: "t-1", type: "data", data: "\x1b[2J" })).toMatchObject({ type: "data" });
    expect(terminalEventSchema.parse({ terminalId: "t-1", type: "exit", exitCode: 0, signal: 1 })).toMatchObject({ type: "exit" });
    expect(terminalEventSchema.parse({ terminalId: "t-1", type: "error", message: "启动失败" })).toMatchObject({ type: "error" });
  });

  it("data 可为空串（流式分片）；exit.signal 可选", () => {
    expect(terminalEventSchema.parse({ terminalId: "t-1", type: "data", data: "" })).toMatchObject({ data: "" });
    expect(terminalEventSchema.parse({ terminalId: "t-1", type: "exit", exitCode: 1 })).not.toHaveProperty("signal");
  });

  it("缺 terminalId / 未知 type / 非整数 pid 被拒", () => {
    expect(terminalEventSchema.safeParse({ type: "data", data: "x" }).success).toBe(false);
    expect(terminalEventSchema.safeParse({ terminalId: "t-1", type: "stdout", data: "x" }).success).toBe(false);
    expect(terminalEventSchema.safeParse({ terminalId: "t-1", type: "started", shell: "s", cwd: "c", pid: 1.5 }).success).toBe(false);
  });
});
