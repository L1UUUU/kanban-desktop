// 用途：顶栏 —— 应用名 + 当前项目名徽标 + 右侧设置入口（#55：点击弹纯 renderer DOM 浮层两项「打开日志文件/复制日志文件路径」，不新增 Electron 原生 Menu；原型一致项 1：bg2 底、下边框）
import { useState } from "react";
import type { ProjectRow } from "@kanban/ipc-schema";
import { copyText } from "../lib/copy-text";

export function TopBar({ currentProject }: { currentProject: ProjectRow | null }) {
  // #55：浮层展开态（纯 renderer DOM；可调整范围仅浮层样式与两项文案，spec #52 H 节）
  const [open, setOpen] = useState(false);

  /** 「打开日志文件」：资源管理器中定位当前启动主日志文件（Main 侧 shell.showItemInFolder 主文件）；jsdom 无桥可选链降级 */
  const openLog = (): void => {
    void window.api?.openLogDir();
    setOpen(false);
  };

  /** 「复制日志文件路径」：getLogPath 取主文件路径写剪贴板（沿用 copyText 惯例，失败记统一日志不抛出） */
  const copyLogPath = (): void => {
    void (async () => {
      const path = await window.api?.getLogPath();
      if (path) await copyText(path);
    })();
    setOpen(false);
  };

  return (
    <header className="relative flex h-[42px] shrink-0 items-center gap-3 border-b border-border bg-card px-3.5">
      <span className="text-[13px] font-bold">Kanban Desktop</span>
      {/* 当前项目名徽标（无项目=注册引导态提示） */}
      <span className="rounded border border-border px-1.5 text-[11px] text-muted-foreground">
        {currentProject ? currentProject.name : "未注册项目"}
      </span>
      <button type="button" className="ml-auto text-xs text-muted-foreground" onClick={() => setOpen((v) => !v)}>
        设置
      </button>
      {open && (
        <div className="absolute right-3.5 top-full z-10 flex flex-col rounded-md border border-border bg-card py-1 shadow-lg">
          <button type="button" className="rounded px-2.5 py-1 text-left text-xs text-muted-foreground hover:bg-muted" onClick={openLog}>
            打开日志文件
          </button>
          <button type="button" className="rounded px-2.5 py-1 text-left text-xs text-muted-foreground hover:bg-muted" onClick={copyLogPath}>
            复制日志文件路径
          </button>
        </div>
      )}
    </header>
  );
}
