# 阶段 5 验收报告（S5-08 / issue #65）

> 日期：2026-11-11 · 验收人：acceptance subagent（issue #65）· 规范依据：spec issue #57（Further Notes「必须一致项」+ Testing C 类要求）+ 工单 #65 四条验收标准
> 环境：Windows 11（10.0.26200）· Node v24.22.2 · pnpm · Electron 44.10.2（electron-vite 构建产物）· 基线 d58bb4e（spec #57 七工单 #58–#64 全部合并）
> 验收驱动形态：Fake 驱动 Playwright 截图 spec `apps/desktop/e2e/stage5-acceptance-screenshots.spec.ts`（2 用例 / 8 张截图直写 `docs/acceptance/stage5/screenshots/`，断言随截图进行兼作交互实测记录）；全流程交互由 `apps/desktop/e2e/session-lifecycle.spec.ts`（6 用例）覆盖。
> 原型对照依据：`docs/prototypes/stage5-session-lifecycle.prototype.html`（四演示 tab，用户已确认）。

## 0. 结论一览

| # | 验收标准（issue #65） | 结论 |
|---|---|---|
| 1 | 全流程整机 spec 通过（含失败注入：创建失败/终端启动失败可重试） | **PASS**（`session-lifecycle.spec.ts` 6/6：草稿优先与单草稿双向替换、归档→设置分组→取消归档→恢复续聊、删除二次确认与激活切换（下一条/上一条/空态）、重启历史+配置持久化+启动扫描反馈、Fake 创建失败重试、终端启动失败回删无孤儿行+重试成功） |
| 2 | 原型对照截图归档，覆盖必须一致项 | **PASS**（8 张归档 `screenshots/`，必须一致项 6 组逐项判定见 §2，无不一致项；生成走 `KANBAN_UPDATE_SCREENSHOTS=1`，提交走 `KANBAN_ALLOW_ARCHIVE_PNG=1`） |
| 3 | 失效断言清单迁移完毕无残留 | **PASS**（三组清单 grep 复核：「点＋即出行」22 断言全部带 draft-hint 前置、「重启全恢复」11 处语义保留、「行数与形状」11 处 session-row 定位与形状断言全部随草稿语义迁移；packaged-smoke.cjs 两处已迁移并本地实跑验证，见 §3） |
| 4 | 四门禁全绿 | **PASS**（lint:strict / typecheck / test / check:gates，见 §4） |

阶段 5 收口结论：**四条验收标准全部 PASS**。验收过程发现并修复三处产品级问题（侧栏行布局挤压、PTY 草稿单向替换、hover 点击拦截），见 §5。

---

## 1. 全流程整机 spec（验收标准 1）

新增 `apps/desktop/e2e/session-lifecycle.spec.ts`，6 用例全绿：

| # | 用例 | 覆盖 |
|---|---|---|
| 1 | 草稿优先与单草稿替换 | 点「＋」只开草稿（结构化/PTY 侧栏均无新行）、结构化→结构化替换带明确提示、结构化↔PTY 双向替换（面板整体切换）、首条消息才落库出行并激活、PTY 首输入才落库出行 |
| 2 | 归档→取消归档→恢复续聊 | hover 归档移出默认列表、设置面板按项目分组可见（组头 N 条 + 条目 标题/CLI/最后活跃/归档时间）、取消归档回列表（已断开）、选中出恢复引导条→读取原生历史并恢复→空闲→续聊新回复 |
| 3 | 删除二次确认与激活切换 | 弹窗三要素（标题/影响说明/不可撤销）、取消不发请求行保留、删激活（排序末位）切上一条、再删切上一条、全删空态（侧栏与列表均无行） |
| 4 | 重启后历史与配置正确 | 两会话恢复已断开态且无空会话行（行数=2）、autoArchive 开关开/天数 45 持久化、启动扫描反馈「上次扫描：归档 0 条会话。」 |
| 5 | 失败注入：创建失败可重试 | KANBAN_FAKE_CREATE_FAIL_FIRST → 草稿提交失败卡 + 草稿/输入保留 + 不留空会话 →「重试发送」成功出行（详版断言在 error-cards.spec 既有用例） |
| 6 | 失败注入：终端启动失败可重试 | 直连 invoke 注入未找到命令 → E_INTERNAL 明确报错 + 占位行回删（同运行无孤儿行）→ 换有效命令重试成功 → 重启后仅成功创建的终端一行（失败创建重启也不被恢复）；草稿 UI 级缓冲保留重试由 A 类 terminal-draft.test.ts / ChatWorkspace.test.tsx 覆盖 |

既有 14 个迁移 spec 全量整跑结果见 §4。

## 2. 原型必须一致项对照（验收标准 2）

| 必须一致项（spec #57 Further Notes） | 证据截图 | 判定 |
|---|---|---|
| 暗色 token（以应用侧 token 为准，形态一致） | 全部 8 张 | 一致（配色层级：bg/card/muted/border/primary 四级 + warn/destructive 点缀，与原型 token 层级对应） |
| 顶栏高度与设置入口位置 | 08-layout-baseline.png（断言 header 高 42px + 应用名 + 项目徽标 + 右侧「设置」） | 一致 |
| 侧栏三分组与底部三入口 | 08-layout-baseline.png（项目/结构化会话/PTY 终端 + 看板/记忆/Diff） | 一致 |
| 会话行 CLI 色点 / 主仓库-worktree 徽标 / 状态徽标 | 08-layout-baseline.png（色点+主仓库+已断开）；worktree 蓝形态见 stage1 `06-session-badges-worktree.png`（本阶段无形态变更） | 一致（注：240px 侧栏 + hover 操作区常驻预留下标题/主仓库徽标轻度截断，tooltip 保留全名，属既有 #62 设计） |
| 断开会话的恢复引导条文案与按钮 | 05-disconnected-resume-banner.png（断言与现网 ResumeBanner 一字不差 +「读取原生历史并恢复」按钮） | 一致 |
| 设置面板保留两项日志动作 | 06-settings-modal.png（日志区「打开日志文件」「复制日志文件路径」+ 自动归档区 + 已归档分组三区同屏） | 一致 |

补充对照（可调整范围抽查）：草稿提示行措辞（01）、失败卡信息结构（02）、hover 操作按钮（03）、删除确认弹窗（04）、已归档分组与条目 meta（07）、扫描反馈呈现（06 内「上次扫描：归档 1 条会话。」，经直接写库造超期数据驱动启动扫描）。

## 3. 失效断言三组清单迁移收尾（验收标准 3）

- 「点＋即出行」（清单 15 处，grep 实测 22 个可见性断言）：全部为「点 CLI → draft-hint 可见 → 发首条消息 → 行出现」新语义，12 个 spec 文件均含 draft-hint 前置；`演示会话 · Fake` 相关断言已迁移为草稿标题/无侧栏行语义（window.spec:37、projects.spec:107）。
- 「重启全恢复」（11 处）：语义本身仍成立（产生过对话的会话恢复为已断开），触发前置已随草稿语义迁移；pty/lifecycle/resume-banner/stage4/kanban 各重启断言保留。
- 「行数与形状」（11 处 session-row + 形状断言）：定位器与计数随草稿语义有效，无空会话行干扰。
- packaged-smoke.cjs 两处（:147/:192 附近）：#59 已迁移为 runFakeTurn 首条消息触发创建后等行；本次本地 `pack:dir` 产物实跑 smoke 与 lifecycle 两模式验证通过。

## 4. 四门禁（验收标准 4）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 严格 lint | `pnpm lint:strict` | 0 warning / 0 error |
| 类型 | `pnpm typecheck` | 5 包通过 |
| 密封测试 | `pnpm test` | 5 包全绿（desktop 含新增双向替换用例） |
| 门禁契约 | `pnpm check:gates` | 通过（B 类门控 / workspacePackages / 归档 PNG 本次经 KANBAN_ALLOW_ARCHIVE_PNG=1 放行） |

全量 Playwright C 类（20 spec，含新增 2 个）：全绿，数字见工单回报。

## 5. 验收发现并修复的问题（产品缺陷）

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 1 | 长会话标题被侧栏行挤到 0 宽（getByText 判 hidden，acceptance-screenshots 稳定红，#63 移交） | 标题 span `flex-1`（basis 0）在预算不足时收缩到 0，而徽标 `flex-none` 不收缩 | 标题改 `grow`（basis auto）参与按基准分摊；worktree/主仓库徽标可收缩截断（tooltip 保留全名）；状态徽标 `flex-none whitespace-nowrap` 修复被压至 29px 宽的竖排换行（行曾撑高 56px，#62 起潜伏） |
| 2 | hover「＋」/「归档」点击偶发被下层按钮拦截（#63 移交偶发项） | 悬停门控按钮 `pointer-events-none → group-hover:auto`，而点击命中判定先于鼠标移动，无 hover 态时命中落到下层 | 移除 pointer-events 门控仅保留透明度切换（真实用户指针在按钮上时行必然处于 hover，无行为差异） |
| 3 | 结构化草稿打开时点「＋」选 PTY 终端，PTY 草稿不呈现（全局单草稿单向替换） | `openPtyDraft` 未丢弃结构化草稿，DraftPane 优先级高于终端草稿 | `openPtyDraft` 先 `controller.store.discardDraft()`（A 类 ChatWorkspace 双向替换用例先红后绿） |

## 6. 已知限制与记录

- 侧栏行标题/主仓库徽标在 240px 侧栏下轻度截断（tooltip 全名可查）：hover 操作区常驻右缘预留（#62 设计）与徽标并存的固有紧凑度；状态徽标已不可竖排，标题不再 0 宽。
- PTY→结构化草稿替换无「已替换」文案（面板整体切换即信号，原型 toast 文案属「草稿提示文案措辞」可调整范围）；结构化→结构化替换保留明确提示。
- 全流程 spec 的终端失败注入走 Main 编排面（直连 invoke 先例 lifecycle.spec）：PTY 草稿 UI 级失败缓冲保留/继续输入即重试由 A 类覆盖，整机层由「回删无孤儿行 + 重启不复活」断言把关。
