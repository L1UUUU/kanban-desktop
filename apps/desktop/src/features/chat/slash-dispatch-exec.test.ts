// 用途：斜杠派发执行器密封测试（issue #92 / spec #82 E 块；ADR 0004 零内置）—— 发送期把派发动作落到既有链路：透传/展开文本走 session:send（用户气泡=实际发送文本，所见即所发）、codex 展开经 composer:expandCommand、fail-closed 与展开/发送失败直达既有错误卡（会话 setError / 草稿 setDraftSubmitError），不静默
import { describe, expect, it } from "vitest";
import type { CliKind, CommandEntry, IpcRequest, IpcResult } from "@kanban/ipc-schema";
import type { ChatTransport } from "../../lib/kanban-api";
import { ChatStore } from "./chat-store";
import { ComposerCommandSource } from "./composer-command-source";
import { dispatchDraftSubmit, dispatchSessionSend, type SlashDispatchEnv } from "./slash-dispatch-exec";

/** 记录调用并按通道回放结果的 fake transport */
function makeTransport(results: Partial<Record<string, IpcResult>> = {}): ChatTransport & { calls: IpcRequest[] } {
  const calls: IpcRequest[] = [];
  return {
    calls,
    invoke: async (req) => {
      calls.push(req);
      return results[req.channel] ?? { ok: true };
    },
    onEvent: () => () => undefined,
    onTerminalEvent: () => () => undefined,
    onTrackerEvent: () => () => undefined,
  };
}

/** 指定命令目录的命令源（fetch 立即成功；等待非 loading 态） */
async function makeReadySource(cli: CliKind, cwd: string, commands: CommandEntry[]): Promise<ComposerCommandSource> {
  const source = new ComposerCommandSource(async (req) => ({ ok: true, commands: req.cli === cli ? commands : [] }));
  source.ensure(cli, cwd);
  for (let i = 0; i < 50 && source.getState(cli, cwd).status === "loading"; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
  return source;
}

const CODEX_ENTRY: CommandEntry = {
  name: "commit",
  description: "提交",
  argsHint: "[说明]",
  source: "project",
  cli: "codex",
  sourcePath: "C:\\prompts\\commit.md",
  userOnly: false,
};

interface EnvHarness {
  env: SlashDispatchEnv;
  store: ChatStore;
  transport: ReturnType<typeof makeTransport>;
}

/** 装配执行环境：注册 codex 会话（cwd 固定）；ADR 0004 零内置后 env 仅剩 store/transport/commands */
async function makeHarness(commands: CommandEntry[] | null): Promise<EnvHarness> {
  const store = new ChatStore();
  store.registerSession({ sessionId: "s1", cli: "codex", title: "会话", permMode: "auto", cwd: "C:\\proj", projectId: "p1" });
  store.setActive("s1");
  const transport = makeTransport({
    "composer:expandCommand": { ok: true, text: "展开正文：修登录 bug" },
  });
  const source = commands ? await makeReadySource("codex", "C:\\proj", commands) : new ComposerCommandSource(async () => ({ ok: true, commands: [] }));
  const env: SlashDispatchEnv = {
    store,
    transport,
    commands: source,
  };
  return { env, store, transport };
}

describe("dispatchSessionSend（会话态发送编排）", () => {
  it("透传（claude 匹配/未匹配一致）：用户气泡与 session:send 载荷均为原文；返回消费", async () => {
    const store = new ChatStore();
    store.registerSession({ sessionId: "s1", cli: "claude", title: "会话", permMode: "auto", cwd: "C:\\proj", projectId: "p1" });
    store.setActive("s1");
    const transport = makeTransport();
    const env: SlashDispatchEnv = { store, transport, commands: new ComposerCommandSource(async () => ({ ok: true, commands: [] })) };
    expect(await dispatchSessionSend(env, "s1", "/plan 拆分")).toBe(true);
    const s = store.getSession("s1")!;
    expect(s.items.at(-1)).toMatchObject({ kind: "user", text: "/plan 拆分" });
    expect(transport.calls).toEqual([{ channel: "session:send", sessionId: "s1", text: "/plan 拆分" }]);
  });

  it("codex 匹配展开：先 composer:expandCommand 再 session:send 展开文本；气泡=展开文本（所见即所发）", async () => {
    const t = await makeHarness([CODEX_ENTRY]);
    expect(await dispatchSessionSend(t.env, "s1", "/commit 修登录 bug")).toBe(true);
    expect(t.transport.calls[0]).toMatchObject({ channel: "composer:expandCommand", cwd: "C:\\proj", sourcePath: "C:\\prompts\\commit.md", args: "修登录 bug" });
    expect(t.transport.calls[1]).toEqual({ channel: "session:send", sessionId: "s1", text: "展开正文：修登录 bug" });
    expect(t.store.getSession("s1")!.items.at(-1)).toMatchObject({ kind: "user", text: "展开正文：修登录 bug" });
  });

  it("codex 展开失败（文件不可读）→ 会话错误卡 setError，不发送；返回 false（输入保留）", async () => {
    const t = await makeHarness([CODEX_ENTRY]);
    t.transport.calls.length = 0;
    const failing = makeTransport({ "composer:expandCommand": { ok: false, error: { code: "E_INTERNAL", message: "斜杠命令文件不可读" } } });
    const env = { ...t.env, transport: failing };
    expect(await dispatchSessionSend(env, "s1", "/commit x")).toBe(false);
    expect(failing.calls.map((c) => c.channel)).toEqual(["composer:expandCommand"]); // 未再发 session:send
    expect(t.store.getSession("s1")!.lastError).toMatchObject({ code: "E_INTERNAL", message: "斜杠命令文件不可读" });
    expect(t.store.getSession("s1")!.items.some((i) => i.kind === "user")).toBe(false); // 未乐观追加
  });

  it("codex 目录不可用 → fail-closed 错误卡（E_INTERNAL），不发送", async () => {
    const t = await makeHarness(null); // 命令源从未 ready（idle）
    expect(await dispatchSessionSend(t.env, "s1", "/commit x")).toBe(false);
    expect(t.transport.calls).toEqual([]);
    expect(t.store.getSession("s1")!.lastError?.code).toBe("E_INTERNAL");
  });
});

describe("dispatchDraftSubmit（草稿态提交编排）", () => {
  async function makeDraftHarness(commands: CommandEntry[] | null): Promise<EnvHarness & { submitted: Array<string | undefined> }> {
    const t = await makeHarness(commands);
    t.store.discardDraft();
    t.store.openDraft({ cli: "codex", cwd: "C:\\proj", projectId: "p1", title: "草稿" });
    t.store.updateDraft({ input: "/commit 修登录 bug" });
    const submitted: Array<string | undefined> = [];
    return { ...t, submitted };
  }

  it("codex 匹配展开：以展开文本提交原子链（firstMessage 覆盖草稿原文）", async () => {
    const t = await makeDraftHarness([CODEX_ENTRY]);
    const ok = await dispatchDraftSubmit(t.env, async (firstMessage) => {
      t.submitted.push(firstMessage);
      return true;
    });
    expect(ok).toBe(true);
    expect(t.submitted).toEqual(["展开正文：修登录 bug"]);
  });

  it("透传/未匹配：无覆盖提交（草稿原文走原子链）；展开失败 → setDraftSubmitError（失败卡数据），submit 不触发", async () => {
    const t = await makeDraftHarness([CODEX_ENTRY]);
    t.store.updateDraft({ input: "普通首条" });
    expect(await dispatchDraftSubmit(t.env, async (m) => (t.submitted.push(m), true))).toBe(true);
    expect(t.submitted).toEqual([undefined]);

    t.store.updateDraft({ input: "/commit 修登录 bug" });
    const failing = makeTransport({ "composer:expandCommand": { ok: false, error: { code: "E_INTERNAL", message: "斜杠命令文件不可读" } } });
    const before = t.submitted.length;
    expect(await dispatchDraftSubmit({ ...t.env, transport: failing }, async (m) => (t.submitted.push(m), true))).toBe(false);
    expect(t.submitted.length).toBe(before); // 原子链未触发
    expect(t.store.getSnapshot().draft?.submitError).toMatchObject({ code: "E_INTERNAL", message: "斜杠命令文件不可读" });
    expect(t.store.getSnapshot().draft?.input).toBe("/commit 修登录 bug"); // 输入保留
  });
});

describe("session:send 响应 title 消费（#94：派生标题即时刷新侧栏）", () => {
  it("响应带 title：本地回写会话标题（无需事件推送）", async () => {
    const store = new ChatStore();
    store.registerSession({ sessionId: "s1", cli: "claude", title: "新会话 · Claude", permMode: "auto", cwd: "C:\\proj", projectId: "p1" });
    store.setActive("s1");
    const transport = makeTransport({ "session:send": { ok: true, title: "第一条正经消息" } });
    const source = new ComposerCommandSource(async () => ({ ok: true, commands: [] }));
    const env: SlashDispatchEnv = { store, transport, commands: source };
    await dispatchSessionSend(env, "s1", "第一条正经消息");
    expect(store.getSession("s1")?.title).toBe("第一条正经消息");
  });

  it("响应不带 title（已派生/manual 门控未生效）：标题保持不动", async () => {
    const store = new ChatStore();
    store.registerSession({ sessionId: "s1", cli: "claude", title: "我起的名字", permMode: "auto", cwd: "C:\\proj", projectId: "p1" });
    store.setActive("s1");
    const transport = makeTransport({ "session:send": { ok: true } });
    const source = new ComposerCommandSource(async () => ({ ok: true, commands: [] }));
    const env: SlashDispatchEnv = { store, transport, commands: source };
    await dispatchSessionSend(env, "s1", "第二条消息");
    expect(store.getSession("s1")?.title).toBe("我起的名字");
  });
});
