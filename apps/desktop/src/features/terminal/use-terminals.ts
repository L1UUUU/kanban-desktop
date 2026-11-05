// 用途：PTY 终端控制器 hook —— terminal:create/kill 请求接线 + terminal:event 订阅（data→manager 路由、started/exit→会话状态）；PTY 会话与 ChatStore 共享会话列表与激活态（cli="pty" 进 PTY 分组）
import { useEffect, useMemo, useState } from "react";
import type { TerminalCommand } from "@kanban/ipc-schema";
import type { ChatTransport } from "../../lib/kanban-api";
import type { ChatController } from "../chat/use-chat";
import { DEFAULT_MODEL } from "../chat/use-chat";
import { TerminalManager } from "./TerminalManager";

export interface TerminalController {
  /** 新建终端会话（无 command=交互 shell；command=直接跑 CLI TUI） */
  create(opts: { projectId: string | null; cwd: string; command?: TerminalCommand }): Promise<void>;
  /** 显式停止终端（PTY 进程终止唯一入口；切换/关标签不触发） */
  kill(terminalId: string): void;
  manager: TerminalManager;
}

export function useTerminals(transport: ChatTransport | null, chat: ChatController): TerminalController {
  // shortcut: manager 闭包直接捕获首帧 transport（App 经 useMemo 同步建桥、测试首帧给定，身份稳定；
  // 复查触发：若未来出现「挂载时 transport=null、之后才可用」的路径，需改回 ref/effect 同步）
  const [manager] = useState(
    () =>
      new TerminalManager({
        write: (terminalId, data) => {
          void transport?.invoke({ channel: "terminal:write", terminalId, data });
        },
        resize: (terminalId, cols, rows) => {
          void transport?.invoke({ channel: "terminal:resize", terminalId, cols, rows });
        },
      }),
  );

  // terminal:event 订阅：data/横幅进 manager；started/exit 同步会话状态徽标
  useEffect(() => {
    if (!transport) return;
    return transport.onTerminalEvent((event) => {
      manager.handleEvent(event);
      if (event.type === "started") chat.store.updateStatus(event.terminalId, "idle");
      else if (event.type === "exit") chat.store.updateStatus(event.terminalId, "disconnected");
    });
  }, [transport, manager, chat]);

  return useMemo<TerminalController>(
    () => ({
      manager,
      create: async (opts) => {
        if (!transport) return;
        const r = await transport.invoke({
          channel: "terminal:create",
          cwd: opts.cwd,
          projectId: opts.projectId ?? undefined,
          command: opts.command,
        });
        if (r.ok && r.sessionId) {
          chat.store.registerSession({
            sessionId: r.sessionId,
            cli: "pty",
            title: r.title ?? "终端",
            permMode: "auto",
            model: DEFAULT_MODEL,
            projectId: opts.projectId,
            cwd: opts.cwd,
            dirIdentity: r.dirIdentity ?? "none",
            worktreeName: r.worktreeName ?? null,
          });
        } else if (!r.ok) {
          console.error("[kanban] 终端创建失败", r.error);
        }
      },
      kill: (terminalId) => {
        void transport?.invoke({ channel: "terminal:kill", terminalId });
      },
    }),
    [chat, manager, transport],
  );
}
