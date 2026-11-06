# kanban-desktop

## Agent skills

### Issue tracker

工单跟踪在 GitHub Issues（L1UUUU/kanban-desktop），通过 gh CLI 读写。见 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认五个角色标签，标签名与角色名一致。见 `docs/agents/triage-labels.md`。

### Domain docs

single-context 布局：根目录 `GLOSSARY.md` + `docs/adr/`。见 `docs/agents/domain.md`。

### Testing

三执行类硬规则：密封测试紧邻被测源码 `*.test.ts(x)`；需真实 CLI/PTY 进程的落所属包 `tests/e2e/*.e2e.test.ts`（`KANBAN_E2E === "1"` 门禁）；整机 E2E 落 `apps/desktop/e2e/*.spec.ts`（Playwright）。注意双 e2e 目录区分：`apps/desktop/tests/e2e/` 是 vitest B 类，`apps/desktop/e2e/` 是 Playwright C 类。见 `docs/testing.md`。
