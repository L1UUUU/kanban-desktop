// 用途：use-chat 编排函数密封测试（A 类，issue #71 S1）—— 真 ChatStore + 内存 fake transport 直测 submitDraftChain 原子链三条出口与 resumeChain 三态（无 React 树、无 fs/db/进程）
import { describe, expect, it } from "vitest";
import type { ChatEvent, IpcRequest, IpcResult } from "@kanban/ipc-schema";
import type { ChatTransport } from "../../lib/kanban-api";
import { ChatStore } from "./chat-store";
import { resumeChain, submitDraftChain } from "./use-chat";

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

/** 快照事件（readHistory 响应载荷）：一条助手增量 + 终结 */
const HISTORY_EVENTS: ChatEvent[] = [
  { type: "message_delta", sessionId: "s-resume", seq: 0, at: "2026-01-01T00:00:00Z", itemId: "i-1", partId: "p-1", delta: "历史消息" },
  { type: "message_completed", sessionId: "s-resume", seq: 1, at: "2026-01-01T00:00:01Z", itemId: "i-1", partId: "p-1" },
];

/** 装配：已开结构化草稿并填入首条输入的 store */
function storeWithDraft(): ChatStore {
  const store = new ChatStore();
  store.openDraft({ cli: "claude", cwd: "C:\\repo", title: "草稿会话" });
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
    const created = store.getSession("s-1");
    expect(created?.items).toEqual([{ kind: "user", itemId: expect.stringMatching(/^u-/), text: "首条消息" }]); // 本地回显
    expect(requests.filter((r) => r.channel === "session:create")).toHaveLength(1);
  });

  it("成功：create 响应元数据回填（dirIdentity/skillConflicts 缺省值）", async () => {
    const store = storeWithDraft();
    const { transport } = makeTransport({ "session:create": { ok: true, sessionId: "s-1" } });
    await submitDraftChain(store, transport);
    const s = store.getSession("s-1");
    expect(s?.cli).toBe("claude"); // 响应缺 cli 回落草稿值
    expect(s?.dirIdentity).toBe("none");
    expect(s?.skillConflicts).toEqual([]);
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

  it("守卫：无草稿或空输入直接 false，不发任何请求", async () => {
    const empty = new ChatStore();
    const { transport, requests } = makeTransport();
    await expect(submitDraftChain(empty, transport)).resolves.toBe(false); // 无草稿
    empty.openDraft({ cli: "fake", cwd: "C:\\demo" });
    await expect(submitDraftChain(empty, transport)).resolves.toBe(false); // 空输入
    expect(requests).toHaveLength(0);
  });
});

describe("resumeChain（readHistory 快照重建 → resume 重连两步编排）", () => {
  /** 装配：登记一个断开会话的 store */
  function storeWithDisconnected(): ChatStore {
    const store = new ChatStore();
    store.registerSession({ sessionId: "s-resume", cli: "claude", title: "历史会话", permMode: "auto", model: "默认模型" });
    store.updateStatus("s-resume", "disconnected");
    return store;
  }

  it("readHistory 失败：进失败态（code/message 供重试与复制详情），不发出 resume", async () => {
    const store = storeWithDisconnected();
    const { transport, requests } = makeTransport({
      "session:readHistory": { ok: false, error: { code: "E_INTERNAL", message: "注入的恢复失败" } },
    });
    await resumeChain(store, transport, "s-resume");
    expect(store.getSession("s-resume")?.resumeState).toEqual({ phase: "failed", code: "E_INTERNAL", message: "注入的恢复失败" });
    expect(requests.filter((r) => r.channel === "session:resume")).toHaveLength(0);
  });

  it("readHistory 成功 + resume 失败：快照已重建消息流，进失败态", async () => {
    const store = storeWithDisconnected();
    const { transport } = makeTransport({
      "session:readHistory": { ok: true, events: HISTORY_EVENTS },
      "session:resume": { ok: false, error: { code: "E_SESSION_NOT_FOUND", message: "重连失败（注入）" } },
    });
    await resumeChain(store, transport, "s-resume");
    const s = store.getSession("s-resume");
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
    const s = store.getSession("s-resume");
    expect(s?.items).toHaveLength(1);
    expect(s?.resumeState).toEqual({ phase: "resuming" }); // 链不宣称成功：收敛由实时事件驱动复位
    // 实时事件到达即收敛（applyEvent 的 session_status 分支复位 resumeState）
    store.applyEvent({ type: "session_status", sessionId: "s-resume", seq: 2, at: "2026-01-01T00:00:02Z", status: "idle" });
    expect(store.getSession("s-resume")?.resumeState).toEqual({ phase: "idle" });
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
    expect(store.getSession("s-resume")?.resumeState).toEqual({ phase: "resuming" });
    expect(requests[0]?.channel).toBe("session:readHistory");
  });
});
