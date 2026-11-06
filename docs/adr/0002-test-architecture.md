# ADR 0002 — 测试体系架构：分层混合、pnpm -r 编排与最小层级

> 状态：已接受（依据 spec #23 三轮设计澄清 + 独立审查 10 项发现处置）· 日期：2026-11-06
> 调研依据：`docs/测试体系架构调整方案.md` 第 3 节「调研结论摘要」（12 个项目的测试组织对比表，不在此搬运）
> 关联：`docs/testing.md`（三执行类规范唯一权威出处）、spec issue #23、落地 issue #24/#25

## 背景

源码与测试混杂：真实进程门禁测试（需真实 CLI/PTY、分钟级、花 token）与密封测试同目录共置（cli-host 4 个 `*.e2e.test.ts`、desktop 主进程 1 个 `conpty.e2e.test.ts`），目录表达不出执行属性差异；且无通用测试规范，「新测试放哪、什么环境跑、默认跑不跑」没有机械可执行规则。原方案（`docs/测试体系架构调整方案.md`）完成了 12 项目调研并给出建议，其中根级 `vitest.workspace.ts` 聚合与 Playwright 放 `tests/e2e/` 两点经 spec #23 澄清后被否决（冲突处以 spec 为准）。

既有事实基础：desktop vitest 双 project（renderer=jsdom / node=node）已是环境分治的既有实现；cli-host 四件套的 `describe.skipIf` 已是门禁协议的既有实现。#24/#25 已完成 5 文件迁移（git mv 保历史）与 4 处 include 接线。

## 决策

**D1 — 采用分层混合，而非全分离或全共置。**

- **A 密封测试**：紧邻被测源码共置（`*.test.ts(x)`，vitest，默认跑）；
- **B 真实进程门禁测试**：所属包 `tests/e2e/`（`*.e2e.test.ts`，`KANBAN_E2E === "1"` 门禁，默认 skipped）；
- **C 整机 E2E**：仅 desktop `e2e/`（`*.spec.ts`，Playwright，独立命令 `test:e2e`）。

**D2 — 编排维持 `pnpm -r test` + 各包独立 vitest 配置，不引根级 vitest workspace。**

**D3 — 不预建 smoke / integration 测试目录层。** 现有三执行类装不下的测试出现时再议。

## 依据

### D1 分层混合

- 原方案第 3 节调研结论：全分离与全共置都不是最优解，VS Code / Electron / Next.js / Unfour 等 12 个成熟项目普遍按「轻量共置 + 重量集中」分层混合；
- 放置判据是**执行属性**（需要什么资源、不满足时能不能跑），不是语义标签：B 类分钟级/花 token/需门禁，A 类秒级/默认安全，目录必须让二者一眼可辨（US2）；A 类紧邻源码则改代码时测试就在旁边（US1）；
- 全共置的代价：真实进程测试混在 `src/` 里，默认安全与门禁属性无法从目录判断（迁移前的实际痛点）；全分离的代价：密封测试离开被测源码，浏览目录即知被测面的收益丢失。

### D2 pnpm -r 编排，不引根 workspace

- 各包自包含：`test` / `typecheck` 在包内各自闭环，跨包无共享配置；
- 按包运行需求已被 `pnpm --filter <pkg> test` 覆盖，单文件/单目录运行用 `pnpm --filter <pkg> exec vitest run <路径>` 覆盖；
- 根级 workspace 的唯一收益是单进程聚合跑 + 统一配置入口，本仓 4 包规模无感；引入它需要把各包配置上搬或抽共享文件，增加耦合，违背各包自包含；
- 原方案 §4.1 曾推荐根级 `vitest.workspace.ts`，经 spec #23 澄清否决（若未来包数量级增长或需要跨包聚合视图，重开决策）。

### D3 不预建 smoke / integration 层

- YAGNI：smoke / integration 是语义标签而非执行属性，执行类（A/B/C）才是放置判据；假设性未来测试（ipc-roundtrip、task-persistence 等）出现且三类装不下时再议；
- 整机启动冒烟已由 C 类 Playwright（`test:e2e`）承担；`apps/desktop/scripts/` 下的手动 smoke 脚本是运维脚本而非测试层（见 `docs/testing.md` 归属声明）；
- 预建空层会诱导「为填层而造层」的测试放置，与「放置判据 = 资源需求」冲突。

## 后果

- 目录即契约：`.test.ts(x)` = vitest 密封、`.e2e.test.ts` = vitest 门禁、`.spec.ts` = Playwright，后缀即 runner（US3）；
- `pnpm test` 默认只跑密封测试且门禁测试显示 skipped：默认验证零成本、门禁测试不失去存在感（US4）；
- B 类门禁语义统一为 `KANBAN_E2E === "1"`，一条命令口径覆盖（US5）；
- 新增 B 类零配置：include 已通配 `tests/**`，落对位置写对导入即被 test / typecheck / lint 全覆盖（US6/US7）；
- B 类只落 cli-host 与 desktop（ipc-schema 零 Node 依赖不承接）、无根级 tests/、`poc/` 出界（workspace + oxlint 双重排除）——边界条款由 `docs/testing.md` 承载；
- 挑战任一决策时：先读 `docs/testing.md` 现行口径与本 ADR 依据，再连同原方案第 3 节调研表一起评估。
