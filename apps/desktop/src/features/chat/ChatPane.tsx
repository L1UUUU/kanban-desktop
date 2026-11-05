// 用途：中央聊天区 —— 消息流 + 审批卡 + 取消/错误提示 + composer（grid: 1fr 消息 + auto composer；无会话时降级占位）
import { useEffect, useRef } from "react";
import type { ApprovalDecision } from "@kanban/ipc-schema";
import type { SessionView } from "./chat-store";
import { ApprovalCard } from "./components/ApprovalCard";
import { Composer, type ComposerActions } from "./components/Composer";
import { MessageList } from "./components/MessageList";

export interface ChatPaneActions extends ComposerActions {
  onResolveApproval(decision: ApprovalDecision): void;
  /** 断开会话「读取原生历史并恢复」（#9） */
  onResume(sessionId: string): void;
}

export function ChatPane({
  session,
  version,
  actions,
}: {
  session: SessionView | null;
  version: number;
  actions: ChatPaneActions;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 内容增长（流式/工具输出/状态变化）时保持滚动到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [version, session?.sessionId]);

  if (!session) {
    return (
      <section className="grid min-h-0 min-w-0 grid-rows-[1fr_auto] bg-background">
        <div className="overflow-y-auto px-6 py-4">
          <div className="mx-auto max-w-[860px]">
            <p className="text-sm text-muted-foreground">聊天区占位 —— 会话由 Fake 链路（#6）接入，IPC 桥接不可用</p>
            <p className="mt-2 text-[11px] text-fg-faint">运行信息不可用（window.api 未暴露）</p>
          </div>
        </div>
        <footer className="border-t border-border bg-card px-6 pb-4 pt-3">
          <div className="mx-auto max-w-[860px] rounded-[14px] border border-border bg-muted px-3.5 py-2.5">
            <textarea
              disabled
              placeholder="输入消息，/ 开头触发 Skill…"
              rows={2}
              className="min-h-[46px] w-full resize-none bg-transparent text-[13px] text-muted-foreground outline-none placeholder:text-fg-faint"
            />
          </div>
        </footer>
      </section>
    );
  }

  return (
    <section className="grid min-h-0 min-w-0 grid-rows-[1fr_auto] bg-background">
      <div ref={scrollRef} className="overflow-y-auto px-6 py-4">
        <MessageList items={session.items} cli={session.cli} />
        {session.pendingApproval ? (
          <ApprovalCard approval={session.pendingApproval} onDecide={actions.onResolveApproval} />
        ) : null}
        {session.status === "interrupted" ? (
          <div className="mx-auto mb-3.5 max-w-[860px] text-center text-xs text-muted-foreground">
            — 本轮已取消，会话保留，可继续发消息 —
          </div>
        ) : null}
        {session.status === "disconnected" ? (
          // 断开会话（重启恢复的历史会话）：缓存不替代原生历史（原型 L424 文案 + 恢复入口，一致项 5）
          <div className="mx-auto mb-3.5 max-w-[860px] text-center text-xs text-muted-foreground">
            <span>该会话来自上次运行（CLI 已退出）。缓存不替代原生历史。</span>
            <button
              type="button"
              onClick={() => actions.onResume(session.sessionId)}
              className="ml-2 rounded-md border border-primary/60 px-3 py-1 text-xs text-primary hover:bg-primary/10"
            >
              读取原生历史并恢复
            </button>
          </div>
        ) : null}
        {session.lastError ? (
          <div className="mx-auto mb-3.5 max-w-[860px] text-center text-xs text-destructive">
            ⚠ {session.lastError.message}
          </div>
        ) : null}
      </div>
      <Composer session={session} actions={actions} />
    </section>
  );
}
