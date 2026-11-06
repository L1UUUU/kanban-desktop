# 阶段 2 验收报告（S2-07 / issue #22）

> 日期：2026-11-06 · 验收人：acceptance subagent（issue #22）· 规范依据：spec issue #15（Testing Decisions 全部 7 条 + H 节验证要求）+ 工单 #22 五条验收标准
> 环境：Windows 11（10.0.26200）· Node v24.13.0 · pnpm 10.32.1 · Electron 44.10.2 · 基线 93a3a1e（#16–#21 全部合并）· 三 CLI 真实可用（claude 2.1.317 / codex 0.144.1 / opencode 1.19.5）

## 0. 结论一览

| # | 验收标准 | 结论 |
|---|---|---|
| 1 | Playwright E2E 全流程绿（含重启后再水化一致） | **PASS**（21/21；含 #22 新增单条连续全流程串测 + stage2 截图编排；重启一致覆盖三路径） |
| 2 | 真实最小集：Claude hook verified 建卡端到端留证；uncertain→确认→转正路径留证 | **PASS**（真实全链 1.3m 一次通过：4 截图 + hook 捕获 JSONL + CLI 版本，见 §2） |
| 3 | 原型 7 条必须一致项逐条截图对照归档 | **PASS**（7/7 逐条，11 张状态截图 + S2-18 空板补充，见 §3） |
| 4 | 关键交互实测记录（建卡/关联/解除/修正/确认/删除/卡片建会话/同名提示/视图切换） | **PASS**（9 类交互逐条操作路径 + 断言结果，见 §4） |
| 5 | spec #15 S2-01…S2-18 逐条核对并标注达成情况 | **PASS**（18/18 达成，逐条证据指向，见 §5） |

阶段 2 收口结论：**五条验收标准全部 PASS**。验收过程中未发现产品缺陷；新增用例编写过程中确认的既有交互语义（详情面板透明遮罩）如实记录于 §8。

---

## 1. Playwright 全流程 E2E（AC-1）

形态：`electron-vite build` 产物 + Fake 链路（`KANBAN_DISABLE_CLAUDE/OPENCODE=1` → 真实 CLI 回落 FakeAdapter，与阶段 1 相同的验收形态）；命令 `pnpm test:e2e`（workers=1、fullyParallel=false）。

### 1.1 #22 新增：单条连续全流程用例

`apps/desktop/e2e/kanban.spec.ts`「全流程串测（#22 验收）」——一条用例串完全部环节，每步带断言：

| 步 | 环节 | 断言要点 |
|---|---|---|
| ① | 侧栏「看板」入口 → 五列看板 | 入口含当前项目名；五列 testid 全在场 |
| ② | 手动建卡 | 未开始列「＋」→「待命名需求」出现；详情行内编辑改名 |
| ③ | 关联 = 卡片建会话 | 详情「＋新建会话」OpenCode → 创建即自动关联（◍ 1 会话、侧栏 REQ-001 徽标） |
| ④ | 阶段修正 | 五段条 Design → 卡片移列 + 依据「手动修正」 |
| ⑤ | uncertain | 切聊天选 OpenCode 发 `/implement-spec`（Fake self_reported）→ Implement 列 + 待确认徽标 |
| ⑥ | 手动确认 | 「确认当前阶段」→ 徽标清除、阶段保持 Implement |
| ⑦ | 删除 | 二次确认弹层文案三要素 → 确认后卡片实时消失 |
| ⑧ | 重启再水化一致 | 墓碑不复活（0 卡）；OpenCode 会话本身保留；REQ 徽标随关联清除 |

与既有分票用例的关系：整合引用、不重复建设——实时出现/面板往返/关联往返/再水化四类用例（#18/#19/#20 各票）继续保留，本用例补齐「单旅程连续覆盖」缺口（既有用例无一条同时含手动建卡→卡片建会话→修正→确认→删除→重启）。

### 1.2 重启再水化一致覆盖（三路径）

| 路径 | 用例 |
|---|---|
| verified 自动卡重启一致 | kanban.spec「重启再水化」（#18）：Design 列卡/会话数/verified 徽标/列计数逐项一致 |
| 人工标题重启不回退 | kanban.spec「详情面板全套操作往返」（#19）：rename 走事件流，重启后仍为人工标题 |
| 墓碑不复活 + 会话保留 | kanban.spec「全流程串测」（#22）⑧ 与「详情面板全套操作往返」末段 |

---

## 2. 真实最小集（AC-2，env-gated）

编排：`apps/desktop/e2e/kanban-real.spec.ts`（`KANBAN_REAL_E2E=1` 才执行，默认 skip，不进常规回归）。运行命令：

```bash
KANBAN_REAL_E2E=1 pnpm --filter @kanban/desktop exec playwright test kanban-real
```

隔离：独立 userData + 隔离项目目录（预置探针 `.claude/skills/design-feature`、`.claude/skills/implement-spec`、`.opencode/command/implement-spec.md`），不打 `KANBAN_DISABLE_*`（Claude/OpenCode 走真实 Adapter），真实会话数据全部留在隔离目录，不触碰用户真实项目。

### 2.1 链路 A：Claude verified `design-feature` 自动建卡（hook 链路端到端）

真实链路：UI 发送提示 → 真实 Claude 会话 Skill 工具真调用 `design-feature` → 会话级 `--settings` 注入的 PreToolUse(Skill) hook 捕获落 JSONL → `transformHookEvents` 产 verified 归一化事件 → Main 按 sessions 表注入 projectId → tracker 自动建卡（Design 阶段 + 关联该会话 + 归属本项目）→ tracker 变更推送 → 看板卡片实时出现。

断言（全部通过）：Design 列「待命名需求」可见、`◍ 1 会话`、verified 绿徽标、卡片依据行 `design-feature · Claude`。

### 2.2 链路 B：self_reported → uncertain → 手动确认 → verified 转正

| 步 | 操作 | 结果（断言通过） |
|---|---|---|
| B1 | 详情「＋新建会话」选 OpenCode（真实 server 拉起；session:create+requirementId 原子关联） | 关联列表出现 OpenCode 行；卡片 `◍ 2 会话` |
| B2 | OpenCode 会话发送 `/implement-spec`（/command 路由命中探针 command，真实 command API 执行） | 卡片移 Implement 列 + 「待确认」黄徽标（self_reported 驱动） |
| B3 | 详情面板「确认当前阶段」 | 徽标清除、阶段保持 Implement |
| B4 | 切回 Claude 会话 Skill 真调用 `implement-spec`（更新发生的 verified） | 仍 Implement；uncertain 保持 false；verified 绿徽标回归；详情当前依据 `implement-spec · Claude · verified · …` |

### 2.3 留证清单（`docs/acceptance/stage2/real-evidence/`）

| 文件 | 内容 |
|---|---|
| `cli-versions.txt` | claude 2.1.317 (Claude Code) / codex-cli 0.144.1 / opencode 1.19.5（2026-11-06T06:30:58Z 采集） |
| `hook-events-s-1f2b2c0d.jsonl` | 真实 Claude 会话 hook 捕获原始日志 4 行：PreToolUse(Skill) `design-feature` 06:31:14Z → PostToolUse 06:31:16Z → PreToolUse(Skill) `implement-spec` 06:32:04Z → PostToolUse 06:32:06Z（verified 信号的原始来源；transcript 路径指向隔离项目目录） |
| `real-01-claude-verified-card.png` | 链路 A 终态：Design 列自动卡（verified 徽标 + 依据行 + 1 会话） |
| `real-02-self-reported-uncertain.png` | 链路 B2：Implement 列 + 待确认徽标 |
| `real-03-manual-confirmed.png` | 链路 B3：手动确认后徽标清除、阶段保持 |
| `real-04-verified-promoted.png` | 链路 B4：verified 转正（依据 `implement-spec · Claude · verified`、无待确认） |

hook 捕获时间线与卡片状态截图一一对应（06:31:14 design-feature verified 建卡 → 06:31:31 B2 截图前 self_reported → 06:32:04 verified implement-spec 转正 → 06:32:xx B4 截图），构成完整证据闭环。

---

## 3. 原型 7 条必须一致项对照（AC-3）

原型：`docs/prototypes/stage2-kanban.prototype.html`（用户已确认）。截图编排：`apps/desktop/e2e/kanban-acceptance-screenshots.spec.ts`（Fake 链路注入目标状态，断言可见后才截图，可重复重跑刷新），产物存 `docs/acceptance/stage2/screenshots/`。

| # | 必须一致项 | 结论 | 截图 | 补充证据 |
|---|---|---|---|---|
| 1 | 侧栏底部「看板」入口按钮（带当前项目上下文指示） | 一致 | 01-kanban-entry-sidebar | kanban.spec 入口断言（含项目名）；无项目时显示「当前项目」（S2-18 截图 11 内） |
| 2 | 看板五列：未开始（列头「＋」手动建卡）/ Design / Implement / PR / Retro，按当前项目过滤 | 一致 | 02-board-five-columns | 组件测试「两项目各一张卡：看板只显示当前项目的需求」 |
| 3 | 卡片信息：标题、关联会话数、阶段依据行（skill · CLI · 日期）、uncertain「待确认」黄徽标、verified 绿徽标 | 一致 | 03-card-verified-design / 04-card-uncertain-implement | 03 含 verified 徽标 + 依据行 `design-feature · Claude`；04 含待确认徽标 |
| 4 | 详情右侧滑出面板：标题行内编辑、uncertain 提示条 +「确认当前阶段」、五段阶段修正条（含当前依据：skill · CLI · 证据等级 · 时间）、关联会话列表（状态徽标 + 跳转 + 解除）、＋新建会话四 CLI 菜单（PTY 标注「无 skill 信号」）、关联已有会话选择器（仅当前项目未关联会话）、删除需求按钮 | 一致 | 05-detail-panel / 06-detail-new-session-menu / 07-detail-uncertain-confirm | 截图用例逐元素断言：标题输入框值、五段条 testid、当前依据文本、会话行「空闲」状态徽标 + 跳转/解除钮、四 CLI 菜单项 + PTY 标注、link-existing-select、删除钮 |
| 5 | 删除二次确认弹层，明示「仅删除需求卡片与全部会话关联；会话本身、聊天历史与事件日志保留；不可撤销」 | 一致 | 08-delete-confirm-dialog | 三要素文案逐串断言；确认后卡片实时消失 |
| 6 | 会话行需求徽标（REQ-id，点击跳看板） | 一致 | 09-sidebar-req-badge | 两会话（Claude/OpenCode）均挂 REQ-001；跳转两方向见 kanban.spec「关联管理往返」 |
| 7 | Claude 同名 skill 非阻塞提示条（warn 样式、内容含冲突名与「项目级优先生效」说明、可关闭） | 一致 | 10-skill-conflict-banner | Fake 会话 + 真实检测（fixture 项目级 `.claude/skills/design-feature` ∩ 隔离 `CLAUDE_CONFIG_DIR` 用户级同名）→ 提示条出现含 `design-feature` 与「项目级将优先生效」；「知道了」可关闭 |

补充证据（非 7 条必选）：11-board-empty-guide.png——无项目上下文空板 + 引导文案「选择或注册项目后查看其需求」（S2-18）。

可调整范围（颜色/间距/图标/字体/组件树/面板与列宽）未逐项比对，暗色主题基调保留（各截图可见）。

---

## 4. 关键交互实测记录（AC-4）

九类交互全部实测；操作路径 = 编排用例内步骤（可重复执行），断言随截图/用例进行：

| 交互 | 操作路径 | 结果 |
|---|---|---|
| 建卡（自动） | 聊天发送 `/design-feature verified …`（Fake 以 claude-code 口径发 verified）→ 进看板 | Design 列「待命名需求」实时出现（tracker:event 推送，无手动刷新）；真实链路见 §2.1 |
| 建卡（手动） | 看板 → 未开始列头「＋」 | 卡片入未开始列（归属当前项目）；详情改名实时落卡（kanban.spec 全流程 ②） |
| 关联 | 详情「＋新建会话」选 OpenCode（自动关联）或 `link-existing-select` 选择未关联会话 | 会话数 +1、侧栏 REQ 徽标出现；选择器仅列当前项目未关联会话（已关联排除）（kanban.spec 关联往返/全流程 ③） |
| 解除 | 详情关联行「解除」 | 会话数即时 -1、徽标消失、阶段保持不回退（kanban.spec 关联管理往返 135-139 行断言） |
| 修正 | 详情五段阶段修正条点击目标段（含「未开始」） | 卡片即时移列、当前段高亮、依据显示「手动修正」；可再改、后续有效事件可覆盖（全流程 ④ + #19 面板用例） |
| 确认 | uncertain 卡详情「确认当前阶段」 | 待确认徽标与提示条清除、阶段保持（全流程 ⑥ + 真实 B3） |
| 删除 | 详情「删除需求」→ 弹层「确认删除」 | 卡片实时消失、面板关闭；取消路径保留卡片；重启不复活（全流程 ⑦⑧） |
| 卡片建会话 | 详情「＋新建会话」→ 四 CLI 菜单（PTY 项标注「无 skill 信号」）→ 选择 | 同项目会话创建即自动关联（session:create+requirementId 原子落）（关联往返 + 真实 B1） |
| 同名提示 | 项目级/用户级同名 skill fixture 下创建 Claude 会话 | 会话顶部 warn 提示条（冲突名 + 项目级优先生效 + 行为不稳定说明）；「知道了」关闭后会话正常使用（截图 10 流程 + ChatWorkspace 组件 4 用例） |
| 视图切换 | 侧栏「看板」入口反复点击 | 聊天/看板自由切换；CLI 不停止（流式中切看板再回，会话后台完成全文在——组件「视图切换不停止 CLI」+ kanban.spec 切回聊天会话仍在） |

---

## 5. spec #15 S2-01…S2-18 逐条核对（AC-5）

| 用户故事 | 达成 | 证据指向 |
|---|---|---|
| S2-01 自动建卡 | 达成 | tracker 单测：首次 verified design-feature 建卡+Design+关联 / 同 eventId 重放幂等 / 重复与重放不重复建卡；e2e 实时出现用例；真实链路 A（§2.1） |
| S2-02 手动关联与解除 | 达成 | tracker：已关联他卡 link 拒绝 / link 按实际发生时间同步（晚于依据推进、早于不覆盖、无依据初始化）；组件：解除不回退阶段；e2e 关联管理往返 |
| S2-03 阶段驱动 | 达成 | tracker：乱序/延迟不覆盖（stale_event_ignored）、PR→Implement 回退、多 session 最新有效事件胜出；组件：活动状态只在会话行徽标、卡片不显示 |
| S2-04 uncertain 标注与转正 | 达成 | tracker：self_reported 驱动标 uncertain / manual 确认转正 / 更新发生 verified 清除 uncertain / 迟到 verified 不覆盖已确认 / 不可排序保留+uncertain；e2e 面板往返 + 全流程 ⑤⑥；真实链路 B（§2.2） |
| S2-05 手动修正 | 达成 | tracker：manual 立即生效、之后有效事件可覆盖、旧事件不可；组件五段条各档；e2e 全流程 ④（含回「未开始」往返） |
| S2-06 看板分列与标题 | 达成 | columns 单测（列序/映射/依据行格式）；组件+e2e 五列渲染与列头计数；rename 事件流重启不回退（tracker 投影一致 + e2e 重启用例） |
| S2-07 多会话并行 | 达成 | e2e 关联管理往返（卡下 Claude+OpenCode 并行）；Spec/Tickets 手动提供、新会话不继承聊天上下文 = 各 CLI 原生会话语义（阶段 1 契约套，每会话独立原生 session） |
| S2-08 需求归属项目 | 达成 | tracker：projectId 入态 / 自动建卡写 projectId / 跨项目 link 拒绝（link_project_mismatch）；组件：看板只显示当前项目需求、切项目即换卡；迁移测试 v1→v2 回填 |
| S2-09 手动建卡 | 达成 | tracker create 事件（确定性 id / nextId 推进 / id 冲突幂等）；e2e 未开始列「＋」建卡（全流程 ②） |
| S2-10 删除需求 | 达成 | tracker 墓碑矩阵（移除+解除关联 / 同 eventId 不复活 / 再 verified 建新卡 / stage_events 保留）；e2e 删除弹层+取消+确认+重启不复活；会话本身保留断言（全流程 ⑧） |
| S2-11 从卡片创建会话 | 达成 | ipc 测试 session:create+requirementId 附带 link 落库；组件+e2e 四 CLI 菜单（PTY 标注）；真实 B1（真实 OpenCode server 拉起即关联） |
| S2-12 PTY 会话关联 | 达成 | schema 测试 link+pty 合法 / skill+pty 拒绝；tracker：pty 会话可关联不被信号驱动；组件：PTY 关联行 + 侧栏徽标 |
| S2-13 看板入口与视图切换 | 达成 | 组件：视图切换不停止 CLI；e2e 入口断言与全流程 ①（入口含当前项目指示）；截图 01 |
| S2-14 详情滑出面板 | 达成 | DetailPanel 组件套（开合/编辑/修正/确认/删除）；RelatedSessionsArea 组件套（列表/解除/关联已有/建会话/跳转/拒绝原因呈现）；截图 05/06/07 逐元素 |
| S2-15 会话行需求徽标 | 达成 | 组件+e2e：徽标 REQ-id、点击跳看板选中需求开详情；截图 09；sessionToReq 反查映射单测（kanban-store） |
| S2-16 Claude 同名 skill 提示 | 达成 | 纯函数单测（同名大小写不敏感/仅单侧/空目录/CLAUDE_CONFIG_DIR 基准）；ipc 测试（claude 附 skillConflicts、非 claude 不带）；ChatWorkspace 组件 4 用例（出现/文案/可关闭/不阻塞）；截图 10（真实检测触发） |
| S2-17 实时刷新与重启恢复 | 达成 | tracker 持久化往返（含 create/rename/delete 重放态=退出态）；kanban-store 推送成员单测；e2e 三条重启路径（§1.2）与实时出现断言 |
| S2-18 无项目会话边界 | 达成 | tracker：无项目 skill 不建卡（unprojected_no_card）/ 无项目 link 拒绝（link_unprojected_rejected）；组件+截图 11：空板引导文案 |

统计：**18/18 达成，无部分达成、无阻塞项**。

---

## 6. 回归套件数字（worktree s2-07 / 基线 93a3a1e + 本工单改动）

| 套件 | 命令 | 结果 |
|---|---|---|
| 构建 | `pnpm --filter @kanban/desktop build`（test:e2e 前置） | PASS（main 多入口 + preload + renderer） |
| Lint | `pnpm lint` | 0 warnings 0 errors（147 files） |
| Typecheck | `pnpm typecheck` | 4/4 包 PASS |
| 单测（无 env） | `pnpm -r test` | ipc-schema 70 + tracker 80 + cli-host 124（56 e2e-gated skip）+ desktop 192（2 skip）= **466 passed / 0 failed** |
| Playwright E2E | `pnpm test:e2e` | **21 passed + 1 skipped**（19 基线 + 全流程串测 + stage2 截图编排；skipped = kanban-real env-gated）。首轮全量出现 1 条既有用例瞬态失败（fake-chat「审批三键」hover「＋」超时），单独复跑 PASS、二次全量全绿——判定为高负载下环境敏感瞬态（与 #19 记录的 app.close 偶发超时同类），非代码缺陷，见 §8 |
| 真实最小集 | `KANBAN_REAL_E2E=1 … playwright test kanban-real` | **1 passed**（1.3m，证据 §2.3） |

对比阶段 1 基线（343 单测 / 15 e2e）：单测 +123（阶段 2 各票新增）、e2e +6（#18–#21 四票新增 4 + 本工单 2），既有用例无一回退。

## 7. stage1 截图刷新（随 UI 演进）

阶段 2 UI 演进（侧栏底部新增「看板」入口、会话行 REQ 徽标等）使阶段 1 归档快照与当前 UI 不一致。本工单 `pnpm test:e2e` 重跑 `acceptance-screenshots.spec.ts` 后 `docs/acceptance/stage1/screenshots/` 12 张 png 全部刷新（断言可见后才截图，与阶段 1 编排一致），归档快照恢复与当前 UI 一致。stage1 report.md 的截图编号与对照关系不变。

## 8. 偏离与未尽

| # | 项 | 说明 |
|---|---|---|
| 1 | 详情面板透明遮罩交互 | 全流程用例编写中发现：面板开启时点击看板卡片被透明遮罩（detail-backdrop）拦截——这是既有产品语义（点看板任意处关面板），非缺陷；测试侧显式 `detail-close` 后再操作 |
| 2 | self_reported 路径选 OpenCode | spec Testing 7 写「Codex 或 OpenCode」；Codex `skillSignal: false`（阶段 1 定局，无 skill 信号通道），故真实链路 B 选 OpenCode（/command 路由 self_reported） |
| 3 | 真实链路未覆盖删除/重启 | 真实最小集按 spec 只要求建卡与 uncertain→确认→转正两条链路；删除/重启一致由 Fake e2e + tracker 单测覆盖（§1.2/§5 S2-10/S2-17） |
| 4 | kanban-real.spec.ts 默认 skip | env-gated（依赖本机真实 CLI 认证与额度），常规 `pnpm test:e2e` 不受影响；复现命令见 §2 |
| 5 | 可调整范围项未逐项比对 | 原型可调整范围（颜色/间距/图标/字体/组件树/列宽）按 spec 不属可判定验收条款；暗色主题基调保留（截图可见） |
| 6 | e2e 瞬态失败复跑判定 | 首轮全量 `pnpm test:e2e` 中 fake-chat「审批三键」（既有用例，本工单未触碰）在 hover 项目行后等「＋」按钮 30s 超时；单独复跑 PASS（14.3s）、随后全量复跑全绿。判定为高负载下 hover 时序环境敏感瞬态（与 #19 记录的 e2e 环境敏感问题同类），不属代码回退，未改测试 |
