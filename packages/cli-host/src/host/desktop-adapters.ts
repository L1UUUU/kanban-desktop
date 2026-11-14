// 用途：desktop 场景 Adapter 工厂 —— fake/codex/claude/opencode 构造与 env 开关（KANBAN_DISABLE_* 回切 Fake 演示模式）；utilityProcess worker 与 Main 进程内回退共用
import type { LogKind } from "@kanban/ipc-schema";
import path from "node:path";
import type { CliAdapter } from "../adapter";
import { ClaudeAdapter } from "../claude-adapter";
import { CodexAdapter } from "../codex-adapter";
import { FakeAdapter } from "../fake-adapter";
import { OpenCodeAdapter } from "../opencode-adapter";
import { createDefaultModelResolver } from "../codex/model-probe";
import { CLI_REGISTRY } from "../exe-registry";

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
  log?: (kind: LogKind, detail: string) => void;
}

/** 按需构造：codex/claude/opencode 真实 Adapter（env KANBAN_DISABLE_*（开关名单源 = CLI_REGISTRY 元数据，arch D5）=1 时回落 Fake 演示模式）；fake 恒可用 */
export function createDesktopAdapterFactory(options: DesktopAdapterFactoryOptions = {}): (cli: string) => CliAdapter {
  // Fake 回切开关快照（工厂创建时逐注册表条目判定；与 cli:status 旁路同一开关语义）
  const fakeFallback = new Set(
    Object.entries(CLI_REGISTRY)
      .filter(([, entry]) => process.env[entry.disableEnv] === "1")
      .map(([cli]) => cli),
  );
  // #42 e2e 支撑：Fake 的 resume 注入开关（延迟观察「恢复中」态 / 前 N 次失败驱动重试态）；env 逐级继承到 worker，生产不设即关闭
  const fakeResumeDelayMs = envInt("KANBAN_FAKE_RESUME_DELAY_MS");
  const fakeFailResumeFirst = envInt("KANBAN_FAKE_RESUME_FAIL_FIRST");
  // #46 e2e 支撑：前 N 次创建抛 E_SPAWN_NOT_FOUND（整机 Playwright 驱动侧栏 spawn 失败卡；env 逐级继承到 worker，生产不设即关闭）
  const fakeFailCreateFirst = envInt("KANBAN_FAKE_CREATE_FAIL_FIRST");
  // #81 e2e 支撑（spec #75）：模型链路注入——listModels 延迟（观察 combobox 加载阻塞）/ 前 N 次拉取失败（失败态手输兜底）/ 前 N 次切换失败（回滚）
  const fakeModelsDelayMs = envInt("KANBAN_FAKE_MODELS_DELAY_MS");
  const fakeFailModelsFirst = envInt("KANBAN_FAKE_MODELS_FAIL_FIRST");
  const fakeFailSetModelFirst = envInt("KANBAN_FAKE_SETMODEL_FAIL_FIRST");
  // #95 e2e 支撑：Fake summarizeTitle 前置延迟（整机 Playwright 观察「摘要进行中手动重命名不被覆盖」竞态）
  const fakeSummarizeDelayMs = envInt("KANBAN_FAKE_SUMMARIZE_DELAY_MS");
  const makeFake = (): FakeAdapter =>
    new FakeAdapter({
      resumeDelayMs: fakeResumeDelayMs,
      failResumeFirst: fakeFailResumeFirst,
      failCreateFirst: fakeFailCreateFirst,
      modelsDelayMs: fakeModelsDelayMs,
      failModelsFirst: fakeFailModelsFirst,
      failSetModelFirst: fakeFailSetModelFirst,
      summarizeDelayMs: fakeSummarizeDelayMs,
    });
  return (cli: string): CliAdapter => {
    if (cli === "codex") {
      if (fakeFallback.has("codex")) return makeFake();
      return new CodexAdapter({
        exe: options.codexExe ?? null,
        effort: process.env.KANBAN_CODEX_EFFORT,
        resolveModel: createDefaultModelResolver({ exe: options.codexExe ?? null, cacheDir: options.cacheDir }),
        log: options.log,
      });
    }
    if (cli === "claude") {
      if (fakeFallback.has("claude")) return makeFake();
      return new ClaudeAdapter({ exe: options.claudeExe ?? null, log: options.log });
    }
    if (cli === "opencode") {
      if (fakeFallback.has("opencode")) return makeFake();
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

/** 环境变量整数解析：读 env 数字注入开关，缺省/非法回 0（Fake e2e 支撑 6 处统一口径，契约单源收口） */
function envInt(name: string): number {
  return Number(process.env[name] ?? "") || 0;
}
