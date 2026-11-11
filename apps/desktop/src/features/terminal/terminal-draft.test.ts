// 用途：PTY 终端草稿控制器单测（#60，spec #57）—— 草稿开启/替换/丢弃、首输入触发创建（不直写输入通道）、创建中缓冲、失败保留缓冲可重试、迟到结果不复活草稿
import { describe, expect, it, vi } from "vitest";
import type { ErrorCode, IpcRequest, IpcResult } from "@kanban/ipc-schema";
import { TerminalDraftController } from "./terminal-draft";

/** 装配夹具：记录 invoke 调用，可编程应答队列（缺省 ok） */
function makeFixture(opts?: { replies?: Array<Promise<IpcResult> | IpcResult> }) {
  const invokes: IpcRequest[] = [];
  const created: Array<{ terminalId: string; remainder: string; ok: IpcResult & { ok: true } }> = [];
  const failed: Array<{ terminalId: string; code: string; message: string }> = [];
  let seq = 0;
  const replies = opts?.replies ?? [];
  const ctrl = new TerminalDraftController({
    invoke: (req) => {
      invokes.push(req);
      const r = replies[seq++];
      return Promise.resolve(r ?? { ok: true, sessionId: "sid", cli: "pty", title: "终端 · pwsh" });
    },
    onCreated: (ev) => created.push(ev),
    onFailed: (ev) => failed.push(ev),
  });
  return { ctrl, invokes, created, failed };
}

const err = (code: ErrorCode, message: string): IpcResult => ({ ok: false, error: { code, message } });
/** 冲刷微任务链（invoke promise 链落定；ms>0 用于迟到应答） */
const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("草稿开启 / 替换 / 丢弃", () => {
  it("open：快照含 uuid 终端 id 与原始参数，不触发任何 invoke", () => {
    const { ctrl, invokes } = makeFixture();
    ctrl.open({ projectId: "p-1", cwd: "C:\\repo", requirementId: "REQ-001" });
    const s = ctrl.getSnapshot();
    expect(s).not.toBeNull();
    expect(s!.terminalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(s).toMatchObject({ projectId: "p-1", cwd: "C:\\repo", requirementId: "REQ-001", creating: false, buffer: "", error: null, cols: 80, rows: 30 });
    expect(invokes).toHaveLength(0);
  });

  it("再次 open：替换草稿（新终端 id）；discard：快照清空", () => {
    const { ctrl } = makeFixture();
    ctrl.open({ projectId: null, cwd: "C:\\a" });
    const first = ctrl.getSnapshot()!.terminalId;
    ctrl.open({ projectId: null, cwd: "C:\\b" });
    const second = ctrl.getSnapshot()!;
    expect(second.terminalId).not.toBe(first);
    expect(second.cwd).toBe("C:\\b");
    ctrl.discard();
    expect(ctrl.getSnapshot()).toBeNull();
  });

  it("快照引用在无变更间稳定（useSyncExternalStore 兼容），变更后引用更新", () => {
    const { ctrl } = makeFixture();
    ctrl.open({ projectId: null, cwd: "C:\\a" });
    const before = ctrl.getSnapshot();
    expect(ctrl.getSnapshot()).toBe(before);
    ctrl.handleInput(before!.terminalId, "x");
    const after = ctrl.getSnapshot();
    expect(after).not.toBe(before);
  });
});

describe("首输入触发创建（不直写输入通道）", () => {
  it("非草稿 id 的输入返回 false（调用方走正常 terminal:write）", () => {
    const { ctrl, invokes } = makeFixture();
    ctrl.open({ projectId: null, cwd: "C:\\a" });
    expect(ctrl.handleInput("other-id", "x")).toBe(false);
    expect(invokes).toHaveLength(0);
  });

  it("首输入（含中文/多字符）→ invoke terminal:create 携带预生成 id + firstInput + cwd/项目/关联；creating=true", () => {
    const { ctrl, invokes } = makeFixture();
    ctrl.open({ projectId: "p-1", cwd: "C:\\repo", requirementId: "REQ-001" });
    const id = ctrl.getSnapshot()!.terminalId;
    expect(ctrl.handleInput(id, "中文abc")).toBe(true);
    expect(invokes).toEqual([
      {
        channel: "terminal:create",
        terminalId: id,
        cwd: "C:\\repo",
        cols: 80,
        rows: 30,
        projectId: "p-1",
        requirementId: "REQ-001",
        firstInput: "中文abc",
      },
    ]);
    expect(ctrl.getSnapshot()!.creating).toBe(true);
  });

  it("创建期间继续输入只缓冲不追加 invoke；成功后 onCreated 收到剩余输入并清空草稿", async () => {
    const { ctrl, invokes, created } = makeFixture();
    ctrl.open({ projectId: null, cwd: "C:\\repo" });
    const id = ctrl.getSnapshot()!.terminalId;
    ctrl.handleInput(id, "中");
    ctrl.handleInput(id, "文abc");
    ctrl.handleInput(id, "\r");
    expect(invokes).toHaveLength(1);

    await flush();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ terminalId: id, remainder: "文abc\r" });
    expect(ctrl.getSnapshot()).toBeNull();
  });

  it("recordSize：草稿 id 记录尺寸并随 create 携带；非草稿 id 返回 false", () => {
    const { ctrl, invokes } = makeFixture();
    ctrl.open({ projectId: null, cwd: "C:\\repo" });
    const id = ctrl.getSnapshot()!.terminalId;
    expect(ctrl.recordSize(id, 120, 40)).toBe(true);
    ctrl.handleInput(id, "a");
    expect(invokes[0]).toMatchObject({ cols: 120, rows: 40 });
    expect(ctrl.recordSize("ghost", 10, 10)).toBe(false);
  });
});

describe("启动失败：缓冲保留可重试", () => {
  it("失败 → 草稿保留（creating=false + error），buffer 完整保留，onFailed 收到错误", async () => {
    const { ctrl, created, failed } = makeFixture({ replies: [err("E_INTERNAL", "启动失败：spawn boom")] });
    ctrl.open({ projectId: null, cwd: "C:\\repo" });
    const id = ctrl.getSnapshot()!.terminalId;
    ctrl.handleInput(id, "中");
    ctrl.handleInput(id, "文");
    await flush();
    expect(created).toHaveLength(0);
    expect(failed).toEqual([{ terminalId: id, code: "E_INTERNAL", message: "启动失败：spawn boom" }]);
    const s = ctrl.getSnapshot()!;
    expect(s).toMatchObject({ terminalId: id, creating: false, buffer: "中文", error: { code: "E_INTERNAL", message: "启动失败：spawn boom" } });
  });

  it("失败后再输入 → 合并缓冲重新创建；重试成功 → 草稿清空、无剩余输入", async () => {
    const { ctrl, invokes, created } = makeFixture({
      replies: [err("E_INTERNAL", "boom"), { ok: true, sessionId: "sid", cli: "pty", title: "终端 · pwsh" }],
    });
    ctrl.open({ projectId: null, cwd: "C:\\repo" });
    const id = ctrl.getSnapshot()!.terminalId;
    ctrl.handleInput(id, "ec");
    await flush();
    ctrl.handleInput(id, "ho x\r"); // 重试触发：firstInput = 全部缓冲合并
    expect(invokes[1]).toMatchObject({ terminalId: id, firstInput: "echo x\r" });
    await flush();
    expect(created).toHaveLength(1);
    expect(created[0].remainder).toBe("");
    expect(ctrl.getSnapshot()).toBeNull();
  });

  it("丢弃后迟到的成功仍上报 onCreated（Main 已落库须登记）；迟到的失败不复活草稿", async () => {
    const okLate = makeFixture({ replies: [new Promise<IpcResult>((r) => setTimeout(() => r({ ok: true, sessionId: "sid", cli: "pty", title: "终端 · pwsh" }), 10))] });
    okLate.ctrl.open({ projectId: null, cwd: "C:\\repo" });
    const okId = okLate.ctrl.getSnapshot()!.terminalId;
    okLate.ctrl.handleInput(okId, "a");
    okLate.ctrl.discard();
    await flush(20);
    expect(okLate.created).toHaveLength(1);
    expect(okLate.ctrl.getSnapshot()).toBeNull();

    const failLate = makeFixture({ replies: [new Promise<IpcResult>((r) => setTimeout(() => r(err("E_INTERNAL", "boom")), 10))] });
    failLate.ctrl.open({ projectId: null, cwd: "C:\\repo" });
    const failId = failLate.ctrl.getSnapshot()!.terminalId;
    failLate.ctrl.handleInput(failId, "a");
    failLate.ctrl.open({ projectId: null, cwd: "C:\\new" }); // 替换成新草稿（旧请求在途）
    await flush(20);
    const s = failLate.ctrl.getSnapshot()!;
    expect(s.cwd).toBe("C:\\new");
    expect(s.error).toBeNull(); // 旧草稿的失败不污染新草稿
  });
});

describe("订阅通知", () => {
  it("open/discard/输入/失败均通知订阅者", async () => {
    const { ctrl } = makeFixture({ replies: [err("E_INTERNAL", "boom")] });
    const listener = vi.fn();
    ctrl.subscribe(listener);
    ctrl.open({ projectId: null, cwd: "C:\\a" });
    expect(listener).toHaveBeenCalledTimes(1);
    ctrl.discard();
    expect(listener).toHaveBeenCalledTimes(2);
    ctrl.open({ projectId: null, cwd: "C:\\a" });
    ctrl.handleInput(ctrl.getSnapshot()!.terminalId, "x");
    expect(listener).toHaveBeenCalledTimes(4);
    await flush();
    expect(listener).toHaveBeenCalledTimes(5); // 失败态变更
  });
});
