// 用途：应用运行信息的 wire 契约（主进程提供、renderer 展示；本工单的 zod 冒烟面，spec E）
import { z } from "zod";

export const appInfoSchema = z.object({
  app: z.string(),
  electron: z.string(),
  node: z.string(),
  chrome: z.string(),
  platform: z.string(),
  sqliteEntry: z.string(),
});

export type AppInfo = z.infer<typeof appInfoSchema>;
