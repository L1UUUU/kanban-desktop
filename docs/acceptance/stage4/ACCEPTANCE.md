# 阶段 4 验收报告（S4-10 / issue #50）

> 日期：2026-11-09 · 验收人：acceptance subagent（issue #50）· 规范依据：spec issue #40（I 节「原型验收依据」+ Testing 验证要求）+ 工单 #50 四条验收标准
> 环境：Windows 11（10.0.26200）· Node v24.13.0 · pnpm 10.32.1 · Electron 44.10.2（electron-vite 构建产物）· 基线 s4-polish tip `0ade35d`（阶段 4 功能票 #41–#49 全部合并）
> 验收驱动形态：Fake 驱动 Playwright 截图 spec `apps/desktop/e2e/stage4-acceptance-screenshots.spec.ts`（6 用例 / 14 张截图直写 `docs/acceptance/stage4/screenshots/`，断言随截图进行兼作交互实测记录），深度交互断言引用既有 `diff.spec.ts` / `error-cards.spec.ts` / `resume-banner.spec.ts` / `residue.spec.ts` 四 spec 用例结果。
> 原型对照依据：`docs/prototypes/stage4-polish-ui.prototype.html`（四演示 tab，用户已确认）。

## 0. 结论一览

| # | 验收标准（issue #50） | 结论 |
|---|---|---|
| 1 | 四视图全流程 Playwright 通过 | **PASS**（新 spec 6/6 通过；加上引用的既有四 spec 7 用例，Diff 视图进入/展开/折叠/刷新/空态、五类错误卡呈现与动作、恢复条三态流转、残留通知条预置数据全流程覆盖，见 §1） |
| 2 | 原型必须一致项逐项截图对照归档 | **PASS**（I-1～I-5 逐项截图 14 张归档 `screenshots/`，逐项判定：**一致 9 项 / 一致（微调，落在可调整范围内）3 项 / 无不一致项**，对照表见 §2） |
| 3 | 关键交互实测记录齐备 | **PASS**（恢复/重试/清理/忽略/刷新/展开/折叠/知道了/重试创建/打开 PTY 终端逐项实测或引用既有用例，见 §3） |
| 4 | 受影响旧截图重截核实 + 遗留与已知限制清单 | **PASS**（stage1-3 截图 spec 在新 UI 上全量重跑通过，入库截图无旧 UI 元素残留，33 张字节级重写全部还原（唯一实质差异为 #43 新增 Diff 入口行，按既有惯例旧阶段目录保留历史快照，见 §4）；遗留/已知限制汇总见 §6，含视觉优化占位项 US-24 输入状态与移出决定） |

阶段 4 收口结论：**四条验收标准全部 PASS**。验收过程未发现产品缺陷或实质不一致项；#48 会话线索探针「不达标不上线」为 spec D2 预设的判据结果，Diff 纯工作区视图即终态（§5）。

---

## 1. Playwright 四视图全流程（验收标准 1）

新增 `apps/desktop/e2e/stage4-acceptance-screenshots.spec.ts`（对齐 stage1-3 验收 spec 形态：Fake 三件套 env + userData 隔离 + shot() 直写验收目录），6 用例全绿：

| # | 用例 | 覆盖 |
|---|---|---|
| 1 | Diff 视图入口/头部/文件行/展开/折叠/刷新/空态 | 进入自动读取、`5 个文件 · +3 -2 · 未提交（HEAD 对比）`统计、M/R/D/U/binary 五类文件行、展开行级红绿 + hunk 头、untracked 全文、折叠收敛、手动刷新、未注册项目时入口禁用（F9）、非 git 项目居中空态 |
| 2 | 错误卡五类呈现与动作 | CLI_EXIT / AUTH_EXPIRED / SPAWN_NOT_FOUND / PROTOCOL_DISCONNECT / UNKNOWN 五卡逐张截图 + 动作流转（知道了/重试/恢复会话） |
| 3 | spawn 创建失败侧栏卡 | KANBAN_FAKE_CREATE_FAIL_FIRST 注入 → 侧栏创建入口卡（F1 形态）→ 重试创建收敛 |
| 4 | 恢复条成功流转 | 断开 → 待恢复 → 恢复中（KANBAN_FAKE_RESUME_DELAY_MS=4000 观察）→ banner 消失 + 空闲 + 可续聊 |
| 5 | 恢复条失败流转 | KANBAN_FAKE_RESUME_FAIL_FIRST → 失败原因 + E_INTERNAL + 重试 + 复制错误详情 → 重试成功收敛 |
| 6 | 残留通知条 + 进程表 | KANBAN_TEST_RESIDUE_JSON 种子 → 警示条 + 五列表 + 默认勾选规则 + 补勾清理 → 表清空条消失 |

引用的既有 spec 用例（同一集成分支上全绿，验收当晚复跑确认）：

| spec | 用例 | 覆盖补充 |
|---|---|---|
| `diff.spec.ts`（#43/#47） | 3 用例 | worktree 目录 diff 语义、真实 git 仓库全流程独立复跑 |
| `error-cards.spec.ts`（#46） | 2 用例 | 五类卡断言细节（含 auth-cmd 命令块、config.json 路径）+ 侧栏卡 |
| `resume-banner.spec.ts`（#42） | 2 用例 | 三态流转断言细节（无按钮断言、会话保持断开） |
| `residue.spec.ts`（#49） | 3 用例 | 「忽略本次」、无残留不打扰（无种子零 UI） |

## 2. 原型必须一致项逐项对照（验收标准 2 / spec #40 I 节）

原型 = `docs/prototypes/stage4-polish-ui.prototype.html`；判定口径 = I 节「必须一致项（可判定验收条款）」+「可调整范围」（颜色/间距/图标/具体文案微调）。

| 一致项 | 原型位置 | 截图 | 判定 | 对照依据 |
|---|---|---|---|---|
| I-1a Diff 头部（标题 + N 文件/+M/-L 统计 + 刷新按钮 + HEAD 对比口径） | d1 `diff-head` | `01` | 一致 | 「工作区变更」标题 + 「5 个文件 · +3 -2 · 未提交（HEAD 对比）」+ 刷新按钮，进入视图自动读取一次 |
| I-1b 文件行（展开箭头 + 类型徽标 + 等宽路径 + 统计标注） | d1 `diff-file-head` | `01` | 一致（微调①） | M 蓝/A 绿/D 红/U 黄配色与统计标注（`+2 -1` / 「新文件（未跟踪）」 / 「二进制文件」）齐备；实现含 R 徽标（改名）——spec #40 A 节 changeType 五枚举明确含 `renamed`，原型演示数据未含 R 样例，属规格内补充非偏离 |
| I-1c 展开区行级渲染（新增绿/删除红/hunk 头/上下文灰） | d1 `diff-content` | `02` | 一致 | hunk 行 `@@`、`-line2` 红底红字、`+line2-changed`/`+line4` 绿底绿字、上下文灰字逐类断言并同屏截图 |
| I-1d untracked 全文与二进制不渲染（US3/US4） | d1 U 行/binary 行 | `03` | 一致 | U 行展开 `+untracked` 全文绿行；binary 行仅「二进制文件」标注（内容不渲染）；行数/字节截断保护由 #47 密封测试覆盖 |
| （票面）Diff 空态 | d1 空态 note | `04` | 一致 | 非 git 项目居中「当前项目不是 git 仓库，无变更可展示」，不弹窗报错 |
| I-2 错误卡五类（四类 + 未知兜底）信息结构 | d2 五张 `err-card` | `05`–`09` | 一致（微调②） | 卡式布局逐项在位：图标+标题头 / 原因区 / 指引命令块（auth 卡等宽底色块 `claude`+`/login`）/ 动作按钮区右对齐；五卡标题、说明、动作组合与原型逐卡对应（CLI_EXIT→读取原生历史并恢复+知道了；AUTH→重试+打开 PTY 终端；SPAWN→重试+复制配置路径；DISCONNECT→恢复会话+知道了；UNKNOWN 灰边→重试+复制错误详情，原始 code+message 原文保留）。微调：disconnect 卡图标 ⚡（原型 🔌）、各卡多一行「原始信息：…」原文（不吞错的实现口径）、认证指引命令按实际 CLI 两行呈现 |
| I-2 补充 spawn 侧栏卡（F1 处置形态） | d2 卡 3 | `10` | 一致（微调③） | 无会话视图可挂时卡挂侧栏创建入口：🔍 标题 + config.json 路径 + 重试创建 + 复制配置路径；微调：多「知道了」dismiss 入口。注：该截图聊天区为 Fake 注入环境下的 IPC 桥接占位形态（既有 #46 用例同场景） |
| I-3 恢复引导条三态（顶部条形态，与冲突条同位同形） | d3 三 banner | `11`/`12`/`13` | 一致 | 待恢复：会话名 + 缓存不替代原生历史说明 + 主按钮「读取原生历史并恢复」（文案保留，F12）；恢复中：spinner + 「不可中断，通常数秒内完成」+ 零按钮（D1）；失败：原因 + 错误码（E_INTERNAL）+ 重试 + 复制错误详情；消息流底部无第二恢复入口 |
| I-4 残留通知条 + 进程表 | d4 `banner warn` + `pid-table` | `14` | 一致 | 警示色顶部条（检测到 N 个 + 「清理前请确认它们不是你自己打开的」）+ 五列表（勾选/PID/进程/启动时间/关联记录）+「清理选中」「忽略本次」；「无会话记录」行默认不勾选（防误杀）在截图内可见 |
| I-5 侧栏第四入口（与看板/记忆同形态，激活态） | d1 侧栏 `entry-btn.on` | `01`（同屏） | 一致 | Diff 入口与看板/记忆并列同形态（整宽 + 图标 + 当前项目指示），激活态高亮边框样式一致；未选项目时禁用（F9，用例 1 实测） |

原型 d1 中「会话线索」虚线标注（session-tag）**不在对照项内**：#48 探针判据不达标，UI 不上线（§5），Diff 文件行无会话标注即终态。

## 3. 关键交互实测记录（验收标准 3 / spec #40 I 节验证要求）

「本 spec」= stage4-acceptance-screenshots.spec.ts（断言即记录）；「引用」= 既有 spec 用例在集成尖端的通过结果。

| 交互 | 实测记录 |
|---|---|
| 恢复 | 本 spec 用例 4/5：断开 → 待恢复条 → 点击 → 恢复中（无按钮）→ banner 消失 + 空闲 + 可续聊（「中断后继续」得到完整回复）；失败态 E_INTERNAL 原文呈现、会话保持断开。引用：resume-banner.spec.ts 2 用例（1.5s 延迟观察 + 失败重试收敛）、error-cards.spec.ts 卡 4「恢复会话」与恢复条同一 resume 动作（D4，卡消失收敛） |
| 重试 | 本 spec 用例 2：auth 卡「重试」= 重发最近一条用户消息（消息流第二条同文回显 + 卡确定性复现）；恢复失败条「重试」成功收敛（用例 5）；未知卡「重试」按钮在场。引用：error-cards.spec.ts 卡 2 同链路 |
| 清理 | 本 spec 用例 6：补勾「无会话记录」行 → 「清理选中」→ fake kill 逐 pid 全 killed → 表清空、条消失（确认式，仅勾选 pid 被终止）。引用：residue.spec.ts 用例 2 |
| 忽略 | 引用：residue.spec.ts 用例 1 ——「忽略本次」→ 条消失（只关本次通知，下次启动重新检测）；用例 3 无种子不出现任何残留 UI（无残留不打扰） |
| 刷新 | 本 spec 用例 1：手动刷新 → 统计保持「5 个文件 · +3 -2」；进入视图自动读取一次。引用：diff.spec.ts 刷新断言 + latest-wins 并发丢弃（#47 密封测试） |
| 展开/折叠 | 本 spec 用例 1：展开 a.txt（hunk 头 + 红绿行）→ 折叠（行级内容归零）→ 展开 notes/new.md（untracked 全文）。引用：diff.spec.ts 展开/折叠断言 |
| 知道了 | 本 spec 用例 2：CLI_EXIT 卡 dismiss → 卡消失。引用：error-cards.spec.ts 卡 1 |
| 重试创建 | 本 spec 用例 3：侧栏 spawn 卡「重试创建」→ 原参数重发 session:create → 卡消失 + 会话登记。引用：error-cards.spec.ts spawn 用例 |
| 打开 PTY 终端 | 引用：error-cards.spec.ts 卡 2 —— auth 卡动作 → 会话 cwd 新建 PTY 终端（侧栏出现终端行并切换） |
| 复制类动作 | 「复制配置路径」「复制错误详情」按钮在场断言（本 spec 用例 2/3）；剪贴板值不可读回为本机非交互会话已知边界（stage3 §7-3 同口径），以按钮反馈 + 路径文案直读侧证 |

## 4. 受 S4-03 入口迁移影响的旧截图核实结论（验收标准 4 前半）

方法：全量重跑 stage1-3 三个截图 spec（`acceptance-screenshots` / `kanban-acceptance-screenshots` / `memory`，Fake 驱动）→ 全部通过（旧断言在新 UI 上无一失败）→ 对 33 张被字节级重写的截图做新旧目视抽查比对（stage1/07 恢复场景、stage2/01 侧栏两张重点全查 + 其余按场景归属分析）→ 无冲突的还原，只保留真受影响的。

核实结论：

1. **旧底部恢复按钮不在任何入库截图里**：stage1 全套截图已随 #42（commit `9d1c621`）重截，`07-disconnected-recovery.png` 入库版即顶部恢复条形态，消息流底部无恢复按钮；stage2/3 截图场景不含断开会话恢复入口。新跑版与入库版该截图实质等价。
2. **旧红字错误行不在任何入库截图里**：stage1-3 截图场景均不含 session_error 呈现（stage1/08 为「本轮已取消」提示，非错误行）；#46 错误卡形态仅存在于 stage4 新截图（05-10）。
3. **唯一实质差异 = 侧栏新增 Diff 入口行（#43）**：新跑版截图侧栏均多一行 Diff 入口。处置：按既有惯例**不入库**——先例为 stage3 加「记忆」入口后 stage1/2 侧栏截图未重截（旧阶段验收目录保留各阶段当时快照，随 UI 演进滚动重截无验收价值）。33 张字节级重写已全部还原至 HEAD 版本，`git status` 干净。
4. **旧 spec 与新 UI 无断言冲突**：三个旧截图 spec 在集成尖端全绿，证明既有定位与文案（含「读取原生历史并恢复」文案保留，F12）未被阶段 4 改动破坏。

## 5. S4-06（#48）探针结论引用

`session-clue-probe.md`：三 CLI 各 ≥10 真实样本已采集（判据一达标）；路径提取命中率 Claude Code 100% / Codex 100% / **OpenCode 33.3%**（判据二 ≥80% 不达标，口径 = 三 CLI 全部达标才上线）→ **会话线索标注 UI 不上线**，原型 d1 的 session-tag 整行不落地，**Diff 纯工作区视图即终态**（本报告 §2 对照表按此口径执行，无会话标注不构成偏差）。根因：OpenCode `tool_started` 发射时 `state.input` 为空对象、write/edit/bash 输出不含路径，事件通道结构性提不出文件路径；提取器 `tool-path-extract.ts` 留档，复查触发条件见该报告 `shortcut` 标记。

## 6. 遗留与已知限制清单（验收标准 4 后半）

| # | 项 | 状态/输入状态 | 出处 |
|---|---|---|---|
| 1 | **视觉优化占位（US-24）明确移出阶段 4** | 输入状态 = 等待用户日常使用反馈清单；截至本次验收无清单到位。按 spec #40 E 节「无清单则明确移出而非静默消失」：**US-24 移出阶段 4 范围，未执行任何自觉性视觉改动**；清单到位后以补充条款追加范围再拆票 | spec #40 US24/E 节 |
| 2 | PTY 子树强杀残留治理非目标（D3） | PTY 由 node-pty 在 Main spawn、无 Job Object；shell 匹配误检面过大。正常退出治理由 killAll 覆盖；强杀场景 Job Object 兜底覆盖 CliHost worker 内全部 CLI 子孙（含 MCP 孙进程），PTY 子树不在覆盖范围 | `residue-known-limits.md` #6、`job-object-kill-evidence.md` §5 |
| 3 | 残留检测漏检面（npm 升级/路径漂移，F10） | 候选并集来自当前解析链，旧位置进程漏检；打包形态本地 node_modules 候选缺失；候选只收当前存在路径 | `residue-known-limits.md` #1–3 |
| 4 | 残留会话归属 best-effort | codex 与匹配失败时回落同 CLI 最近会话记录，「关联记录」列不构成精确映射（安全性不受影响：勾选才是清理依据） | `residue-known-limits.md` #4 |
| 5 | OpenCode 孤儿 server 排除不做 HTTP 探活 | 注册表四要素核对通过即排除（宁可漏列不误杀），实际不可接管时恢复走新 spawn | `residue-known-limits.md` #5 |
| 6 | codex 认证失效真实触发未果（静默挂起） | 0.167.0 app-server 形态下认证失效不向协议层快速浮出（≥35s 无错误通知）；归类依赖构造样本（三发射点覆盖），如实标注「未真实触发」 | `auth-samples.md` Codex 节 |
| 7 | opencode provider 认证失败原文未真实捕获 | 无效 apiKey 返回 204 空回复不浮出 session.error；HTTP 401/403 结构化检测 + 构造文本样本覆盖 | `auth-samples.md` OpenCode 节 |
| 8 | 会话线索标注 UI 不上线 | OpenCode 33.3% 命中率不达标；提取器与探针套留档可重跑 | `session-clue-probe.md`（§5） |
| 9 | 剪贴板读回环境限制 | 非交互会话系统剪贴板不可读回（阶段 3 已知边界沿用）；复制类动作用 UI 反馈 + 磁盘直读侧证 | stage3 report §7-3 |
| 10 | Diff 事件驱动自动刷新为后续可选项 | 仅进入视图 + 手动刷新（spec Out of Scope 明示） | spec #40 Out of Scope |

强杀实证（#45）、认证样本（#41）、Job Object 布防缺陷修复（#45 §4）等真实验证记录已随各票归档于本目录，本报告引用不重复。

## 7. 回归验证

| 套件 | 命令 | 结果 |
|---|---|---|
| 单测（A 类全量） | `pnpm test` | **5 包 856 passed / 79 skipped（0 failed）**——memory 76 / ipc-schema 108 / tracker 80 / cli-host 218+71 skipped / desktop 374+8 skipped；skipped 全部为 B 类 `KANBAN_E2E` 门禁（默认关，符合 docs/testing.md） |
| 类型 | `pnpm typecheck` | 5/5 包 PASS（`tsc --noEmit`，desktop 双 project） |
| Lint | `pnpm lint` | 0 warnings 0 errors（oxlint，231 files） |
| 构建 | `pnpm --filter @kanban/desktop exec electron-vite build` | 通过 |
| 整机 Playwright 全套 | `pnpm --filter @kanban/desktop exec playwright test --workers=1` | **39 passed / 3 skipped（0 failed，4.3m）**——16 spec（15 既有 + 本票新增 1）；3 skipped = `kanban-real.spec.ts` 1 用例 + `memory-real.spec.ts` 2 用例，均为 `KANBAN_REAL_E2E=1` 真实门控未设（真实 CLI 成本门控，非缺陷） |

真实门控面说明：本票为 Fake 驱动验收，B/C 类真实门控未开启；阶段 4 的真实验证证据已随各功能票归档于本目录（#41 认证样本矩阵、#45 强杀 Job Object 实证、#48 探针样本 JSON），本报告 §5/§6 引用。

> 本票零产品代码改动（验收 spec + 截图 + 报告归档）。
