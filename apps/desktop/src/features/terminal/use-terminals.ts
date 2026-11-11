// 用途：PTY 终端控制器 hook —— terminal:create/kill 请求接线 + terminal:event 订阅（data→manager 路由、started/exit→会话状态）；#60 草稿：点「＋」只开草稿（不落库不进侧栏不起进程），首输入触发创建（渲染端预生成 id + 首输入缓冲，失败保留可重试）；PTY 会话与 ChatStore 共享会话列表与激活态（cli="pty" 进 PTY 分组）
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { IpcResult, TerminalCommand } from "@kanban/ipc-schema";
import type { ChatTransport } from "../../lib/kanban-api";
import { createScopedLogger } from "../../lib/logger";
import type { ChatController } from "../chat/use-chat";
import { DEFAULT_MODEL } from "../chat/chat-store";
import { TerminalManager } from "./TerminalManager";
import { TerminalDraftController, type TerminalDraftSnapshot } from "./terminal-draft";

// 本文件日志出口（scope 固定 terminal，经 lib/logger 唯一出口发出）
const log = createScopedLogger("terminal");

export interface TerminalController {
  /** 打开 PTY 终端草稿（#60：全局仅一个，已有草稿被替换；无 command=交互 shell；requirementId 随首输入触发的创建落关联） */
  openDraft(opts: { projectId: string | null; cwd: string; command?: TerminalCommand; requirementId?: string }): void;
  /** 显式停止终端（PTY 进程终止唯一入口；切换/关标签不触发） */
  kill(terminalId: string): void;
  /** 丢弃当前草稿（切换会话/项目时静默丢弃；在途创建不取消，迟到成功仍登记会话） */
  discardDraft(): void;
  manager: TerminalManager;
  /** 当前 PTY 草稿（null=无；中央区渲染终端草稿视图的依据） */
  draft: TerminalDraftSnapshot | null;
}

export function useTerminals(transport: ChatTransport | null, chat: ChatController): TerminalController {
  // shortcut: drafts/manager 闭包直接捕获首帧 transport 与 chat.store（App 经 useMemo 同步建桥、测试首帧给定，身份稳定；
  // 复查触发：若未来出现「挂载时 transport=null、之后才可用」的路径，需改回 ref/effect 同步）
  const [drafts] = useState(
    () =>
      new TerminalDraftController({
        invoke: (req) =>
          transport?.invoke(req) ??
          Promise.resolve({ ok: false, error: { code: "E_INTERNAL", message: "transport 不可用" } } satisfies IpcResult),
        onCreated: (ev) => {
          // #20：卡片建终端的自动关联由 Main 原子完成（session_linked 推送回流看板 store）；拒绝仅报告不阻断终端
          if (ev.ok.linked === false)
            log.error("终端创建后自动关联被拒绝", {
              sessionId: ev.terminalId,
              ...(ev.ok.reason ? { reason: ev.ok.reason } : {}),
            });
          // #71 S2：PTY 创建成功经 SessionRegistry 窄面登记（迟到成功同样落行），不再直面 store
          chat.registerExternalSession({
            sessionId: ev.terminalId,
            cli: "pty",
            title: ev.ok.title ?? "终端",
            permMode: "auto",
            model: DEFAULT_MODEL,
            projectId: ev.opts.projectId,
            cwd: ev.opts.cwd,
            dirIdentity: ev.ok.dirIdentity ?? "none",
            worktreeName: ev.ok.worktreeName ?? null,
          });
          // 创建在途期间到达的输入补写（首输入已由 Main 在启动成功后重放，此处保持顺序补剩余）
          if (ev.remainder) void transport?.invoke({ channel: "terminal:write", terminalId: ev.terminalId, data: ev.remainder });
        },
        onFailed: (ev) => {
          log.error("终端创建失败", { terminalId: ev.terminalId, code: ev.code, message: ev.message });
        },
      }),
  );
  const draft = useSyncExternalStore(drafts.subscribe, drafts.getSnapshot);
  const [manager] = useState(
    () =>
      new TerminalManager({
        // #60：草稿态输入不直写通道（首输入触发创建、失败保留缓冲）；非草稿按原路径直写
        write: (terminalId, data) => {
          if (drafts.handleInput(terminalId, data)) return;
          void transport?.invoke({ channel: "terminal:write", terminalId, data });
        },
        resize: (terminalId, cols, rows) => {
          // 草稿无进程可 resize：仅记录尺寸，随创建请求携带
          if (drafts.recordSize(terminalId, cols, rows)) return;
          void transport?.invoke({ channel: "terminal:resize", terminalId, cols, rows });
        },
      }),
  );

  // terminal:event 订阅：data/横幅进 manager；started/exit 同步会话状态徽标（#71 S2 经 registry 窄面）
  useEffect(() => {
    if (!transport) return;
    return transport.onTerminalEvent((event) => {
      manager.handleEvent(event);
      if (event.type === "started") chat.updateExternalStatus(event.terminalId, "idle");
      else if (event.type === "exit") chat.updateExternalStatus(event.terminalId, "disconnected");
    });
  }, [transport, manager, chat]);

  // #57：丢弃当前草稿（useCallback 引用稳定——ChatWorkspace 切项目 effect 依赖它，draft 快照变化不得重建）
  const discardDraft = useCallback(() => {
    const prev = drafts.getSnapshot();
    if (!prev) return;
    manager.dispose(prev.terminalId);
    drafts.discard();
  }, [manager, drafts]);

  return useMemo<TerminalController>(
    () => ({
      manager,
      draft,
      openDraft: (opts) => {
        // 全局仅一个草稿：替换时释放旧草稿的 xterm 实例（在途创建不取消，迟到成功仍登记）
        const prev = drafts.getSnapshot();
        if (prev) manager.dispose(prev.terminalId);
        drafts.open(opts);
      },
      discardDraft,
      kill: (terminalId) => {
        void transport?.invoke({ channel: "terminal:kill", terminalId });
      },
    }),
    [manager, transport, drafts, draft, discardDraft],
  );
}
