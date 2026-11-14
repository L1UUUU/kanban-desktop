// 用途：use-chat 编排函数密封测试（A 类，issue #71 S1/S5）—— 真 ChatStore + TerminalDraftController/TerminalManager + 内存 fake transport 直测：submitDraftChain 原子链、resumeChain 三态、openSessionDraftAction 互斥矩阵与切会话/全丢弃（无 React 树、无 fs/db/进程）；含 resolveSessionCwd 纯函数直测（issue #71 S5 自 harness 下沉，紧邻被测源码）
import { describe, expect, it } from "vitest";
import type { ChatEvent, IpcRequest, IpcResult, ProjectRow, SessionEventWire } from "@kanban/ipc-schema";
import type { ChatTransport } from "../../lib/kanban-api";
import { ChatStore } from "./chat-store";
import type { StructuredSessionView } from "./chat-store";
import { discardAllDraftsAction, openSessionDraftAction, renameSessionChain, resolveSessionCwd, resumeChain, setModelChain, submitDraftChain, subscribeSessionEvents, switchToAction, type SessionDraftEnv } from "./use-chat";
import { TerminalDraftController } from "../terminal/terminal-draft";
import { TerminalManager } from "../terminal/TerminalManager";

describe("「＋」新建 cwd 解析（resolveSessionCwd：项目查不到不回退任何路径，code-review 硬违规回归）", () => {
  const proj: ProjectRow = { id: "p1", name: "repo", canonicalPath: "C:\\repo", status: "ok", createdAt: "2026-01-01T00:00:00Z" };

  it("项目在列表：返回 canonicalPath", () => {
    expect(resolveSessionCwd([proj], "p1", { kind: "structured", cli: "claude" }, null)).toBe("C:\\repo");
    expect(resolveSessionCwd([proj], "p1", { kind: "pty" }, null)).toBe("C:\\repo");
  });

  it("项目查不到 + 真实 CLI/PTY：返回 null（不得回退演示目录或任何内置路径）", () => {
    expect(resolveSessionCwd([proj], "ghost", { kind: "structured", cli: "claude" }, "C:\\demo")).toBeNull();
    expect(resolveSessionCwd([proj], "ghost", { kind: "structured", cli: "codex" }, "C:\\demo")).toBeNull();
    expect(resolveSessionCwd([proj], "ghost", { kind: "pty" }, "C:\\demo")).toBeNull();
  });

  it("项目查不到 + Fake：回落注入的演示 cwd；未注入则 null", () => {
    expect(resolveSessionCwd([proj], "ghost", { kind: "structured", cli: "fake" }, "C:\\demo")).toBe("C:\\demo");
    expect(resolveSessionCwd([proj], "ghost", { kind: "structured", cli: "fake" }, null)).toBeNull();
  });
});

/** 内存 fake transport：按 channel 编程应答（缺省通用成功），记录全部出站请求 */
function makeTransport(replies: Partial<Record<string, IpcResult>> = {}): { transport: ChatTransport; requests: IpcRequest[] } {
  const requests: IpcRequest[] = [];
  return {
    requests,
    transport: {
      invoke: (req) => {
        requests.push(req);
        return Promise.resolve(
          replies[req.channel] ?? { ok: true },
        );
      },
      onEvent: () => () => undefined,
      onTerminalEvent: () => () => undefined,
      onTrackerEvent: () => () => undefined,
    },
  };
}

/** 取结构化会话视图（收窄断言：本套编排用例登记的均为结构化会话） */
function structured(store: ChatStore, id: string): StructuredSessionView {
  const s = store.getSession(id);
  if (!s || s.kind !== "structured") throw new Error(`会话 ${id} 非结构化视图`);
  return s;
}

/** 快照事件（readHistory 响应载荷）：一条助手增量 + 终结 */
const HISTORY_EVENTS: ChatEvent[] = [
  { type: "message_delta", sessionId: "s-resume", seq: 0, at: "2026-01-01T00:00:00Z", itemId: "i-1", partId: "p-1", delta: "历史消息" },
  { type: "message_completed", sessionId: "s-resume", seq: 1, at: "2026-01-01T00:00:01Z", itemId: "i-1", partId: "p-1" },
];

/** 装配：已开结构化草稿并填入首条输入与模型的 store（#77 起单一就绪态：未选模型不提交） */
function storeWithDraft(): ChatStore {
  const store = new ChatStore();
  store.openDraft({ cli: "claude", cwd: "C:\\repo", title: "草稿会话", model: "gpt-5.6-luna" });
  store.updateDraft({ input: "首条消息" });
  return store;
}

describe("submitDraftChain（session:create+firstMessage 原子链）", () => {
  it("成功：登记会话并激活 + 首条消息本地回显 + 草稿丢弃", async () => {
    const store = storeWithDraft();
    const { transport, requests } = makeTransport({
      "session:create": { ok: true, sessionId: "s-1", cli: "claude", title: "草稿会话" },
    });
    await expect(submitDraftChain(store, transport)).resolves.toBe(true);
    const snap = store.getSnapshot();
    expect(snap.draft).toBeNull(); // 草稿已丢
    expect(snap.activeId).toBe("s-1");
    expect(structured(store, "s-1").items).toEqual([{ kind: "user", itemId: expect.stringMatching(/^u-/), text: "首条消息" }]); // 本地回显
    expect(requests.filter((r) => r.channel === "session:create")).toHaveLength(1);
  });

  it("成功：create 响应元数据回填（dirIdentity/skillConflicts 缺省值）", async () => {
    const store = storeWithDraft();
    const { transport } = makeTransport({ "session:create": { ok: true, sessionId: "s-1" } });
    await submitDraftChain(store, transport);
    const s = structured(store, "s-1");
    expect(s.cli).toBe("claude"); // 响应缺 cli 回落草稿值
    expect(s.dirIdentity).toBe("none");
    expect(s.skillConflicts).toEqual([]);
  });

  it("失败：草稿与输入保留（可重试）+ submitError 直达失败卡", async () => {
    const store = storeWithDraft();
    const { transport } = makeTransport({
      "session:create": { ok: false, error: { code: "E_SPAWN_NOT_FOUND", message: "未找到 claude 可执行文件" } },
    });
    await expect(submitDraftChain(store, transport)).resolves.toBe(false);
    const snap = store.getSnapshot();
    expect(snap.draft?.input).toBe("首条消息"); // 输入保留
    expect(snap.draft?.submitError).toEqual({ code: "E_SPAWN_NOT_FOUND", message: "未找到 claude 可执行文件" });
    expect(snap.sessions).toHaveLength(0);
    // 可重试：换成功应答重跑同链
    const ok = makeTransport({ "session:create": { ok: true, sessionId: "s-2" } });
    await expect(submitDraftChain(store, ok.transport)).resolves.toBe(true);
    expect(store.getSnapshot().draft).toBeNull();
    expect(store.getSession("s-2")).toBeTruthy();
  });

  it("回滚出口：rolledBackSessionId 先至占位行被撤销（不留空会话）", async () => {
    const store = storeWithDraft();
    // 事件先至：applyEvent 已为回滚 id 建占位行（真实链路中 session_status 先于 create 响应到达）
    store.applyEvent({ type: "session_status", sessionId: "s-rollback", seq: 0, at: "2026-01-01T00:00:00Z", status: "running" });
    expect(store.getSnapshot().sessions).toHaveLength(1);
    const { transport } = makeTransport({
      "session:create": { ok: false, error: { code: "E_INTERNAL", message: "首条消息发送失败（注入）", rolledBackSessionId: "s-rollback" } },
    });
    await expect(submitDraftChain(store, transport)).resolves.toBe(false);
    expect(store.getSnapshot().sessions).toHaveLength(0); // 占位行按回滚 id 撤销
    expect(store.getSnapshot().draft?.submitError?.code).toBe("E_INTERNAL"); // 失败仍留草稿
  });

  it("守卫：无草稿/空输入/未选模型直接 false，不发任何请求", async () => {
    const empty = new ChatStore();
    const { transport, requests } = makeTransport();
    await expect(submitDraftChain(empty, transport)).resolves.toBe(false); // 无草稿
    empty.openDraft({ cli: "fake", cwd: "C:\\demo" });
    await expect(submitDraftChain(empty, transport)).resolves.toBe(false); // 空输入
    empty.updateDraft({ input: "有输入但模型未就绪" });
    await expect(submitDraftChain(empty, transport)).resolves.toBe(false); // 单一就绪态：模型未选（列表未就绪/未手输）不提交
    expect(requests).toHaveLength(0);
  });
});

describe("resumeChain（readHistory 快照重建 → resume 重连两步编排）", () => {
  /** 装配：登记一个断开会话的 store */
  function storeWithDisconnected(): ChatStore {
    const store = new ChatStore();
    store.registerSession({ sessionId: "s-resume", cli: "claude", title: "历史会话", permMode: "auto" });
    store.updateStatus("s-resume", "disconnected");
    return store;
  }

  it("readHistory 失败：进失败态（code/message 供重试与复制详情），不发出 resume", async () => {
    const store = storeWithDisconnected();
    const { transport, requests } = makeTransport({
      "session:readHistory": { ok: false, error: { code: "E_INTERNAL", message: "注入的恢复失败" } },
    });
    await resumeChain(store, transport, "s-resume");
    expect(structured(store, "s-resume").resumeState).toEqual({ phase: "failed", code: "E_INTERNAL", message: "注入的恢复失败" });
    expect(requests.filter((r) => r.channel === "session:resume")).toHaveLength(0);
  });

  it("readHistory 成功 + resume 失败：快照已重建消息流，进失败态", async () => {
    const store = storeWithDisconnected();
    const { transport } = makeTransport({
      "session:readHistory": { ok: true, events: HISTORY_EVENTS },
      "session:resume": { ok: false, error: { code: "E_SESSION_NOT_FOUND", message: "重连失败（注入）" } },
    });
    await resumeChain(store, transport, "s-resume");
    const s = structured(store, "s-resume");
    expect(s?.items).toHaveLength(1); // 快照重建（message_delta 归并一条）
    expect(s?.items[0]).toMatchObject({ kind: "assistant", text: "历史消息" });
    expect(s?.resumeState).toEqual({ phase: "failed", code: "E_SESSION_NOT_FOUND", message: "重连失败（注入）" });
  });

  it("全成功：快照重建消息流；成功收敛不由链内置（由 resume 后实时 session_status 驱动）", async () => {
    const store = storeWithDisconnected();
    const { transport } = makeTransport({
      "session:readHistory": { ok: true, events: HISTORY_EVENTS },
      "session:resume": { ok: true },
    });
    await resumeChain(store, transport, "s-resume");
    const s = structured(store, "s-resume");
    expect(s?.items).toHaveLength(1);
    expect(s?.resumeState).toEqual({ phase: "resuming" }); // 链不宣称成功：收敛由实时事件驱动复位
    // 实时事件到达即收敛（applyEvent 的 session_status 分支复位 resumeState）
    store.applyEvent({ type: "session_status", sessionId: "s-resume", seq: 2, at: "2026-01-01T00:00:02Z", status: "idle" });
    expect(structured(store, "s-resume").resumeState).toEqual({ phase: "idle" });
    expect(store.getSession("s-resume")?.status).toBe("idle");
  });

  it("第一步前先置「恢复中」（发出即不可中断，D1）", async () => {
    const store = storeWithDisconnected();
    const pending = new Promise<IpcResult>(() => undefined); // 悬挂 readHistory
    const requests: IpcRequest[] = [];
    const transport: ChatTransport = {
      invoke: (req) => {
        requests.push(req);
        return pending;
      },
      onEvent: () => () => undefined,
      onTerminalEvent: () => () => undefined,
      onTrackerEvent: () => () => undefined,
    };
    void resumeChain(store, transport, "s-resume");
    expect(structured(store, "s-resume").resumeState).toEqual({ phase: "resuming" });
    expect(requests[0]?.channel).toBe("session:readHistory");
  });

  it("参数下发：权限档位/模型/首条文本随 session:create 携带（所见即所发，默认选中项同样下发，issue #77）", async () => {
    const store = storeWithDraft();
    store.updateDraft({ permMode: "full", model: "gpt-6-luna", input: "带参数首条" });
    const requests: IpcRequest[] = [];
    const transport: ChatTransport = {
      invoke: (req) => {
        requests.push(req);
        return Promise.resolve({ ok: true, sessionId: "s-p" } satisfies IpcResult);
      },
      onEvent: () => () => undefined,
      onTerminalEvent: () => () => undefined,
      onTrackerEvent: () => () => undefined,
    };
    await expect(submitDraftChain(store, transport)).resolves.toBe(true);
    const create = requests.find((r) => r.channel === "session:create") as IpcRequest & { permMode?: string; model?: string; firstMessage?: string };
    expect(create).toMatchObject({ permMode: "full", model: "gpt-6-luna", firstMessage: "带参数首条" });
    // 新草稿未选模型（目录未就绪态）：守卫直接拦截，不发出请求（「默认占位不下发」语义已被就绪态阻塞取代）
    store.openDraft({ cli: "fake", cwd: "C:\\demo" });
    store.updateDraft({ input: "第二条" });
    await expect(submitDraftChain(store, transport)).resolves.toBe(false);
    expect(requests.filter((r) => r.channel === "session:create")).toHaveLength(1);
  });
});

describe("openSessionDraftAction 互斥矩阵（issue #71 S5：全局任一时刻至多一个草稿，两类互相替换）", () => {
  /** 装配 headless 草稿环境：真 store/drafts/manager，resolveCwd 缺省命中固定目录，onNotice 收集提示 */
  function makeEnv(opts?: { resolveCwd?: SessionDraftEnv["resolveCwd"] }) {
    const store = new ChatStore();
    const notices: string[] = [];
    const drafts = new TerminalDraftController({
      invoke: () => Promise.resolve({ ok: false, error: { code: "E_INTERNAL", message: "stub" } } satisfies IpcResult),
      onCreated: () => undefined,
      onFailed: () => undefined,
    });
    const manager = new TerminalManager({ write: () => undefined, resize: () => undefined });
    const env: SessionDraftEnv = {
      store,
      drafts,
      manager,
      resolveCwd: opts?.resolveCwd ?? (() => "C:\\repo"),
      onNotice: (m) => notices.push(m),
    };
    return { env, notices };
  }

  it("首开结构化草稿：无替换（replaced=null），replacedHint=false", () => {
    const { env } = makeEnv();
    expect(openSessionDraftAction(env, { kind: "structured", projectId: "p1", cli: "claude" })).toEqual({ ok: true, replaced: null });
    expect(env.store.getSnapshot().draft?.replacedHint).toBe(false);
  });

  it("structured→structured：同类替换，replaced=structured 且 replacedHint=true，旧输入不保留", () => {
    const { env } = makeEnv();
    openSessionDraftAction(env, { kind: "structured", projectId: "p1", cli: "claude" });
    env.store.updateDraft({ input: "旧输入" });
    expect(openSessionDraftAction(env, { kind: "structured", projectId: "p1", cli: "codex" })).toEqual({ ok: true, replaced: "structured" });
    const d = env.store.getSnapshot().draft;
    expect(d?.cli).toBe("codex");
    expect(d?.replacedHint).toBe(true);
    expect(d?.input).toBe(""); // 旧输入不保留
  });

  it("structured→pty：PTY 草稿替换结构化草稿（#65 反向缺失根因修复），跨类 replacedHint=true", () => {
    const { env } = makeEnv();
    openSessionDraftAction(env, { kind: "structured", projectId: "p1", cli: "claude" });
    expect(openSessionDraftAction(env, { kind: "pty", projectId: "p1" })).toEqual({ ok: true, replaced: "structured" });
    expect(env.store.getSnapshot().draft).toBeNull(); // 结构化草稿被静默丢弃
    const pty = env.drafts.getSnapshot();
    expect(pty?.cwd).toBe("C:\\repo");
    expect(pty?.projectId).toBe("p1");
    expect(pty?.replacedHint).toBe(true); // 跨类替换也提示（与「全局仅一个」用户感知一致）
  });

  it("pty→structured：结构化草稿替换 PTY 草稿（双向替换），PTY 快照清空", () => {
    const { env } = makeEnv();
    openSessionDraftAction(env, { kind: "pty", projectId: "p1" });
    expect(openSessionDraftAction(env, { kind: "structured", projectId: "p1", cli: "claude" })).toEqual({ ok: true, replaced: "pty" });
    expect(env.drafts.getSnapshot()).toBeNull(); // PTY 草稿被丢弃
    const d = env.store.getSnapshot().draft;
    expect(d?.cli).toBe("claude");
    expect(d?.replacedHint).toBe(true); // 跨类替换也提示
  });

  it("pty→pty：同类替换，新草稿 replacedHint=true", () => {
    const { env } = makeEnv();
    openSessionDraftAction(env, { kind: "pty", projectId: "p1" });
    expect(openSessionDraftAction(env, { kind: "pty", projectId: "p1" })).toEqual({ ok: true, replaced: "pty" });
    expect(env.drafts.getSnapshot()?.replacedHint).toBe(true);
  });

  it("resolveCwd 失败：拒绝打开并单点提示（项目不存在），两类草稿都不开", () => {
    const { env, notices } = makeEnv({ resolveCwd: () => null });
    expect(openSessionDraftAction(env, { kind: "structured", projectId: "ghost", cli: "claude" })).toEqual({ ok: false, reason: "project-missing" });
    expect(notices).toEqual(["新建失败：项目不存在或已失效，请刷新项目列表后重试"]);
    expect(env.store.getSnapshot().draft).toBeNull();
    expect(env.drafts.getSnapshot()).toBeNull();
    // 已有草稿时解析失败：原草稿保留（替换只发生在成功打开时）
    const ok = makeEnv({ resolveCwd: (projectId) => (projectId === "p1" ? "C:\\repo" : null) });
    openSessionDraftAction(ok.env, { kind: "structured", projectId: "p1", cli: "claude" });
    openSessionDraftAction(ok.env, { kind: "structured", projectId: "ghost", cli: "codex" });
    expect(ok.env.store.getSnapshot().draft?.cli).toBe("claude");
  });

  it("fromSessionId：cwd 取该会话（认证失效卡「打开 PTY 终端」），projectId 随会话", () => {
    const { env } = makeEnv();
    env.store.registerSession({ sessionId: "s-auth", cli: "claude", title: "认证会话", permMode: "auto", projectId: "p9", cwd: "C:\\auth-dir" });
    expect(openSessionDraftAction(env, { kind: "pty", projectId: "ignored", fromSessionId: "s-auth" })).toEqual({ ok: true, replaced: null });
    const pty = env.drafts.getSnapshot();
    expect(pty?.cwd).toBe("C:\\auth-dir"); // 会话 cwd，非 resolveCwd 结果
    expect(pty?.projectId).toBe("p9");
  });

  it("fromSessionId 会话无 cwd（不可建终端的守卫路径）：拒绝且提示", () => {
    const { env, notices } = makeEnv();
    env.store.registerSession({ sessionId: "s-nocwd", cli: "claude", title: "无目录会话", permMode: "auto", projectId: null, cwd: null });
    expect(openSessionDraftAction(env, { kind: "pty", projectId: null, fromSessionId: "s-nocwd" })).toEqual({ ok: false, reason: "project-missing" });
    expect(notices).toHaveLength(1);
    expect(env.drafts.getSnapshot()).toBeNull();
  });

  it("模型继承：结构化草稿继承当前草稿（同类替换）或激活会话的模型", () => {
    const { env } = makeEnv();
    env.store.registerSession({ sessionId: "s-a", cli: "claude", title: "A", permMode: "auto", model: "gpt-5.6-luna" });
    openSessionDraftAction(env, { kind: "structured", projectId: "p1", cli: "claude" });
    expect(env.store.getSnapshot().draft?.model).toBe("gpt-5.6-luna"); // 继承激活会话
    env.store.updateDraft({ model: "sonnet-4.6" });
    openSessionDraftAction(env, { kind: "structured", projectId: "p1", cli: "codex" });
    expect(env.store.getSnapshot().draft?.model).toBe("sonnet-4.6"); // 继承被替换草稿
  });

  it("switchToAction：切会话双丢弃（结构化 + PTY 含 xterm 释放）并激活目标", () => {
    const { env } = makeEnv();
    env.store.registerSession({ sessionId: "s-a", cli: "claude", title: "A", permMode: "auto" });
    openSessionDraftAction(env, { kind: "pty", projectId: null }); // PTY 草稿就位
    switchToAction(env, "s-a");
    openSessionDraftAction(env, { kind: "structured", projectId: "p1", cli: "claude" }); // 结构化草稿就位
    switchToAction(env, "s-a"); // 再切：结构化也被丢
    expect(env.store.getSnapshot().draft).toBeNull();
    expect(env.drafts.getSnapshot()).toBeNull();
    expect(env.store.getSnapshot().activeId).toBe("s-a");
  });

  it("discardAllDraftsAction：两类齐丢（切项目 effect 单调用）", () => {
    const { env } = makeEnv();
    openSessionDraftAction(env, { kind: "structured", projectId: "p1", cli: "claude" });
    discardAllDraftsAction(env);
    expect(env.store.getSnapshot().draft).toBeNull();
    expect(env.drafts.getSnapshot()).toBeNull();
    // PTY 侧同样
    openSessionDraftAction(env, { kind: "pty", projectId: "p1" });
    discardAllDraftsAction(env);
    expect(env.drafts.getSnapshot()).toBeNull();
  });
});

describe("setModelChain（issue #79：session:setModel 中途切换编排）", () => {
  /** 已建会话的 store（模型 fake-standard，与 FakeAdapter 目录一致） */
  function storeWithSession(): ChatStore {
    const store = new ChatStore();
    store.registerSession({ sessionId: "s-sw", cli: "fake", title: "切换会话", permMode: "auto", model: "fake-standard", cwd: "C:\\repo" });
    return store;
  }

  it("成功：乐观更新 → session:setModel 下发；响应实际模型回写 + 「下一轮起生效」标注；下一 turn_started 自动清除标注", async () => {
    const store = storeWithSession();
    const { transport, requests } = makeTransport({ "session:setModel": { ok: true, model: "claude-actual-id" } });
    const p = setModelChain(store, transport, "s-sw", "claude-alias");
    expect(structured(store, "s-sw").model).toBe("claude-alias"); // 乐观更新：chip 立即显示新模型
    await expect(p).resolves.toBe(true);
    expect(requests).toEqual([{ channel: "session:setModel", sessionId: "s-sw", model: "claude-alias" }]);
    const s = structured(store, "s-sw");
    expect(s.model).toBe("claude-actual-id"); // 响应实际模型名回写（claude 语义）
    expect(s.modelChangePending).toBe(true); // 「下一轮起生效」标注
    store.applyEvent({ type: "turn_started", sessionId: "s-sw", seq: 1, at: "2026-01-01T00:00:00Z", turnId: "t-1" });
    expect(structured(store, "s-sw").modelChangePending).toBe(false); // 下一轮开始即清除
  });

  it("失败：回滚为切换前值 + 错误直达会话错误卡（既有形态），不发标注", async () => {
    const store = storeWithSession();
    const { transport } = makeTransport({
      "session:setModel": { ok: false, error: { code: "E_INTERNAL", message: "本轮进行中，结束后再切换" } },
    });
    await expect(setModelChain(store, transport, "s-sw", "fake-lite")).resolves.toBe(false);
    const s = structured(store, "s-sw");
    expect(s.model).toBe("fake-standard"); // 回滚为切换前值
    expect(s.modelChangePending).toBe(false);
    expect(s.lastError).toEqual({ code: "E_INTERNAL", message: "本轮进行中，结束后再切换" });
  });

  it("守卫：同值切换 no-op 不发请求（幂等）", async () => {
    const store = storeWithSession();
    const { transport, requests } = makeTransport();
    await expect(setModelChain(store, transport, "s-sw", "fake-standard")).resolves.toBe(true);
    expect(requests).toHaveLength(0);
  });
});

describe("renameSessionChain（session:rename 手动重命名，#94 / ADR 0003）", () => {
  it("成功：invoke session:rename → 本地刷新标题，返回 null（无错误）", async () => {
    const store = new ChatStore();
    store.registerSession({ sessionId: "s-1", cli: "claude", title: "默认演示", permMode: "auto" });
    const { transport, requests } = makeTransport({ "session:rename": { ok: true, title: "我起的名字" } });
    await expect(renameSessionChain(store, transport, "s-1", "我起的名字")).resolves.toBeNull();
    expect(store.getSession("s-1")?.title).toBe("我起的名字");
    expect(requests).toEqual([{ channel: "session:rename", sessionId: "s-1", title: "我起的名字" }]);
  });

  it("IPC 失败：返回错误文案（行内提示），标题不动", async () => {
    const store = new ChatStore();
    store.registerSession({ sessionId: "s-1", cli: "claude", title: "默认演示", permMode: "auto" });
    const { transport } = makeTransport({ "session:rename": { ok: false, error: { code: "E_SESSION_NOT_FOUND", message: "会话不存在：s-1" } } });
    await expect(renameSessionChain(store, transport, "s-1", "我起的名字")).resolves.toBe("会话不存在：s-1");
    expect(store.getSession("s-1")?.title).toBe("默认演示");
  });

  it("transport 异常：返回异常文案，标题不动（不静默）", async () => {
    const store = new ChatStore();
    store.registerSession({ sessionId: "s-1", cli: "claude", title: "默认演示", permMode: "auto" });
    const transport: ChatTransport = {
      invoke: () => Promise.reject(new Error("桥已断")),
      onEvent: () => () => undefined,
      onTerminalEvent: () => () => undefined,
      onTrackerEvent: () => () => undefined,
    };
    await expect(renameSessionChain(store, transport, "s-1", "我起的名字")).resolves.toBe("桥已断");
    expect(store.getSession("s-1")?.title).toBe("默认演示");
  });
});

describe("subscribeSessionEvents（session:event 轻通道订阅，#95 / ADR 0003 摘要标题推送）", () => {
  /** 捕获订阅 handler 的 transport 替身 */
  function makeSessionEventTransport(): { transport: ChatTransport; emit: (event: unknown) => void } {
    let handler: ((event: SessionEventWire) => void) | null = null;
    return {
      transport: {
        invoke: () => Promise.resolve({ ok: true } satisfies IpcResult),
        onEvent: () => () => undefined,
        onTerminalEvent: () => () => undefined,
        onTrackerEvent: () => () => undefined,
        onSessionEvent: (h) => {
          handler = h;
          return () => {
            handler = null;
          };
        },
      },
      emit: (event) => handler?.(event as SessionEventWire),
    };
  }

  it("title 事件 → store.updateSession 本地刷新侧栏标题", () => {
    const store = new ChatStore();
    store.registerSession({ sessionId: "s-sum", cli: "claude", title: "派生标题", permMode: "auto" });
    const { transport, emit } = makeSessionEventTransport();
    const off = subscribeSessionEvents(store, transport);
    emit({ type: "title", sessionId: "s-sum", title: "模型摘要标题" });
    expect(store.getSession("s-sum")?.title).toBe("模型摘要标题");
    off();
  });

  it("未知会话 id 安全 no-op；transport 未实现 onSessionEvent（旧 fake）安全 no-op；退订后不再刷新", () => {
    const store = new ChatStore();
    store.registerSession({ sessionId: "s-known", cli: "claude", title: "派生标题", permMode: "auto" });
    const { transport, emit } = makeSessionEventTransport();
    const off = subscribeSessionEvents(store, transport);
    emit({ type: "title", sessionId: "s-ghost", title: "幽灵" }); // 未知会话：updateSession no-op
    expect(store.getSession("s-known")?.title).toBe("派生标题");
    off();
    emit({ type: "title", sessionId: "s-known", title: "退订后的迟到推送" });
    expect(store.getSession("s-known")?.title).toBe("派生标题");
    // 旧 fake（无 onSessionEvent 可选方法）：不抛错
    const legacy: ChatTransport = {
      invoke: () => Promise.resolve({ ok: true } satisfies IpcResult),
      onEvent: () => () => undefined,
      onTerminalEvent: () => () => undefined,
      onTrackerEvent: () => () => undefined,
    };
    expect(() => subscribeSessionEvents(store, legacy)).not.toThrow();
  });
});
