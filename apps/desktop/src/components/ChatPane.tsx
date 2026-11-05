// 用途：中央聊天区骨架 —— 消息流占位 + 运行信息行 + composer 占位（聊天/工具卡/审批卡由 #6 Fake 链路接入）
import type { AppInfo } from "@kanban/ipc-schema";

export function ChatPane({ info }: { info: AppInfo | null }) {
  return (
    <section className="grid min-h-0 min-w-0 grid-rows-[1fr_auto] bg-background">
      {/* 消息流占位（原型：内容列 max-width 860px 居中） */}
      <div className="overflow-y-auto px-6 py-4">
        <div className="mx-auto max-w-[860px]">
          <p className="text-sm text-muted-foreground">聊天区占位 —— 消息流、工具卡与审批卡由 Fake 链路（#6）接入</p>
          {info ? (
            <p className="mt-2 text-[11px] text-fg-faint">
              运行信息：{info.app} · Electron {info.electron} · Node {info.node} · SQLite {info.sqliteEntry}
            </p>
          ) : (
            <p className="mt-2 text-[11px] text-fg-faint">运行信息不可用（window.api 未暴露）</p>
          )}
        </div>
      </div>

      {/* composer 占位：聚焦高亮容器 + 权限/模型 chip + 发送钮（真实交互属 #6，一致项 6） */}
      <footer className="border-t border-border bg-card px-6 pb-4 pt-3">
        <div className="mx-auto max-w-[860px] rounded-[14px] border border-border bg-muted px-3.5 py-2.5 transition-colors focus-within:border-primary">
          <textarea
            disabled
            placeholder="输入消息，/ 开头触发 Skill…"
            rows={2}
            className="min-h-[46px] w-full resize-none bg-transparent text-[13px] text-muted-foreground outline-none placeholder:text-fg-faint disabled:text-muted-foreground"
          />
          <div className="mt-2 flex items-center gap-2">
            <span className="inline-flex h-7 items-center rounded-full border border-ok/50 px-3 text-xs text-ok">
              ⚡ 权限：自动
            </span>
            <span className="inline-flex h-7 items-center rounded-full border px-3 text-xs text-muted-foreground">默认模型</span>
            <span className="flex-1" />
            <button
              disabled
              type="button"
              className="h-[30px] rounded-full bg-primary px-4 text-xs text-primary-foreground opacity-60"
            >
              发送 ➤
            </button>
          </div>
        </div>
      </footer>
    </section>
  );
}
