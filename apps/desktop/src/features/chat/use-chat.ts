// 用途：聊天控制器 hook —— transport → ChatStore 接线：全部会话始终归并（切会话不中断，一致项 7），动作经 IPC 单通道发出
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AdapterEvent, ApprovalDecision, ChatEvent, IpcResult, PermMode } from "@kanban/ipc-schema";
import type { ChatTransport } from "../../lib/kanban-api";
import { ChatStore, type SessionView } from "./chat-store";

// Fake 演示会话的项目目录（演示数据集中一处；真实项目注册属 #8）
export const FAKE_DEMO_CWD = "C:\\project2\\kanban-desktop";
export const DEFAULT_MODEL = "默认模型";

export interface ChatControllerActions {
  send(text: string): void;
  interrupt(): void;
  resolveApproval(decision: ApprovalDecision): void;
  createSession(): Promise<void>;
  switchTo(sessionId: string): void;
  setPerm(mode: PermMode): void;
  setModel(model: string): void;
}

export interface ChatController extends ChatControllerActions {
  sessions: SessionView[];
  activeSession: SessionView | null;
  activeId: string | null;
  /** store 版本号（驱动视图滚动等副作用） */
  version: number;
}

/** ChatEvent 判别（SkillObservation 无 type 判别字段） */
function isChatEvent(e: AdapterEvent): e is ChatEvent {
  return "type" in e;
}

export function useChatController(transport: ChatTransport | null): ChatController {
  // useState 初始化器保证每 hook 实例一个 store（渲染期可安全读取）
  const [store] = useState(() => new ChatStore());
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // 首会话自举一次性标记（仅 effect 内读写：StrictMode 双挂载下只建一次会话，订阅仍每次重建）
  const bootRef = useRef(false);

  // 事件订阅 + 首个会话自举：事件对全部会话始终归并（与激活视图无关 —— 切换不停止）
  useEffect(() => {
    if (!transport) return;
    const off = transport.onEvent((e) => {
      if (isChatEvent(e)) store.applyEvent(e);
    });
    if (!bootRef.current) {
      bootRef.current = true;
      void createFakeSession(transport, store, "演示会话 · Fake");
    }
    return off;
  }, [transport, store]);

  const actions = useMemo<ChatControllerActions>(() => {
    const activeId = (): string | null => store.getSnapshot().activeId;
    const report = (p: Promise<IpcResult>, sessionId: string): void => {
      void p.then((r) => {
        if (!r.ok) store.setError(sessionId, r.error.code, r.error.message);
      });
    };
    return {
      send: (text) => {
        const id = activeId();
        if (!id || !transport || text.trim().length === 0) return;
        store.appendUserMessage(id, text);
        report(transport.invoke({ channel: "session:send", sessionId: id, text }), id);
      },
      interrupt: () => {
        const id = activeId();
        if (!id || !transport) return;
        report(transport.invoke({ channel: "session:interrupt", sessionId: id }), id);
      },
      resolveApproval: (decision) => {
        const id = activeId();
        const pending = id ? store.getSession(id)?.pendingApproval : null;
        if (!id || !pending || !transport) return;
        store.clearApproval(id); // 决定即时生效：卡片立即消失（后续输出经事件流差异呈现）
        report(
          transport.invoke({
            channel: "session:resolveApproval",
            sessionId: id,
            requestId: pending.requestId,
            decision,
          }),
          id,
        );
      },
      createSession: async () => {
        if (!transport) return;
        await createFakeSession(transport, store, "新会话 · Fake");
      },
      switchTo: (sessionId) => store.setActive(sessionId),
      setPerm: (mode) => {
        const id = activeId();
        if (id) store.updateSession(id, { permMode: mode });
      },
      setModel: (model) => {
        const id = activeId();
        if (id) store.updateSession(id, { model });
      },
    };
  }, [transport, store]);

  const activeSession = snap.activeId ? (store.getSession(snap.activeId) ?? null) : null;

  return { ...actions, sessions: snap.sessions, activeSession, activeId: snap.activeId, version: snap.version };
}

/** 创建 Fake 会话并登记激活 */
async function createFakeSession(transport: ChatTransport, store: ChatStore, title: string): Promise<void> {
  const r = await transport.invoke({
    channel: "session:create",
    cli: "fake",
    cwd: FAKE_DEMO_CWD,
    title,
    permMode: "auto",
  });
  if (r.ok && r.sessionId) {
    store.registerSession({
      sessionId: r.sessionId,
      cli: r.cli ?? "fake",
      title: r.title ?? title,
      permMode: "auto",
      model: DEFAULT_MODEL,
    });
  } else if (!r.ok) {
    // 创建失败也要可见（如 Main 校验拒绝）：挂到错误展示需有会话，此处直接 console 报告
    console.error("[kanban] 会话创建失败", r.error);
  }
}
