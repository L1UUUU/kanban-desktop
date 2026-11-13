# kanban-desktop

## Agent skills

### Issue tracker

工单跟踪在 GitHub Issues（L1UUUU/kanban-desktop），通过 gh CLI 读写。见 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认五个角色标签，标签名与角色名一致。见 `docs/agents/triage-labels.md`。

### Domain docs

single-context 布局：根目录 `GLOSSARY.md` + `docs/adr/`。`/design-feature` 不产出 ADR/GLOSSARY；规划中敲定的重要决策与术语仍应经 `/domain-modeling` 落档保存。见 `docs/agents/domain.md`。

### Testing

三执行类硬规则：密封测试紧邻被测源码 `*.test.ts(x)`；需真实 CLI/PTY 进程的落所属包 `tests/e2e/*.e2e.test.ts`（`KANBAN_E2E === "1"` 门禁）；整机 E2E 落 `apps/desktop/e2e/*.spec.ts`（Playwright）。注意双 e2e 目录区分：`apps/desktop/tests/e2e/` 是 vitest B 类，`apps/desktop/e2e/` 是 Playwright C 类。见 `docs/testing.md`。

真实调用 codex 的测试（B/C 类）必须设 `KANBAN_CODEX_MODEL=gpt-6-luna,gpt-5.6-luna` 控制模型成本（白名单按序试探，全败报错不回退）。见 `docs/testing.md` 门禁协议表。

### 门禁与标准

验收用 `pnpm lint:strict`（warning 视为失败）、`pnpm typecheck`、`pnpm test`、`pnpm check:gates`；四者已由 `.githooks/pre-commit`（每个 commit）、`.githooks/pre-push`（推 main 前验合并树——merge commit 不经 pre-commit）与 CI 强制执行。判断性编码标准见 `CODING_STANDARDS.md`（review agent 读）。

### 仓库地图

新任务开工前读 `docs/agents/navigation.md`：模块入口、文档索引、改动时需一并核对的隐藏同步点、评审标准源。
