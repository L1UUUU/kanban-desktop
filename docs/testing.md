# 测试规范（docs/testing.md）

> 面向人 + agent 的通用测试规范。三执行类术语以本文为唯一权威出处；架构决策依据见 `docs/adr/0002-test-architecture.md`；spec 见 issue #23。
> 本文描述的是 #24/#25 迁移与接线完成后的最终状态，命令矩阵与仓库实际 script 定义逐条一致。

## 三执行类模型

判定属性只有一个：**测试需要什么资源、不满足时能不能跑**。

| 执行类 | 名称 | 判定条件 | 代价 |
|---|---|---|---|
| **A** | 密封测试 | 不需要真实外部进程，也不需要完整 Electron 应用（mock / 纯逻辑 / jsdom 组件） | 秒级，默认跑 |
| **B** | 真实进程门禁测试 | 需要真实外部进程（真实 CLI 会话 / 真实 PTY） | 分钟级，可能花 token，门禁默认关 |
| **C** | 整机 E2E | 需要完整 Electron 应用（构建产物 + 真窗口 + 真 UI） | 分钟级，独立命令显式触发 |

### 判定流程

```text
新测试需要什么资源？
        │
        ├─ 完整 Electron 应用（真窗口 / 真 UI / 构建产物）──→ C 类
        │     apps/desktop/e2e/*.spec.ts（Playwright，命令 test:e2e）
        │
        ├─ 真实外部进程（真实 CLI / 真实 PTY）──→ B 类
        │     所属包 tests/e2e/*.e2e.test.ts（KANBAN_E2E === "1" 门禁）
        │
        └─ 都不需要（密封）──→ A 类
              紧邻被测源码 *.test.ts(x)（默认跑）
```

先判 C 再判 B：需要完整应用的必是 C，哪怕它同时拉起真实 CLI；只差真实进程、不需要窗口的才是 B。

## 目录 / 命名 / 环境映射

**后缀即 runner**：`.test.ts(x)` = vitest；`.spec.ts` = Playwright；`.e2e.test.ts` = vitest 里的 B 类门禁测试。不需要打开文件确认执行器。

| 位置 | 后缀 | runner / vitest project | 环境 | 现有内容 |
|---|---|---|---|---|
| 各包 `src/**`（紧邻被测源码） | `*.test.ts` / `*.test.tsx` | vitest | 见下行环境映射 | A 类密封测试 |
| `packages/cli-host/tests/e2e/` | `*.e2e.test.ts` | vitest（单 project） | node | claude / codex / opencode / lifecycle 四件套 + run-once-claude / run-once-job |
| `apps/desktop/tests/`（根） | `*.test.ts` | vitest node project | node | memory-ipc.test.ts（IPC 集成，默认跑）+ memory-fixture.ts（共享装配，非测试文件） |
| `apps/desktop/tests/e2e/` | `*.e2e.test.ts` | vitest node project | node | conpty.e2e.test.ts + memory.e2e.test.ts |
| `apps/desktop/e2e/` | `*.spec.ts` | Playwright | Electron 构建产物（out/） | 20 个整机 spec（#65 会话生命周期验收起含 stage5 截图与全流程两组） |

环境映射靠目录不靠文件内声明：

| 目录 | vitest 配置 | 环境 |
|---|---|---|
| `apps/desktop/src/**` | desktop vitest `renderer` project | jsdom |
| `apps/desktop/electron/**`、`apps/desktop/tests/**` | desktop vitest `node` project | node |
| `packages/cli-host/src/**`、`packages/cli-host/tests/**` | cli-host vitest | node |
| `packages/ipc-schema/src/**` | ipc-schema vitest | node |
| `packages/tracker/src/**` | tracker vitest | node |

Playwright（`apps/desktop/playwright.config.ts`）：testDir `./e2e`，workers 1，串行（`fullyParallel: false`），timeout 60s，目标为 electron-vite 构建产物，无浏览器工程。

## 门禁协议（环境变量表）

主开关只有一个；附属开关分列如实记录，语义互不合并。

| 变量 | 作用位置 | 语义 | 性质 |
|---|---|---|---|
| `KANBAN_E2E` | 全部 8 个 B 类文件（cli-host：四件套 + run-once-claude/run-once-job；desktop：conpty + memory） | `=== "1"` 才跑；否则 `describe.skipIf` 整套显示 skipped | **B 类主开关** |
| `KANBAN_PROTOCOL_PROBE` | `packages/cli-host/tests/e2e/codex-adapter.e2e.test.ts` 内「协议探针」套 | `!== "1"` 时该子套 skip；叠加在 `KANBAN_E2E` 之上的第二道细粒度开关 | 附属（细粒度） |
| `KANBAN_SESSION_PROBE` | `packages/cli-host/tests/e2e/session-clue-probe.e2e.test.ts`（会话线索探针，issue #48） | `!== "1"` 时整套 skip；叠加在 `KANBAN_E2E` 之上的第二道细粒度开关（真实驱动三 CLI 采集工具事件样本，一次性取证性质，避免随 B 类例行重跑花 token；结论见 `docs/acceptance/stage4/session-clue-probe.md`） | 附属（细粒度） |
| `KANBAN_REAL_E2E` | `apps/desktop/e2e/kanban-real.spec.ts`、`apps/desktop/e2e/memory-real.spec.ts` | `=== "1"` 才跑真实最小集（需本机 CLI 已装已认证） | C 类门禁 |
| `KANBAN_DISABLE_CLAUDE` | 8 个演示型 Playwright spec（fake-chat、kanban、lifecycle、pty、projects、memory、acceptance-screenshots、kanban-acceptance-screenshots） | `"1"` 时禁用真实 claude，回落 Fake 演示模式 | launch env（非 skip 门禁） |
| `KANBAN_DISABLE_OPENCODE` | 同上 | `"1"` 时禁用真实 opencode，回落 Fake 演示模式 | launch env（非 skip 门禁） |
| `KANBAN_FAKE_RESUME_DELAY_MS` | `apps/desktop/e2e/resume-banner.spec.ts`、`apps/desktop/e2e/stage4-acceptance-screenshots.spec.ts` | Fake resume 延迟毫秒数（整机 Playwright 观察「恢复中」态）；经 `packages/cli-host/src/host/desktop-adapters.ts` 消费，env 逐级继承到 utilityProcess worker | launch env（非 skip 门禁） |
| `KANBAN_FAKE_RESUME_FAIL_FIRST` | `apps/desktop/e2e/resume-banner.spec.ts`、`apps/desktop/e2e/stage4-acceptance-screenshots.spec.ts` | Fake 前 N 次 resume 注入失败（驱动恢复失败态与重试流转）；消费位置同上 | launch env（非 skip 门禁） |
| `KANBAN_FAKE_CREATE_FAIL_FIRST` | `apps/desktop/e2e/error-cards.spec.ts`、`apps/desktop/e2e/stage4-acceptance-screenshots.spec.ts` | Fake 前 N 次创建抛 E_SPAWN_NOT_FOUND（驱动侧栏 spawn 失败卡与「重试创建」收敛）；消费位置同上 | launch env（非 skip 门禁） |
| `KANBAN_TEST_RESIDUE_JSON` | `apps/desktop/e2e/residue.spec.ts`（残留通知条演示流程） | 指向残留清单 JSON（逐条过 `residueProcessSchema` 校验）：Main 检测直接返回种子、`residue:kill` 不真实终止统一回报 killed；另 `KANBAN_USER_DATA` 隔离环境下无种子时跳过机器级残留枚举（整机 e2e 密封性，见 `docs/acceptance/stage4/residue-known-limits.md`） | launch env（非 skip 门禁） |
| `KANBAN_TEST_CLI_STATUS_JSON` | `apps/desktop/e2e/cli-status.spec.ts`（#80 菜单禁用态流程）；Main 侧 `electron/main/cli-status-service.ts` | 指向 `{codex,claude,opencode}` 布尔种子 JSON：`cli:status` 探测直接按种子应答且每次重读（改写文件即探测翻转，驱动「装完重开菜单恢复」整机用例）；无种子走真实 exe 解析链（`KANBAN_DISABLE_*` 回落 Fake 时菜单不灰置） | launch env（非 skip 门禁） |
| `KANBAN_E2E_DEBUG` | cli-host 四件套内的调试日志 | 非空时向 stderr 输出调试日志 | 调试开关（非门禁） |
| `KANBAN_CODEX_MODEL` | cli-host codex 模型解析链（`packages/cli-host/src/codex/model-probe.ts`） | 逗号分隔模型白名单，按序真实试探，首个可用即用；全败报错**不回退**（跳过磁盘缓存/rollout/model/list；命中不落盘缓存） | 成本开关（非门禁） |
| `KANBAN_UPDATE_SCREENSHOTS` | `apps/desktop/e2e/helpers/acceptance-artifacts.ts`（8 个验收 spec 的截图与 real-evidence 制品） | `=== "1"` 才把截图/JSON/TXT 写回 `docs/acceptance/`；默认写 `test-results/acceptance/`（.gitignore 已忽略），避免每次跑 e2e 污染共享工作树；提交归档时另需 `KANBAN_ALLOW_ARCHIVE_PNG=1` 过 `check:gates` | 制品写入开关（非门禁） |
| `KANBAN_ALLOW_ARCHIVE_PNG` | `scripts/check-gates.mjs` | `=== "1"` 才允许本次提交带入 `docs/acceptance/*.png` 变更 | 提交门禁逃生口 |

注意 `KANBAN_E2E` 是严格等于 `"1"`：`KANBAN_E2E=0` 或任意其它非空值**不会**触发 B 类（杜绝非空值误触真实 PTY/CLI 测试）。

命令中的环境变量写法以 bash 形式为准（`KANBAN_E2E=1 pnpm ...`）；PowerShell 等价写法：`$env:KANBAN_E2E="1"; pnpm ...`。

**真实测试模型成本约束**：任何会真实调用 codex 模型的测试（B 类 codex 相关、C 类 `kanban-real` / `memory-real` 真实集）**必须**设 `KANBAN_CODEX_MODEL=gpt-6-luna,gpt-5.6-luna`（优先 gpt-6-luna，回退 gpt-5.6-luna）。不设时解析链沿用「磁盘缓存 → 最近 rollout」，会跟着日常交互最后用的模型走（如 sol/terra），造成成本浪费。该变量经 Playwright → Electron → utilityProcess worker 逐级继承 env 生效；会话内显式选定的模型仍最优先；白名单全败直接报错而非回退，宁可测试失败也不烧昂贵模型。

## 命令矩阵（根 / 包 / desktop 三级）

命令均与 package.json script 定义一致。**双 e2e 目录消歧**：`pnpm test:e2e` 是 Playwright（C 类）；`KANBAN_E2E=1 vitest run tests/e2e` 是 vitest B 类——两者目录、runner、开关完全不同。

| 级别 | 命令 | 实际展开 | 跑什么 |
|---|---|---|---|
| 根 | `pnpm test` | `pnpm -r test` | 5 包 vitest 全量：A 类执行，B 类显示 skipped |
| 根 | `pnpm test:e2e` | `pnpm --filter @kanban/desktop test:e2e` | **C 类**：Playwright 20 spec（先 electron-vite build 再 playwright test） |
| 根 | `pnpm typecheck` | `pnpm -r typecheck` | 各包 `tsc --noEmit`（含 tests/ 目录） |
| 根 | `pnpm lint` | `oxlint apps packages` | oxlint（范围含新 tests/ 目录） |
| 包（cli-host） | `pnpm --filter @kanban/cli-host test` | 包内 `vitest run` | cli-host A 类 + B 类 skipped |
| 包（cli-host） | `KANBAN_E2E=1 pnpm --filter @kanban/cli-host exec vitest run tests/e2e` | vitest run tests/e2e | **B 类**：三 CLI 真实集成 + run-once（claude headless 冒烟 / Job Object 覆盖；花 token，可选细粒度 `KANBAN_PROTOCOL_PROBE=1`） |
| desktop | `pnpm --filter @kanban/desktop test` | 包内 `vitest run` | renderer（jsdom）+ node 双 project；B 类 skipped |
| desktop | `pnpm --filter @kanban/desktop test:e2e` | `electron-vite build && playwright test` | **C 类**：整机 Playwright |
| desktop | `KANBAN_E2E=1 pnpm --filter @kanban/desktop exec vitest run tests/e2e` | vitest run tests/e2e | **B 类**：conpty 真实 ConPTY 冒烟（零 token）+ memory 真实 claude headless 提取（花 token；claude exe 不可解析时跳过） |

双 e2e 目录对照（`apps/desktop` 下两个 e2e 目录，不要混淆）：

| 目录 | runner | 执行类 | 触发命令 |
|---|---|---|---|
| `apps/desktop/tests/e2e/` | vitest（node project） | B | `KANBAN_E2E=1 pnpm --filter @kanban/desktop exec vitest run tests/e2e` |
| `apps/desktop/e2e/` | Playwright | C | `pnpm test:e2e`（根）或 `pnpm --filter @kanban/desktop test:e2e` |

默认安全：`pnpm test` 只跑密封测试、同时把门禁测试显示为 skipped（默认验证零成本且门禁测试不失去存在感）。

## 放置归属边界

- **B 类只落 cli-host 与 desktop**：这两包有真实进程被测面（CLI adapter / ConPTY），且 vitest + tsconfig include 已通配 `tests/**`。
- **ipc-schema 不承接 B 类**：定位为零 Node 依赖的纯 schema 包，vitest include 仅 `src/**/*.test.ts`；若未来确有 B 类需求，先改该包 include 再落文件，不要静默放置。tracker 同理（当前无 B 类，include 仅 `src/**`）。
- **测试归属跟随被测代码所在包**；**无根级 tests/**——不建根级大杂烩测试目录。
- `adapter.contract.ts` 留在 `packages/cli-host/src/`：它是 A 类共置测试设施（被 `fake-adapter.test.ts` 等直接导入），B 类从 `tests/e2e/` 以 `../../src/adapter.contract` 引用。

## 新增 B 类接线清单（零配置）

include 均已通配（`packages/cli-host/vitest.config.ts`、`apps/desktop/vitest.config.ts` node project 含 `tests/**/*.test.ts`；两处 tsconfig 含 `tests/**/*.ts`），落对位置写对导入即可，不需要改任何配置：

1. 文件放所属包 `tests/e2e/`（cli-host → `packages/cli-host/tests/e2e/`，desktop → `apps/desktop/tests/e2e/`）；
2. 命名 `*.e2e.test.ts`；
3. 文件头门禁：`const E2E = process.env.KANBAN_E2E === "1";` + `describe.skipIf(!E2E)("套名", ...)`；
4. 导入走包内相对路径：cli-host 侧 `../../src/...`，desktop 侧 `../../electron/main/...`（现有 8 个文件均为此形态；memory.e2e 经同包 `../memory-fixture` 共享装配间接引用，fixture 内即此形态）；
5. 完成后 `pnpm test` 应看到该文件以 skipped 列出（验证被 include 收到）。

## poc/ 出界声明

`poc/` 是 T0 系列 PoC 的**归档验证材料**，不属于测试体系。双重排除已落地：

- `pnpm-workspace.yaml` 的 packages 仅 `apps/*` + `packages/*`（poc/ 不在 workspace 内）；
- `.oxlintrc.json` 的 ignorePatterns 含 `poc/**`（lint 不扫）。

## `apps/desktop/scripts/` 手动 smoke 脚本归属

`apps/desktop/scripts/` 下的 4 个 `.cjs`（`smoke-node-sqlite.cjs`、`packaged-smoke.cjs`、`offline-electron-dist.cjs`、`registry-fallback-proxy.cjs`）是**运维脚本**：由 package.json script（如 `pnpm --filter @kanban/desktop smoke:sqlite`）或手动调用，用于特定环境的人工核验，**不入测试目录体系、不参与 pnpm test**。这与「不预建 smoke 测试层」（ADR 0002 D3）不冲突——前者是运维工具，后者是测试层级。

## 验收门禁命令（pre-commit / CI 强制）

`.githooks/pre-commit` 与 `.github/workflows/checks.yml` 依次执行：`pnpm check:gates` → `pnpm lint:strict` → `pnpm typecheck` → `pnpm test`。`lint:strict` 是 `oxlint --deny-warnings`（warning 级违规如孤儿 import 也会让门禁失败）；`pnpm lint` 保留宽松语义仅供本地快速查看。`check:gates` 校验 B 类后缀门控、`workspacePackages` 与 workspace 包一致、归档 PNG 不被意外提交。CI 与本地跑同一套命令，不另立一套。

## flaky 台账

发现 flaky **即登记**，不得只重跑到绿（全局 AGENTS.md §3）。台账按用例记录：复现率、根因、修复 commit、当前状态。已知历史记录：

| 用例 | 根因 | 处置 |
|---|---|---|
| desktop node project 多 worktree 并行负载下 5s 超时假红 | 机器负载 / 临时目录清理竞态（ENOTEMPTY/EPERM） | 超时阈值 5s→20s、清理重试兜底（bae1b3d） |
| hover→「＋」点击竞态、single-instance OS 焦点断言、worker 外杀后 `app.close()` 固定 5s 白等 | 断言与 UI/OS 状态耦合 | 事件驱动 + 最小化还原断言（b6064b3 / 47555da） |
| `app.close()` 超时但断言全部通过 | teardown 挂死（Electron utilityProcess 平台限制） | 应用侧 dispose 3s 超时 + kill 兜底；产品代码未动 |

新发现时追加一行并注明复现条件；连续全绿才标记「已收敛」，仍要保留根因记录。

## 环境探测清单（POC / 真实 CLI 类任务开工前）

先探测再派单，避免凭据/版本滞后导致整波补跑或 spec 漂移：

1. **CLI 版本**：`claude --version` / `codex --version` / `opencode --version`，记入 spec 的 Environment 节（带复查触发条件）。
2. **凭据有效性**：OpenAI oauth / provider 配置是否过期；失效时上报用户并明确标注"数据为合成"，不静默降级。
3. **基线版本**：Electron / node / pnpm 版本与 EOL 状态；pnpm 10 需声明 `onlyBuiltDependencies`。
4. **模型白名单**：真实 codex 测试由测试脚本/CI 默认注入 `KANBAN_CODEX_MODEL=gpt-6-luna,gpt-5.6-luna`，不依赖「记得带」。
