// 用途：中央聊天区 —— 会话级 banner 栈（冲突条 spec I-4 / 同名 skill 条 #21 / 恢复引导条 #42，自上而下）+ 消息流 + 审批卡 + 取消/错误卡（#46 ErrorBanner 五卡）+ composer（flex 列：banner + 1fr 消息 + auto composer；无会话时降级占位）
import { useEffect, useRef } from "react";
import type { ApprovalDecision } from "@kanban/ipc-schema";
import type { SessionView } from "./chat-store";
import type { ModelCatalog } from "./model-catalog";
import { ApprovalCard } from "./components/ApprovalCard";
import { Composer, type ComposerActions } from "./components/Composer";
import { ErrorBanner } from "./components/ErrorBanner";
import { MessageList } from "./components/MessageList";
import { ResumeBanner } from "./components/ResumeBanner";

export interface ChatPaneActions extends ComposerActions {
  onResolveApproval(decision: ApprovalDecision): void;
  /** 断开会话「读取原生历史并恢复」（#9） */
  onResume(sessionId: string): void;
  /** #21：关闭同名 skill 冲突提示条（仅隐藏不影响会话） */
  onDismissSkillConflict(sessionId: string): void;
  /** #46：错误卡「知道了」清除会话 lastError（仅隐藏） */
  onDismissError(sessionId: string): void;
  /** #46：认证失效卡「打开 PTY 终端」——在会话 cwd 新建 PTY 终端（在终端内运行登录指引命令） */
  onOpenPtyTerminal(sessionId: string): void;
}

export function ChatPane({
  session,
  models,
  version,
  conflictTitles,
  configPath = null,
  actions,
}: {
  session: SessionView | null;
  /** 模型目录控制器（issue #77）：composer 挂载预取与 combobox 数据源 */
  models: ModelCatalog;
  version: number;
  /** 主仓库并行冲突会话名（≥2 活跃时非空；仅提示不阻止，spec I-4） */
  conflictTitles: string[] | null;
  /** #46：配置文件绝对路径（spawn 失败卡「复制配置路径」；AppInfo 注入） */
  configPath?: string | null;
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
            <p className="text-sm text-muted-foreground">暂无会话</p>
            <p className="mt-2 text-[11px] text-fg-faint">在左侧注册项目后，项目行悬浮「＋」选择 CLI 新建会话，或从会话列表选择已有会话</p>
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
    <section className="flex min-h-0 min-w-0 flex-col bg-background">
      {conflictTitles && conflictTitles.length >= 2 ? (
        // 冲突提示条（原型一致项 4）：列出会话名，仅提示不阻止；会话数变化时随 store 快照动态增减
        <div data-testid="conflict-banner" className="flex-none border-b border-warn/40 bg-warn/10 px-6 py-2 text-xs text-warn">
          ⚠ 主仓库并行会话（{conflictTitles.length} 个）：{conflictTitles.join("、")} 正在同一目录运行，注意文件冲突
        </div>
      ) : null}
      {session.skillConflicts.length > 0 && !session.skillConflictDismissed ? (
        // Claude 同名 skill 提示条（#21 / 原型一致项 7）：warn 样式、列冲突名 +「项目级将优先生效」说明、可关闭；非阻塞——关闭仅隐藏，不影响会话
        <div
          data-testid="skill-conflict-banner"
          className="flex flex-none items-center gap-2 border-b border-warn/40 bg-warn/10 px-6 py-2 text-xs text-warn"
        >
          <span>
            ⚠ 检测到同名 skill：<b>{session.skillConflicts.join("、")}</b>
            （项目级与用户级同名，项目级将优先生效；同名可能使模型行为不稳定）
          </span>
          <button
            type="button"
            onClick={() => actions.onDismissSkillConflict(session.sessionId)}
            className="ml-auto shrink-0 opacity-70 hover:opacity-100"
          >
            知道了
          </button>
        </div>
      ) : null}
      {session.status === "disconnected" ? (
        // #42 恢复引导条（会话级 banner 最下层，spec G 叠加顺序）：断开会话顶部常驻三态入口，
        // 移除消息流底部弱入口（顶部条为唯一常驻入口；错误卡动作是同一动作的快捷方式，D4）
        <ResumeBanner
          title={session.title}
          resumeState={session.resumeState}
          onResume={() => actions.onResume(session.sessionId)}
        />
      ) : null}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <MessageList items={session.items} cli={session.cli} />
        {session.pendingApproval ? (
          <ApprovalCard approval={session.pendingApproval} onDecide={actions.onResolveApproval} />
        ) : null}
        {session.status === "interrupted" ? (
          <div className="mx-auto mb-3.5 max-w-[860px] text-center text-xs text-muted-foreground">
            — 本轮已取消，会话保留，可继续发消息 —
          </div>
        ) : null}
        {session.lastError ? (
          // #46 错误卡（原型 d2 五卡信息结构）：替换旧红字一行；重试=重发最近一条用户消息，
          // 恢复=与恢复引导条同一动作（D4），打开 PTY 终端=在会话 cwd 新建终端（认证指引）
          <ErrorBanner
            code={session.lastError.code}
            message={session.lastError.message}
            cli={session.cli}
            title={session.title}
            configPath={configPath}
            canRetry={session.items.some((i) => i.kind === "user")}
            canOpenPtyTerminal={session.cwd !== null}
            onResume={() => actions.onResume(session.sessionId)}
            onRetry={() => {
              const lastUser = [...session.items].reverse().find((i) => i.kind === "user");
              if (lastUser && lastUser.kind === "user") actions.onSend(lastUser.text);
            }}
            onOpenPtyTerminal={() => actions.onOpenPtyTerminal(session.sessionId)}
            onDismiss={() => actions.onDismissError(session.sessionId)}
          />
        ) : null}
      </div>
      <Composer session={session} models={models} actions={actions} />
    </section>
  );
}
