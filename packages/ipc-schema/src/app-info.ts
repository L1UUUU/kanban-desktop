// 用途：应用运行信息的 wire 契约（主进程提供、renderer 展示；本工单的 zod 冒烟面，spec E）
import { z } from "zod";

export const appInfoSchema = z.object({
  app: z.string(),
  electron: z.string(),
  node: z.string(),
  chrome: z.string(),
  platform: z.string(),
  sqliteEntry: z.string(),
  /** Fake 演示会话 cwd（Main 注入：env KANBAN_FAKE_DEMO_CWD 覆盖、缺省用户主目录；renderer 不内置任何路径） */
  fakeDemoCwd: z.string(),
});

export type AppInfo = z.infer<typeof appInfoSchema>;

/** 退出通知（main→renderer 推送，通道 app:shutdown）：统一退出序列第 1 步「停止接收新请求」的 UI 提示载荷（#13/spec H） */
export const shutdownNoticeSchema = z.object({
  reason: z.string(),
});
export type ShutdownNotice = z.infer<typeof shutdownNoticeSchema>;
