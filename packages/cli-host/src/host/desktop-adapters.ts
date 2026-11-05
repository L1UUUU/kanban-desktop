// 用途：desktop 场景 Adapter 工厂 —— fake/codex/claude 构造与 env 开关（KANBAN_DISABLE_* 回切 Fake 演示模式）；utilityProcess worker 与 Main 进程内回退共用
import type { CliAdapter } from "../adapter";
import { ClaudeAdapter } from "../claude-adapter";
import { CodexAdapter } from "../codex-adapter";
import { FakeAdapter } from "../fake-adapter";
import { createDefaultModelResolver } from "../codex/model-probe";

export interface DesktopAdapterFactoryOptions {
  /** config cliExe.codex 手动覆盖（缺省探测链） */
  codexExe?: string | null;
  /** config cliExe.claude 手动覆盖（缺省探测链） */
  claudeExe?: string | null;
  /** 模型探测缓存目录（userData；缺省不落盘） */
  cacheDir?: string;
  /** 诊断日志 */
  log?: (kind: string, detail: string) => void;
}

/** 按需构造：codex/claude 真实 Adapter（env KANBAN_DISABLE_CODEX/KANBAN_DISABLE_CLAUDE=1 时回落 Fake 演示模式）；fake 恒可用；opencode 暂以 Fake 演示兜底（真实实现自 #11 接入，保持「＋」菜单三 CLI 均可新建） */
export function createDesktopAdapterFactory(options: DesktopAdapterFactoryOptions = {}): (cli: string) => CliAdapter {
  const disableCodex = process.env.KANBAN_DISABLE_CODEX === "1";
  const disableClaude = process.env.KANBAN_DISABLE_CLAUDE === "1";
  return (cli: string): CliAdapter => {
    if (cli === "codex") {
      if (disableCodex) return new FakeAdapter();
      return new CodexAdapter({
        exe: options.codexExe ?? null,
        effort: process.env.KANBAN_CODEX_EFFORT,
        resolveModel: createDefaultModelResolver({ exe: options.codexExe ?? null, cacheDir: options.cacheDir }),
        log: options.log,
      });
    }
    if (cli === "claude") {
      if (disableClaude) return new FakeAdapter();
      return new ClaudeAdapter({ exe: options.claudeExe ?? null, log: options.log });
    }
    if (cli === "fake") return new FakeAdapter();
    // opencode：Fake 演示兜底（GUI 可建会话不阻塞；真实 Adapter 落地后此分支删除）
    return new FakeAdapter();
  };
}
