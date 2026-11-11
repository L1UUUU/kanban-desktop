// 用途：消息流 —— 用户气泡 / 助手流式文本（▍ 光标）/ 工具卡混排（原型一致项 5；内容列 860px 居中）
import type { ChatItem } from "../chat-store";
import { sessionCliLabel } from "../../../lib/cli-catalog";
import { ToolCard } from "./ToolCard";

export function MessageList({ items, cli }: { items: ChatItem[]; cli: string }) {
  return (
    <>
      {items.map((item) => {
        if (item.kind === "user") {
          return (
            <div key={item.itemId} className="mx-auto mb-3.5 max-w-[860px]">
              <div className="mb-0.5 text-[11px] text-muted-foreground">你</div>
              <div className="inline-block max-w-full whitespace-pre-wrap rounded-[10px] border border-border bg-muted px-3 py-2">
                {item.text}
              </div>
            </div>
          );
        }
        if (item.kind === "assistant") {
          return (
            <div key={`${item.itemId}:${item.partId}`} className="mx-auto mb-3.5 max-w-[860px]">
              <div className="mb-0.5 text-[11px] text-muted-foreground">{sessionCliLabel(cli)}</div>
              <div className="whitespace-pre-wrap">
                {item.text}
                {item.streaming ? <span className="stream-cursor">▍</span> : null}
              </div>
            </div>
          );
        }
        return <ToolCard key={item.itemId} item={item} />;
      })}
    </>
  );
}
