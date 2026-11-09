// 用途：desktop 场景 Adapter 工厂 —— fake/codex/claude/opencode 构造与 env 开关（KANBAN_DISABLE_* 回切 Fake 演示模式）；utilityProcess worker 与 Main 进程内回退共用
import path from "node:path";
import type { CliAdapter } from "../adapter";
import { ClaudeAdapter } from "../claude-adapter";
import { CodexAdapter } from "../codex-adapter";
import { FakeAdapter } from "../fake-adapter";
import { OpenCodeAdapter } from "../opencode-adapter";
import { createDefaultModelResolver } from "../codex/model-probe";

export interface DesktopAdapterFactoryOptions {
  /** config cliExe.codex 手动覆盖（缺省探测链） */
  codexExe?: string | null;
  /** config cliExe.claude 手动覆盖（缺省探测链） */
  claudeExe?: string | null;
  /** config cliExe.opencode 手动覆盖（缺省探测链：原生安装 → npm 全局） */
  opencodeExe?: string | null;
  /** 模型探测缓存目录（userData；缺省不落盘）——亦作 OpenCode 孤儿接管注册表落盘目录 */
  cacheDir?: string;
  /** 诊断日志 */
  log?: (kind: string, detail: string) => void;
}

/** 按需构造：codex/claude/opencode 真实 Adapter（env KANBAN_DISABLE_CODEX/KANBAN_DISABLE_CLAUDE/KANBAN_DISABLE_OPENCODE=1 时回落 Fake 演示模式）；fake 恒可用 */
export function createDesktopAdapterFactory(options: DesktopAdapterFactoryOptions = {}): (cli: string) => CliAdapter {
  const disableCodex = process.env.KANBAN_DISABLE_CODEX === "1";
  const disableClaude = process.env.KANBAN_DISABLE_CLAUDE === "1";
  const disableOpencode = process.env.KANBAN_DISABLE_OPENCODE === "1";
  // #42 e2e 支撑：Fake 的 resume 注入开关（延迟观察「恢复中」态 / 前 N 次失败驱动重试态）；env 逐级继承到 worker，生产不设即关闭
  const fakeResumeDelayMs = Number(process.env.KANBAN_FAKE_RESUME_DELAY_MS ?? "") || 0;
  const fakeFailResumeFirst = Number(process.env.KANBAN_FAKE_RESUME_FAIL_FIRST ?? "") || 0;
  const makeFake = (): FakeAdapter => new FakeAdapter({ resumeDelayMs: fakeResumeDelayMs, failResumeFirst: fakeFailResumeFirst });
  return (cli: string): CliAdapter => {
    if (cli === "codex") {
      if (disableCodex) return makeFake();
      return new CodexAdapter({
        exe: options.codexExe ?? null,
        effort: process.env.KANBAN_CODEX_EFFORT,
        resolveModel: createDefaultModelResolver({ exe: options.codexExe ?? null, cacheDir: options.cacheDir }),
        log: options.log,
      });
    }
    if (cli === "claude") {
      if (disableClaude) return makeFake();
      return new ClaudeAdapter({ exe: options.claudeExe ?? null, log: options.log });
    }
    if (cli === "opencode") {
      if (disableOpencode) return makeFake();
      return new OpenCodeAdapter({
        exe: options.opencodeExe ?? null,
        registryPath: options.cacheDir ? path.join(options.cacheDir, "opencode-servers.json") : undefined,
        log: options.log,
      });
    }
    if (cli === "fake") return makeFake();
    return makeFake();
  };
}
