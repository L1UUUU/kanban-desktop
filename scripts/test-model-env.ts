// 用途：测试进程默认注入 codex 模型白名单 —— 真实 CLI 测试不跟随最近 rollout 的昂贵模型
// 由 Playwright config 与 B 类 e2e 命令加载；显式设置的会话级 env 优先（不覆盖已有值）
export const TEST_CODEX_MODELS = "gpt-6-luna,gpt-5.6-luna";

/** 给当前进程注入默认白名单，子进程（Electron/utilityProcess worker）经 env 继承生效 */
export function ensureTestModelEnv() {
  if (!process.env.KANBAN_CODEX_MODEL) process.env.KANBAN_CODEX_MODEL = TEST_CODEX_MODELS;
}
