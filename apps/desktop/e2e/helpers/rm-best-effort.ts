// 用途：e2e 临时目录尽力删除共享 helper —— Windows 下 electron/Crashpad 子进程退出有延迟，重试后仍锁则告警放行（不判测试失败）；Playwright C 类 spec 与 B 类 e2e.test 共用
import { rmSync } from "node:fs";

/** 尽力删除目录：重试期间占用方退出即成功；重试耗尽仍被占用则告警放行 */
export async function rmBestEffort(target: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.warn(`[e2e] 临时目录仍被占用，跳过清理：${target}`);
}
