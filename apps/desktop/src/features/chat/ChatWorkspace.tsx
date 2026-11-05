// 用途：聊天工作区 —— useChatController 接线侧栏 + 聊天区（transport 可注入：生产 window.api，测试 FakeAdapter 直连）
import type { ReactNode } from "react";
import { Sidebar } from "../../components/Sidebar";
import type { ChatTransport } from "../../lib/kanban-api";
import { ChatPane } from "./ChatPane";
import { useChatController, type ChatController } from "./use-chat";

export function ChatWorkspace({
  transport,
  onController,
  sidebarFooter,
}: {
  transport: ChatTransport | null;
  /** 暴露 controller（测试驱动用；生产不传） */
  onController?: (controller: ChatController) => void;
  sidebarFooter?: ReactNode;
}) {
  const controller = useChatController(transport);
  if (onController) onController(controller);

  return (
    <div className="grid min-h-0 grid-cols-[240px_1fr]">
      <Sidebar
        sessions={controller.sessions}
        activeId={controller.activeId}
        onSelect={controller.switchTo}
        onCreate={() => void controller.createSession()}
        info={sidebarFooter}
      />
      <ChatPane
        session={controller.activeSession}
        version={controller.version}
        actions={{
          onSend: controller.send,
          onInterrupt: controller.interrupt,
          onPermChange: controller.setPerm,
          onModelChange: controller.setModel,
          onResolveApproval: controller.resolveApproval,
        }}
      />
    </div>
  );
}
