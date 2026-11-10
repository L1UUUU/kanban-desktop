// 用途：CliHost seam 单测 —— command 分发（经 AdapterRouter）、事件聚合、未支持 CLI 报错、shutdown 拒绝新命令并 dispose 全部 adapter；run-once/cancel-run-once 命令路由（#29 C5 演进）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CliHost, type HostCommand } from "./cli-host";
import { FakeAdapter } from "../fake-adapter";
import type { AdapterEvent } from "@kanban/ipc-schema";
import type { CliAdapter, DisposeInput } from "../adapter";

function makeHost() {
  const adapters: FakeAdapter[] = [];
  const host = new CliHost((cli) => {
    if (cli === "fake" || cli === "codex") {
      const a = new FakeAdapter();
      adapters.push(a);
      return a as CliAdapter;
    }
    throw new Error(`未支持：${cli}`);
  });
  const events: AdapterEvent[] = [];
  host.subscribe((e) => events.push(e));
  return { host, adapters, events };
}

describe("CliHost seam（C5）", () => {
  it("command createSession 按 cli 分发并返回应用侧 id；未支持 CLI 明确报错", async () => {
    const { host } = makeHost();
    const r = await host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "fake" } });
    expect(r.sessionId).toBeDefined();
    expect(r.nativeSessionId).toBeNull(); // Fake 无原生 id
    const codex = await host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "codex" } });
    expect(codex.sessionId).toBeDefined();
    await expect(host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "claude" } })).rejects.toMatchObject({
      code: "E_INTERNAL",
    });
  });

  it("sendTurn/readHistory 按 sessionId 路由到正确 adapter；事件聚合订阅", async () => {
    const { host, events } = makeHost();
    const s1 = await host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "fake" } });
    const s2 = await host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "codex" } });
    await host.command({ kind: "sendTurn", sessionId: s1.sessionId!, text: "排队消息" });
    await new Promise((r) => setTimeout(r, 1500));
    // 两会话事件都聚合到同一订阅
    const ids = new Set(events.filter((e) => "type" in e).map((e) => (e as { sessionId: string }).sessionId));
    expect(ids.has(s1.sessionId!)).toBe(true);
    const history = await host.command({ kind: "readHistory", sessionId: s1.sessionId! });
    expect(history.events!.length).toBeGreaterThan(0);
    // 第二会话（未发过 turn）：仅 createSession 的初始状态事件
    const h2 = await host.command({ kind: "readHistory", sessionId: s2.sessionId! });
    expect(h2.events!.every((e) => e.type === "session_status")).toBe(true);
  });

  it("readTranscript 命令（#28）：按 sessionId 路由，返回双视角剧本（user 提问 + 助手文本 + 工具标注）；未知会话报错", async () => {
    const { host } = makeHost();
    const s1 = await host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "fake" } });
    await host.command({ kind: "sendTurn", sessionId: s1.sessionId!, text: "拆类型" });
    await new Promise((r) => setTimeout(r, 4000)); // 等 DEFAULT 脚本完整走完（SystemClock 实时推进）
    const r = await host.command({ kind: "readTranscript", sessionId: s1.sessionId! });
    expect(r.transcript).toBeDefined();
    const transcript = r.transcript!;
    expect(transcript.some((e) => e.role === "user" && e.text === "拆类型")).toBe(true);
    expect(transcript.some((e) => e.role === "assistant" && e.text.length > 0)).toBe(true);
    expect(transcript.some((e) => e.tool?.name === "Bash")).toBe(true);
    await expect(host.command({ kind: "readTranscript", sessionId: "nope" })).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
  });

  it("未知会话命令报 E_SESSION_NOT_FOUND", async () => {
    const { host } = makeHost();
    await expect(host.command({ kind: "sendTurn", sessionId: "nope", text: "x" })).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
  });

  it("adoptSession（#13 恢复编排）：按 cli 分发收养并登记路由，后续命令按 sessionId 可达", async () => {
    const { host, events } = makeHost();
    await host.command({
      kind: "adoptSession",
      sessionId: "s-restored",
      nativeSessionId: "native-1",
      cwd: "C:\\demo",
      cli: "codex",
      permMode: "auto",
    });
    // 收养事件（session_status disconnected）聚合到订阅
    expect(events.some((e) => "type" in e && e.type === "session_status" && (e as { sessionId: string }).sessionId === "s-restored")).toBe(true);
    // 路由登记：收养会话的 readHistory/resume/interruptTurn 可达（Fake 实现语义）
    const history = await host.command({ kind: "readHistory", sessionId: "s-restored" });
    expect(history.events).toBeDefined();
    await host.command({ kind: "resume", sessionId: "s-restored" });
    await host.command({ kind: "interruptTurn", sessionId: "s-restored" });
    await expect(
      host.command({ kind: "adoptSession", sessionId: "s-dup", nativeSessionId: "n", cwd: "C:\\demo", cli: "claude" }),
    ).rejects.toMatchObject({ code: "E_INTERNAL" }); // 未支持 CLI
  });

  it("dispose 单会话命令：只终止该会话，其余会话与命令通道可用", async () => {
    const { host } = makeHost();
    const s1 = await host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "fake" } });
    const s2 = await host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "fake" } });
    await host.command({ kind: "dispose", sessionId: s1.sessionId! });
    await expect(host.command({ kind: "readHistory", sessionId: s1.sessionId! })).rejects.toMatchObject({ code: "E_SESSION_NOT_FOUND" });
    await host.command({ kind: "sendTurn", sessionId: s2.sessionId!, text: "还在" }); // 其余会话不受影响
  });

  it("shutdown：拒绝新命令并 dispose 全部 adapter", async () => {
    const { host, adapters } = makeHost();
    await host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "fake" } });
    await host.shutdown({ reason: "test" });
    await expect(host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "fake" } })).rejects.toMatchObject({ code: "E_INTERNAL" });
    // dispose 后原会话不可用
    await expect(host.command({ kind: "readHistory", sessionId: "any" })).rejects.toMatchObject({ code: "E_INTERNAL" });
    expect(adapters.length).toBeGreaterThan(0);
  });
});

describe("CliHost run-once 命令（C5 演进，#29）", () => {
  /** fake CLI（node.exe 直连；KANBAN_CLAUDE_BIN 指向 node.exe 走真实解析链） */
  const FAKE_CLI = path.join(import.meta.dirname, "../../tests/fixtures/fake-cli.mjs");
  let cwd: string;

  beforeAll(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "kb-host-runonce-"));
    process.env.KANBAN_CLAUDE_BIN = process.execPath;
  });

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
    delete process.env.KANBAN_CLAUDE_BIN;
  });

  it("run-once 命令：worker 协议内路由执行，结果经 runOnce 字段回传", { timeout: 20_000 }, async () => {
    const { host } = makeHost();
    const r = await host.command({ kind: "run-once", runId: "h-1", cli: "claude", args: [FAKE_CLI, "ok", "H1"], cwd });
    expect(r.runOnce).toMatchObject({ status: "completed", exitCode: 0 });
    expect(r.runOnce!.stdout).toContain("fake-out:H1");
  });

  it("cancel-run-once 命令：终结进行中执行（cancelled）；未知 runId no-op 不报错", { timeout: 20_000 }, async () => {
    const { host } = makeHost();
    const p = host.command({ kind: "run-once", runId: "h-2", cli: "claude", args: [FAKE_CLI, "sleep", "60000"], cwd });
    await host.command({ kind: "cancel-run-once", runId: "h-2" });
    expect((await p).runOnce).toMatchObject({ status: "cancelled" });
    await expect(host.command({ kind: "cancel-run-once", runId: "nope" })).resolves.toBeDefined();
  });

  it("shutdown：终止进行中的 run-once（cancelled 收口）并拒绝新命令", { timeout: 20_000 }, async () => {
    const { host } = makeHost();
    const p = host.command({ kind: "run-once", runId: "h-3", cli: "claude", args: [FAKE_CLI, "sleep", "60000"], cwd });
    await host.shutdown({ reason: "test" });
    expect((await p).runOnce).toMatchObject({ status: "cancelled" });
    await expect(host.command({ kind: "run-once", runId: "h-4", cli: "claude", args: [FAKE_CLI, "ok"], cwd })).rejects.toMatchObject({ code: "E_INTERNAL" });
  });
});

/** 最小桩 adapter（不含可选成员 listChildPids——聚合方须按空集处理） */
class BaseStubAdapter implements CliAdapter {
  readonly capabilities = { approval: false, interrupt: false, resume: false, readHistory: false, skillSignal: false };
  private n = 0;
  private readonly handlers = new Set<(event: AdapterEvent) => void>();
  async createSession(): Promise<{ sessionId: string; nativeSessionId?: string | null }> {
    this.n += 1;
    return { sessionId: `s-pid-${this.n}`, nativeSessionId: null };
  }
  async sendTurn(): Promise<void> {}
  async interruptTurn(): Promise<void> {}
  async resolveApproval(): Promise<void> {}
  async readHistory(): Promise<never[]> {
    return [];
  }
  async readTranscript(): Promise<never[]> {
    return [];
  }
  async resume(): Promise<void> {}
  async dispose(input?: DisposeInput): Promise<void> {
    void input;
  }
  subscribe(handler: (event: AdapterEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}

/** pid 桩 adapter：listChildPids 受控；全量 dispose 清空（镜像进程终止语义） */
class PidStubAdapter extends BaseStubAdapter {
  pids: number[] = [];
  override async dispose(input?: DisposeInput): Promise<void> {
    if (!input?.sessionId) this.pids = [];
  }
  async listChildPids(): Promise<number[]> {
    return [...this.pids];
  }
}

describe("CliHost listChildPids 命令（C5 演进，#44）", () => {
  /** 工厂按 cli 记录桩实例（Router 构造器还会预热探测 fake/codex/claude/opencode 四个实例，索引不可靠） */
  function makePidHost() {
    const created = new Map<string, BaseStubAdapter>();
    const host = new CliHost((cli) => {
      const a = cli === "bare" ? new BaseStubAdapter() : new PidStubAdapter();
      created.set(cli, a);
      return a as CliAdapter;
    });
    return { host, stubOf: (cli: string) => created.get(cli) as PidStubAdapter };
  }

  it("聚合全部 Adapter 的 pid：去重升序；未实现可选成员的 Adapter 贡献空集；空 host 为空集", async () => {
    const { host, stubOf } = makePidHost();
    expect(await host.command({ kind: "listChildPids" })).toEqual({ pids: [] }); // 空集合
    await host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "a" } });
    await host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "b" } });
    await host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "bare" } }); // 未实现可选成员
    stubOf("a").pids = [300, 100];
    stubOf("b").pids = [100, 200];
    expect(await host.command({ kind: "listChildPids" })).toEqual({ pids: [100, 200, 300] });
  });

  it("全量 dispose 后集合清空；worker 重启（新 host）后集合重建 —— 新会话建立 pid 重新出现", async () => {
    const { host, stubOf } = makePidHost();
    await host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "a" } });
    stubOf("a").pids = [111];
    expect(await host.command({ kind: "listChildPids" })).toEqual({ pids: [111] });
    await host.command({ kind: "dispose" }); // 全量退出：各 adapter 受控终止
    expect(await host.command({ kind: "listChildPids" })).toEqual({ pids: [] });
    // worker 重启：新 CliHost（新 Router/新 Adapter 实例）初始空集
    const restarted = makePidHost();
    expect(await restarted.host.command({ kind: "listChildPids" })).toEqual({ pids: [] });
    await restarted.host.command({ kind: "createSession", init: { cwd: "C:\\demo", cli: "a" } });
    restarted.stubOf("a").pids = [222]; // 新会话建立后（进程拉起）pid 重新出现
    expect(await restarted.host.command({ kind: "listChildPids" })).toEqual({ pids: [222] });
  });
});

// HostCommand 类型形状冒烟（编译期断言用）
void ({} as HostCommand);

describe("CliHost 诊断 log 透传（#54 spec #52 B 节）", () => {
  it("构造可选 log 转发 run-once：stderr 留痕经同一 2 参 (kind, detail) 回调上报；未注入时静默", async () => {
    process.env.KANBAN_CLAUDE_BIN = process.execPath; // exe 解析链 env 分支 → node.exe（fake-cli 直连）
    const cwd = mkdtempSync(path.join(tmpdir(), "kb-host-log-"));
    const fakeCli = path.join(import.meta.dirname, "../../tests/fixtures/fake-cli.mjs");
    try {
      const logs: Array<[string, string]> = [];
      const host = new CliHost(() => new BaseStubAdapter() as CliAdapter, (kind, detail) => logs.push([kind, detail]));
      const r = await host.command({ kind: "run-once", runId: "h1", cli: "claude", args: [fakeCli, "ok", "H1"], cwd });
      expect(r.runOnce!.status).toBe("completed");
      expect(logs.some(([k, d]) => k === "stderr" && d.includes("fake-err:H1") && d.includes("h1"))).toBe(true);
      // 未注入 log 的既有构造（单参）不受影响：同命令可执行
      const bare = new CliHost(() => new BaseStubAdapter() as CliAdapter);
      expect((await bare.command({ kind: "run-once", runId: "h2", cli: "claude", args: [fakeCli, "ok"], cwd })).runOnce!.status).toBe("completed");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      delete process.env.KANBAN_CLAUDE_BIN;
    }
  });
});
