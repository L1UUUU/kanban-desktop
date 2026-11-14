// 用途：消息旅程编排密封测试（arch C7；原 slash-dispatch-exec 直测 + use-chat 的 submitDraftChain 直测合并至此）——
// 真 ChatStore + 内存 fake transport 直测：会话态发送（透传/展开/fail-closed、session:send 派生标题回写）、
// 草稿态提交（派发判定 + session:create+firstMessage 原子链：展开文本覆盖草稿原文、守卫、回滚撤销、参数下发），
// 错误回流断言经 store 错误槽（会话 lastError / 草稿 submitError）（无 React 树、无 fs/db/进程）
import { describe, expect, it } from "vitest";
import type { CliKind, CommandEntry, IpcRequest, IpcResult } from "@kanban/ipc-schema";
import type { ChatTransport } from "../../lib/kanban-api";
import { ChatStore, type ChatStoreDeps } from "./chat-store";
import { ComposerCommandSource } from "./composer-command-source";
import { sendSessionText, submitDraftFirstMessage, type SendEnv } from "./send-chain";

/** 最小构造依赖（本套不驱动 PTY 草稿 IPC 链路） */
const MIN_DEPS: ChatStoreDeps = {
  invoke: () => Promise.resolve({ ok: false, error: { code: "E_INTERNAL", message: "stub" } } satisfies IpcResult),
  disposeTerminal: () => undefined,
};

/** 取结构化草稿数据（收窄断言辅助：快照草稿为判别联合，arch C8） */
function structuredDraft(store: ChatStore) {
  const d = store.getSnapshot().draft;
  if (!d || d.kind !== "structured") throw new Error("结构化草稿不在位");
  return d.data;
}

/** 取结构化会话视图（收窄断言：本套用例登记的均为结构化会话） */
function structured(store: ChatStore, id: string) {
  const s = store.getSession(id);
  if (!s || s.kind !== "structured") throw new Error(`会话 ${id} 非结构化视图`);
  return s;
}

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

/** 空目录命令源（透传类 CLI 判定不查目录；codex 用例按需替换） */
function emptySource(): ComposerCommandSource {
  return new ComposerCommandSource(async () => ({ ok: true, commands: [] }));
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
  env: SendEnv;
  store: ChatStore;
  transport: ReturnType<typeof makeTransport>;
}

/** 装配执行环境：注册 codex 会话（cwd 固定）；ADR 0004 零内置后 env 仅剩 store/transport/commands */
async function makeHarness(commands: CommandEntry[] | null): Promise<EnvHarness> {
  const store = new ChatStore(MIN_DEPS);
  store.registerSession({ sessionId: "s1", cli: "codex", title: "会话", permMode: "auto", cwd: "C:\\proj", projectId: "p1" });
  store.setActive("s1");
  const transport = makeTransport({
    "composer:expandCommand": { ok: true, text: "展开正文：修登录 bug" },
    "session:create": { ok: true, sessionId: "s-new" },
  });
  const source = commands ? await makeReadySource("codex", "C:\\proj", commands) : emptySource();
  const env: SendEnv = {
    store,
    transport,
    commands: source,
  };
  return { env, store, transport };
}

describe("sendSessionText（会话态发送编排）", () => {
  it("透传（claude 匹配/未匹配一致）：用户气泡与 session:send 载荷均为原文；返回已消费", async () => {
    const store = new ChatStore(MIN_DEPS);
    store.registerSession({ sessionId: "s1", cli: "claude", title: "会话", permMode: "auto", cwd: "C:\\proj", projectId: "p1" });
    store.setActive("s1");
    const transport = makeTransport();
    const env: SendEnv = { store, transport, commands: emptySource() };
    expect(await sendSessionText(env, "s1", "/plan 拆分")).toBe("consumed");
    const s = structured(store, "s1");
    expect(s.items.at(-1)).toMatchObject({ kind: "user", text: "/plan 拆分" });
    expect(transport.calls).toEqual([{ channel: "session:send", sessionId: "s1", text: "/plan 拆分" }]);
  });

  it("codex 匹配展开：先 composer:expandCommand 再 session:send 展开文本；气泡=展开文本（所见即所发）", async () => {
    const t = await makeHarness([CODEX_ENTRY]);
    expect(await sendSessionText(t.env, "s1", "/commit 修登录 bug")).toBe("consumed");
    expect(t.transport.calls[0]).toMatchObject({ channel: "composer:expandCommand", cwd: "C:\\proj", sourcePath: "C:\\prompts\\commit.md", args: "修登录 bug" });
    expect(t.transport.calls[1]).toEqual({ channel: "session:send", sessionId: "s1", text: "展开正文：修登录 bug" });
    expect(structured(t.store, "s1").items.at(-1)).toMatchObject({ kind: "user", text: "展开正文：修登录 bug" });
  });

  it("codex 展开失败（文件不可读）→ 会话错误卡（lastError），不发送；返回 handled（输入保留）", async () => {
    const t = await makeHarness([CODEX_ENTRY]);
    t.transport.calls.length = 0;
    const failing = makeTransport({ "composer:expandCommand": { ok: false, error: { code: "E_INTERNAL", message: "斜杠命令文件不可读" } } });
    const env = { ...t.env, transport: failing };
    expect(await sendSessionText(env, "s1", "/commit x")).toBe("handled");
    expect(failing.calls.map((c) => c.channel)).toEqual(["composer:expandCommand"]); // 未再发 session:send
    expect(structured(t.store, "s1").lastError).toMatchObject({ code: "E_INTERNAL", message: "斜杠命令文件不可读" });
    expect(structured(t.store, "s1").items.some((i) => i.kind === "user")).toBe(false); // 未乐观追加
  });

  it("codex 目录不可用 → fail-closed 错误卡（E_INTERNAL），不发送", async () => {
    const t = await makeHarness(null); // 命令源从未 ready（idle）
    expect(await sendSessionText(t.env, "s1", "/commit x")).toBe("handled");
    expect(t.transport.calls).toEqual([]);
    expect(structured(t.store, "s1").lastError?.code).toBe("E_INTERNAL");
  });
});

describe("session:send 响应 title 消费（#94：派生标题即时刷新侧栏）", () => {
  it("响应带 title：本地回写会话标题（无需事件推送）", async () => {
    const store = new ChatStore(MIN_DEPS);
    store.registerSession({ sessionId: "s1", cli: "claude", title: "新会话 · Claude", permMode: "auto", cwd: "C:\\proj", projectId: "p1" });
    store.setActive("s1");
    const transport = makeTransport({ "session:send": { ok: true, title: "第一条正经消息" } });
    const env: SendEnv = { store, transport, commands: emptySource() };
    await sendSessionText(env, "s1", "第一条正经消息");
    expect(store.getSession("s1")?.title).toBe("第一条正经消息");
  });

  it("响应不带 title（已派生/manual 门控未生效）：标题保持不动", async () => {
    const store = new ChatStore(MIN_DEPS);
    store.registerSession({ sessionId: "s1", cli: "claude", title: "我起的名字", permMode: "auto", cwd: "C:\\proj", projectId: "p1" });
    store.setActive("s1");
    const transport = makeTransport({ "session:send": { ok: true } });
    const env: SendEnv = { store, transport, commands: emptySource() };
    await sendSessionText(env, "s1", "第二条消息");
    expect(store.getSession("s1")?.title).toBe("我起的名字");
  });
});

describe("submitDraftFirstMessage（草稿态提交编排：派发判定 + session:create+firstMessage 原子链）", () => {
  /** 装配：已开 codex 草稿并填入首条输入与模型的执行环境（create 响应缺省成功并带新会话 id） */
  async function makeDraftHarness(commands: CommandEntry[] | null): Promise<EnvHarness> {
    const t = await makeHarness(commands);
    t.store.discardDraft();
    t.store.openDraft({ cli: "codex", cwd: "C:\\proj", projectId: "p1", title: "草稿", model: "gpt-6-luna" });
    t.store.updateDraft({ input: "/commit 修登录 bug" });
    t.transport.calls.length = 0;
    return t;
  }

  /** 装配：claude 草稿（透传类，无展开分支）+ 可编程 create 应答 */
  function makeClaudeDraftHarness(create: IpcResult): EnvHarness {
    const store = new ChatStore(MIN_DEPS);
    store.openDraft({ cli: "claude", cwd: "C:\\repo", title: "草稿会话", model: "gpt-5.6-luna" });
    store.updateDraft({ input: "首条消息" });
    const transport = makeTransport({ "session:create": create });
    const env: SendEnv = { store, transport, commands: emptySource() };
    return { env, store, transport };
  }

  it("codex 匹配展开：以展开文本提交原子链（firstMessage 覆盖草稿原文；气泡=展开文本）", async () => {
    const t = await makeDraftHarness([CODEX_ENTRY]);
    expect(await submitDraftFirstMessage(t.env)).toBe("consumed");
    const create = t.transport.calls.find((c) => c.channel === "session:create") as IpcRequest & { firstMessage?: string };
    expect(create).toMatchObject({ firstMessage: "展开正文：修登录 bug" });
    expect(t.store.getSnapshot().draft).toBeNull(); // 草稿已丢
    expect(t.transport.calls.at(-1)).toMatchObject({ channel: "session:create" });
  });

  it("透传/未匹配：无覆盖提交（草稿原文走原子链）；展开失败 → submitError（失败卡数据），create 不发出", async () => {
    const t = await makeDraftHarness([CODEX_ENTRY]);
    t.store.updateDraft({ input: "普通首条" });
    expect(await submitDraftFirstMessage(t.env)).toBe("consumed");
    const create = t.transport.calls.find((c) => c.channel === "session:create") as IpcRequest & { firstMessage?: string };
    expect(create).toMatchObject({ firstMessage: "普通首条" });

    // 原子链成功即丢弃草稿：重开草稿验证展开失败分支（失败后草稿与输入保留）
    t.store.openDraft({ cli: "codex", cwd: "C:\\proj", projectId: "p1", title: "草稿", model: "gpt-6-luna" });
    t.store.updateDraft({ input: "/commit 修登录 bug" });
    const failing = makeTransport({ "composer:expandCommand": { ok: false, error: { code: "E_INTERNAL", message: "斜杠命令文件不可读" } } });
    expect(await submitDraftFirstMessage({ ...t.env, transport: failing })).toBe("handled");
    expect(failing.calls.map((c) => c.channel)).toEqual(["composer:expandCommand"]); // 原子链未触发
    expect(structuredDraft(t.store).submitError).toMatchObject({ code: "E_INTERNAL", message: "斜杠命令文件不可读" });
    expect(structuredDraft(t.store).input).toBe("/commit 修登录 bug"); // 输入保留
  });

  it("codex 目录不可用 → fail-closed submitError（E_INTERNAL），create 不发出", async () => {
    const t = await makeDraftHarness(null);
    expect(await submitDraftFirstMessage(t.env)).toBe("handled");
    expect(t.transport.calls).toEqual([]);
    expect(structuredDraft(t.store).submitError?.code).toBe("E_INTERNAL");
  });

  it("成功：登记会话并激活 + 首条消息本地回显 + 草稿丢弃", async () => {
    const t = makeClaudeDraftHarness({ ok: true, sessionId: "s-1", cli: "claude", title: "草稿会话" });
    expect(await submitDraftFirstMessage(t.env)).toBe("consumed");
    const snap = t.store.getSnapshot();
    expect(snap.draft).toBeNull(); // 草稿已丢
    expect(snap.activeId).toBe("s-1");
    expect(structured(t.store, "s-1").items).toEqual([{ kind: "user", itemId: expect.stringMatching(/^u-/), text: "首条消息" }]); // 本地回显
    expect(t.transport.calls.filter((r) => r.channel === "session:create")).toHaveLength(1);
  });

  it("成功：create 响应元数据回填（dirIdentity/skillConflicts 缺省值）", async () => {
    const t = makeClaudeDraftHarness({ ok: true, sessionId: "s-1" });
    await submitDraftFirstMessage(t.env);
    const s = structured(t.store, "s-1");
    expect(s.cli).toBe("claude"); // 响应缺 cli 回落草稿值
    expect(s.dirIdentity).toBe("none");
    expect(s.skillConflicts).toEqual([]);
  });

  it("失败：草稿与输入保留（可重试）+ submitError 直达失败卡", async () => {
    const t = makeClaudeDraftHarness({ ok: false, error: { code: "E_SPAWN_NOT_FOUND", message: "未找到 claude 可执行文件" } });
    expect(await submitDraftFirstMessage(t.env)).toBe("handled");
    const snap = t.store.getSnapshot();
    expect(structuredDraft(t.store).input).toBe("首条消息"); // 输入保留
    expect(structuredDraft(t.store).submitError).toEqual({ code: "E_SPAWN_NOT_FOUND", message: "未找到 claude 可执行文件" });
    expect(snap.sessions).toHaveLength(0);
    // 可重试：换成功应答重跑同链
    const ok = makeTransport({ "session:create": { ok: true, sessionId: "s-2" } });
    expect(await submitDraftFirstMessage({ ...t.env, transport: ok })).toBe("consumed");
    expect(t.store.getSnapshot().draft).toBeNull();
    expect(t.store.getSession("s-2")).toBeTruthy();
  });

  it("回滚出口：rolledBackSessionId 先至占位行被撤销（不留空会话）", async () => {
    const t = makeClaudeDraftHarness({ ok: false, error: { code: "E_INTERNAL", message: "首条消息发送失败（注入）", rolledBackSessionId: "s-rollback" } });
    // 事件先至：applyEvent 已为回滚 id 建占位行（真实链路中 session_status 先于 create 响应到达）
    t.store.applyEvent({ type: "session_status", sessionId: "s-rollback", seq: 0, at: "2026-01-01T00:00:00Z", status: "running" });
    expect(t.store.getSnapshot().sessions).toHaveLength(1);
    expect(await submitDraftFirstMessage(t.env)).toBe("handled");
    expect(t.store.getSnapshot().sessions).toHaveLength(0); // 占位行按回滚 id 撤销
    expect(structuredDraft(t.store).submitError?.code).toBe("E_INTERNAL"); // 失败仍留草稿
  });

  it("守卫：无草稿/空输入/未选模型直接 handled，不发任何请求", async () => {
    const empty = new ChatStore(MIN_DEPS);
    const transport = makeTransport();
    const env: SendEnv = { store: empty, transport, commands: emptySource() };
    expect(await submitDraftFirstMessage(env)).toBe("handled"); // 无草稿
    empty.openDraft({ cli: "fake", cwd: "C:\\demo", model: "fake-standard" });
    expect(await submitDraftFirstMessage(env)).toBe("handled"); // 空输入
    empty.updateDraft({ input: "有输入但模型未就绪" });
    empty.updateDraft({ model: undefined });
    expect(await submitDraftFirstMessage(env)).toBe("handled"); // 单一就绪态：模型未选（列表未就绪/未手输）不提交
    expect(transport.calls).toHaveLength(0);
  });

  it("参数下发：权限档位/模型/首条文本随 session:create 携带（所见即所发，默认选中项同样下发，issue #77）", async () => {
    const t = makeClaudeDraftHarness({ ok: true, sessionId: "s-p" });
    t.store.updateDraft({ permMode: "full", model: "gpt-6-luna", input: "带参数首条" });
    expect(await submitDraftFirstMessage(t.env)).toBe("consumed");
    const create = t.transport.calls.find((r) => r.channel === "session:create") as IpcRequest & { permMode?: string; model?: string; firstMessage?: string };
    expect(create).toMatchObject({ permMode: "full", model: "gpt-6-luna", firstMessage: "带参数首条" });
  });
});
