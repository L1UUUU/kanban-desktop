# 仓库地图（docs/agents/navigation.md）

> 给 agent 的导航指针：新阶段/新任务开工前先读这里，替代每次重新"调查仓库现状"。
> 本文只记**位置与隐藏同步点**，业务结论看对应文档原文。

## 模块入口

| 关注点 | 位置 |
|---|---|
| Electron 主进程入口 | `apps/desktop/electron/main/index.ts` |
| 渲染进程根 | `apps/desktop/src/App.tsx` |
| 侧栏 / 项目行 | `apps/desktop/src/components/Sidebar.tsx` |
| 聊天工作区 | `apps/desktop/src/features/chat/ChatWorkspace.tsx` |
| IPC 契约（零 Node 依赖） | `packages/ipc-schema/src/`（含 `log.ts` 枚举/类型单源） |
| CLI 适配与模型解析 | `packages/cli-host/src/`（`codex/model-probe.ts`） |
| 看板/追踪 | `packages/tracker/src/` |
| 需求级经验提取 | `packages/memory/src/` |
| 主进程日志 | `apps/desktop/electron/main/logger.ts`、配置 `config.ts` |

## 文档索引

| 文档 | 内容 |
|---|---|
| `docs/testing.md` | 三执行类、门禁协议表、命令矩阵（**测试唯一权威出处**） |
| `CODING_STANDARDS.md` | 判断性编码标准 + 门禁命令清单（review agent 读） |
| `AGENTS.md` | 技能与 tracker 指针 |
| `docs/adr/0001-*.md`、`0002-*.md` | cli-host 托管 / 测试架构决策 |
| `docs/architecture-proposal.md` | 架构提案 |
| `docs/kanban-desktop-v1-plan.md` | v1 总计划 |
| `docs/cli-compatibility-matrix.md` | CLI 兼容矩阵 |
| `docs/poc-results.md` | T0 PoC 结论（含 POC 验证时凭据/版本前提） |
| `docs/prototypes/stage*.prototype.html` | 四个阶段的 UI 原型（验收依据，已入库） |
| `docs/acceptance/stage*/`、`docs/acceptance/logging/` | 各阶段验收报告与归档截图 |
| `GLOSSARY.md`、`docs/agents/domain.md` | 领域术语与 domain docs 布局 |
| `.out-of-scope/README.md` | 范围外决策账本（优先级声明 + 条目模板；"不做的决策"记这里，与 ADR 互补） |
| `docs/agents/issue-tracker.md` | gh CLI 能力、关单惯例 |
| `docs/agents/triage-labels.md` | 角色标签 |

## 隐藏同步点（改动时一并核对）

- **新增 config 字段**：`apps/desktop/electron/main/config.ts` 的 interface / defaultConfig / loadConfig 白名单 / index 传参，四处同步。
- **新增 workspace 包**：`apps/desktop/electron.vite.config.ts` 的 `workspacePackages`、`pnpm-workspace.yaml`、各包 `package.json`、`pnpm-lock.yaml`；漏 vite 登记会让 Playwright 启动即崩（`pnpm check:gates` 已拦截）。
- **新增测试 env 开关**：`docs/testing.md` 门禁协议表 + `scripts/check-gates.mjs`（B 类门控、`workspacePackages`、归档 PNG、文档互链）；测试写入 `docs/acceptance/` 走 `KANBAN_UPDATE_SCREENSHOTS=1`。
- **新增 CLI adapter**：对照现有三 CLI（claude/codex/opencode）同步登记：`packages/cli-host/src/<cli>/`（exe 探测链）+ `<cli>-adapter.ts`（含同名密封测试）+ `router-adapter.ts` + `host/desktop-adapters.ts`（注册与 Fake/`KANBAN_DISABLE_*` 开关）+ `apps/desktop/electron/main/command-catalog.ts` + `cli-status-service.ts` + `packages/cli-host/tests/e2e/` B 类件 + `docs/cli-compatibility-matrix.md`。
- **推翻范围外决策**：落地 PR 内删除对应 `.out-of-scope/` 条目，并在 `docs/adr/` 记录反转理由（账本与现实同进退；条目语义见 `.out-of-scope/README.md`）。
- **新增日志字段/枚举**：`packages/ipc-schema/src/log.ts` 单源定义，主进程与 renderer 一律导入，禁止各自定义同名枚举。
- **搬测试文件**：改相对导入 + 扩 tsconfig/vitest include；双 e2e 目录别混（`apps/desktop/tests/e2e/` = vitest B 类，`apps/desktop/e2e/` = Playwright C 类）。
- **改 UI 文案/结构**：`docs/acceptance/` 归档截图与 e2e 定位器可能同步失效；e2e 断言的字符串字面量（`packaged-smoke.cjs` 等）改前先 grep。
- **真实测试模型**：`KANBAN_CODEX_MODEL=gpt-6-luna,gpt-5.6-luna` 由测试脚本/CI 默认注入，勿依赖"记得带"。

## 评审标准源（code-review 双轴）

`AGENTS.md` + `CODING_STANDARDS.md` + `docs/testing.md` + `docs/adr/0001`、`0002` + 用户全局代码规范节。机械性违规由门禁拦截，review 只判 Standards 的判断项与 Spec 的契约覆盖面。

## 开工前环境探测（POC / 真实 CLI 类任务）

见 `docs/testing.md`「环境探测清单」：先确认 CLI 版本、凭据有效性、基线版本再派单，凭据失效时标注"数据为合成"并上报，不静默降级。
