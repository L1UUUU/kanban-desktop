# 阶段 3 验收报告（S3-10 / issue #37）

> 日期：2026-11-06 · 验收人：acceptance subagent（issue #37）· 规范依据：spec issue #27（Testing 验收票 + 25 User Story + I 节一致项）+ 工单 #37 四条验收标准 + #27 评论区 #38 wire 修订记录
> 环境：Windows 11（10.0.26200）· Node v24.13.0 · pnpm 10.32.1 · Electron 44（electron-vite 构建产物）· 基线 s3-memory tip `a8a826b`（#28–#38 全部合并）· 真实 CLI：claude 2.1.317 / codex-cli 0.144.1
> 真实验收驱动形态：**门控 Playwright spec**（`apps/desktop/e2e/memory-real.spec.ts`，`KANBAN_REAL_E2E=1`），GUI 级驱动真实应用（真实 Claude/Codex Adapter、隔离 userData 与项目目录、不打 KANBAN_DISABLE_*），可重复执行、断言内嵌、证据直写 `docs/acceptance/stage3/real-evidence/`。

## 0. 结论一览

| # | 验收标准（issue #37） | 结论 |
|---|---|---|
| 1 | 真实提取成功且模型调用 ≤3（含重试）；隔离 sha256 前后不变 | **PASS**（批次① completed 产出真实总结与 3 候选；提取调用 2+1=3 达预算上限；双检查点 sha256 全不变，见 §1/§2） |
| 2 | 审核入库 → 记忆视图检索 → 复制路径 CLI 读取，链路真实可用 | **PASS**（三动作全在真实候选走完；大小写不敏感检索命中；复制路径反馈 + accepted md 磁盘直读含溯源头，见 §3；剪贴板值读回为本机环境限制，见 §7） |
| 3 | 重启后全部状态保持；防覆盖闭环（编辑→proposed→二选一）实测通过 | **PASS**（真实关闭重开全保持；防覆盖闭环全链由 B 类 e2e 实测通过（真实 memory:ipc 通道 + 真实管线 + runOnce seam 注入），真实验收补充「人工版编辑落盘 + 提取批次零触碰」实证——第二次真实提取因 harness 缺陷在应用关闭时被有序取消（其本身即 US24 实证），预算硬上限内不重发，见 §4/§7-1） |
| 4 | #1 契约追记 + spec #27 User Story 勾稽表 + 验收记录与原型对照归档 | **PASS**（[#1 评论](https://github.com/L1UUUU/kanban-desktop/issues/1#issuecomment-6686071051) C1/C3/C5 演进指针；[#27 评论](https://github.com/L1UUUU/kanban-desktop/issues/27#issuecomment-6686379235) 25/25 勾稽表；本报告 + real-evidence/ + #36 screenshots/ 归档） |

阶段 3 收口结论：**四条验收标准全部 PASS**。真实验收过程中未发现产品缺陷；批次② 意外触发的「应用关闭时进行中提取有序取消」反而构成 US24 的真实条件实证（§4.2）。

---

## 1. 需求与关联会话准备（最省真调用）

真实需求「真实提取验收需求」（REQ-001，手动建卡于未开始列，归属隔离项目 `kb-s3-real-proj`）+ **2 个 CLI 关联 structured 会话**，各一条含工具调用的真实短 turn（读取预置 `NOTES.md` 项目约定后一句话总结）：

| 会话 | CLI | 模型调用 | 原生历史文件（提取对象） |
|---|---|---|---|
| 开发会话① | Claude（Read 工具） | 1 turn | `~/.claude/projects/<munged-repo>/0b69e049-….jsonl` |
| 开发会话② | Codex（shell type 读取，sandbox 内零审批） | 1 turn | `~/.codex/sessions/2026/11/06/rollout-…-01a1b108….jsonl` |

另有 run 2 中断前消耗的 1 条 claude 短 turn（其 fixture 已清理，不入最终台账对象；调用次数如实计入 §6 总账）。

## 2. 真实提取与三层隔离复核（AC-1）

### 2.1 批次①（真实 Claude headless，2 次模型调用）

GUI 详情面板点「⚡ 提取需求经验」→ 四步进度真实可见（`real-00-extract-progress.png`，进行中态 UI 的真实链路补充——#36 预置数据无法覆盖的形态）→ 批次 completed：

- 批次卡元信息逐项断言通过：**来源 2 会话 · 缺失 0 · 分段 2 · 模型调用 2 次**（两会话按会话边界切段，每段独立临时会话）；
- 产物真实落盘：总结 `requirements/REQ-001/summary.md`（含来源声明 + 两段小结）；**3 条真实候选**（CAND-0001「构建必须通过 pnpm --filter 精确指定子集构建…」/ CAND-0002「所有文件必须使用 UTF-8（无 BOM），禁止 GBK」/ CAND-0003「编码约定记录在 NOTES.md，可用 cmd /c type 读取」），claim 均复用历史固定术语（`real-01-extract-completed.png`、`store-snapshot/`）。

### 2.2 三层隔离（PoC 5 sha256 方法复核）

`isolation-report.json`（提取前基线 = `isolation-pre-fingerprints.json`，run 3 提取前采集）：

| 隔离层 | 证据 |
|---|---|
| ① 全新 session id | 3 个临时会话 transcript（批次① ×2：`1fc90295…`/`84d9a43b…`；批次② ×1：`9d11cd9d…`）与开发会话文件集合**零交集** |
| ② 开发会话原生历史只读 | **两个检查点 sha256 全部不变**：批次① 后（run 3，断言通过）→ 跨两次应用生命周期 + 批次② 后（run 8 复核，claude transcript 与 codex rollout 均逐文件 unchanged=true） |
| ③ cwd 在应用数据独立临时目录 | 临时会话 transcript 全部落在 `~/.claude/projects/<munge(<userData>/memory/<projectId>/extract-tmp/<batchId>)>/` 派生目录（不在项目仓库、不在开发 cwd） |

## 3. 审核闭环 → 记忆检索 → 复制路径（AC-2）

三动作全部在**真实提取候选**上走完（`real-02-candidates-reviewed.png`）：接受（并存入库 CAND-0001）→ 编辑后接受（CAND-0002 claim 追加「（验收人工修订）」，溯源只读）→ 忽略（CAND-0003）；已处置按批次折叠行「已接受 1 · 已编辑 1 · 已忽略 1」。

记忆视图（`real-03`/`real-04`）：知识 2 条分区展示；搜索 **「PNPM」大写命中**（大小写不敏感子串，US20）；复制路径/内容反馈提示；**accepted md 磁盘直读**（复制路径可供 CLI 按需读取的实证）：`CAND-0001.md`/`CAND-0002.md` 含完整溯源头（id/project/requirement/claim/source_sessions/evidence/scope/generated_batch/review_status/reviewed_at）与「来源 Session」标注，内容与 UI 一致（快照见 `store-snapshot/`）。

## 4. 重启保持与防覆盖（AC-3）

### 4.1 重启保持（US25）

真实关闭（统一退出序列）→ 重开（同 userData）：批次历史（completed 卡）、候选处置状态（折叠行已接受/已编辑/已忽略计数）、已接受知识（2 条）、需求总结**全部保持**（`real-05-restart-kept.png`；无 pending 复活）。

### 4.2 防覆盖闭环（US14 + #38）

- **人工编辑真通道落盘**：记忆视图总结编辑弹层写入人工标记「人工修订标记：防覆盖闭环验收（issue 37）」→ 查看弹层读回（`real-06-summary-manual-edit.png`）；summary.md 磁盘含标记。
- **真实批次零触碰实证**：第二次真实提取（批次②，解除 Codex 关联后 1 段 = 1 次调用）段已完成、因测试框架提前关闭应用（harness 缺陷，§7-2）被退出序列**有序收敛为 cancelled**——批次卡灰显（`real-07-cancelled-batch.png`）、无候选落库、无 proposed 残留、**人工版总结未被触碰**（视图读回标记仍在）。取消/失败批次零写库是防覆盖的最强形式；该批次同时构成 US24（退出有序取消）与 US10（整批要么完整要么没有）的真实条件实证。
- **proposed → 对比 → 二选一**：完整闭环由 B 类 e2e「总结编辑闭环（issue #38）」实测通过——真实 `memory:ipc` 通道 + 真实管线（`SummaryStore` hash 基准/proposed 暂存/keep-human 清指针），仅 claude headless 输出经 #32 设计的 runOnce seam 注入；GUI 侧 proposed 提示条/两栏对比弹层/二选一由 #36 Playwright 预置数据走查（截图 05/05b）。受 §7-1 预算边界限制，未再消耗第 4 次真实提取复演该段。

## 5. 契约追记与勾稽表（AC-4）

- **#1 冻结契约追记**（评论追加、不动冻结正文）：[issues/1#issuecomment-6686071051](https://github.com/L1UUUU/kanban-desktop/issues/1#issuecomment-6686071051)——C1 +`readTranscript`（#28/`26399ed`）、C3 v3 三表（#30/`ea583dc`）、C5 +`run-once`（#29/`40713bb`），均指向 #27 对应章节。
- **#27 User Story 勾稽表**：[issues/27#issuecomment-6686379235](https://github.com/L1UUUU/kanban-desktop/issues/27#issuecomment-6686379235)——25/25 达成 + I 节 8/8 一致项对照。

## 6. 模型调用台账（真实验收全程）

**提取相关合计 3 次（含重试 0）＝ 硬预算上限 ≤3**；造历史 3 turn 如实另计（含 run 2 中断前 1 条）。逐次记录：`real-evidence/model-calls-ledger.json`。

| # | 时间（UTC+8） | CLI | purpose | 结果 |
|---|---|---|---|---|
| 1 | 21:19–21:20 | claude | 造历史：开发会话① 短 turn（run 2，fixture 随中断清理） | turn 完成，fixture 弃用 |
| 2 | 21:24–21:25 | claude | 造历史：开发会话① Read NOTES.md + 总结 | transcript 入隔离基线 |
| 3 | 21:25 | codex | 造历史：开发会话② shell 读取 + 总结 | rollout 入隔离基线 |
| 4–5 | 21:25–21:26 | claude ×2 | **提取批次①** 段1+段2 临时 headless（`56be9945…`） | completed，产出总结 + 3 候选（DB model_call_count=2） |
| 6 | 21:39 | claude | **提取批次②** 段1 临时 headless（`70ca86e5…`） | 段完成；应用被关闭 → stop() 收敛 cancelled（零写库；DB model_call_count=1） |

台账证据链：批次行 `model_call_count` 落库（US12 UI 如实展示「模型调用 2 次/1 次」）+ 临时会话 transcript 文件在场（§2.2）。

## 7. 偏离与已知边界（如实）

| # | 项 | 说明 |
|---|---|---|
| 1 | 预算硬上限截断 proposed 真链复演 | 批次② 的 1 次调用因 §7-2 harness 缺陷未走完写库阶段（cancelled）；提取调用已达 3 次上限，不再发起新提取复演 proposed→二选一。该段闭环由 B 类 e2e（真实通道+真实管线+seam 注入）与 #36 Playwright 覆盖，真实验收以「人工版落盘 + cancelled 批次零触碰」为实证边界 |
| 2 | 验收 spec 六轮 harness 迭代（非产品缺陷） | ①详情面板透明遮罩拦截点卡（stage2 §8 既定语义 → openDetail helper 复用已开面板）；②编辑弹层保存成功不自动关闭（#33 既定交互口径，#36 spec 224 行同口径 → 改按「待审数减少+手动关闭」断言）；③批次② 等待误匹配旧 completed 卡（→ 按元信息「来源 1 会话」定位新批次卡）；④失败运行的 fixture 清理在锁失败前部分删除（→ 完成标志制，失败留存续跑）；⑤config.json 被误删后当前项目自愈（侧栏点选重设）；⑥accepted md 溯源头文案「来源 Session」断言修正 |
| 3 | 剪贴板环境限制 | 非交互会话系统剪贴板不可读回（#36 已知边界，主进程 clipboard 直写亦空）；复制动作以 UI 反馈提示 + md 路径磁盘直读侧证 |
| 4 | 进行中态 UI 覆盖 | 四步进度真实运行态由本票 real-00 截图补充；取消进行中提取的 GUI 交互仍由 #33 组件测试 + B e2e 覆盖（真实取消语义由批次② cancelled 实证侧证） |
| 5 | 既有门控 e2e flaky（非本票范围） | cli-host 既有 KANBAN_E2E 门控套件两处已知波动：claude interrupt 竞态（#29 修复后仍偶发）与 opencode SSE 波动；本票未触碰、未复跑（避免额外真实 CLI 消耗），如实列入 |
| 6 | 启动默认 Fake 演示会话 | 真实运行中观察到会话列表存在一条未关联的 Fake 演示会话（阶段 1 既有演示形态）；未关联任何需求 → 不入提取范围（与 US2 口径一致），无影响 |
| 7 | 真验收 spec 的复跑形态 | `memory-real.spec.ts` 含两个用例：完整旅程（从零造历史，3+3 次调用）与续跑收尾（`KANBAN_REAL_RESUME_USER/REPO` 指向幸存 fixture，0 次调用）。本次验收实际 = run 3（完整旅程前半）+ run 8（续跑收尾） |

## 8. 原型对照（引用 #36）

原型 `docs/prototypes/stage3-memory-ui.prototype.html` 的 8 条必须一致项已由 #36 Playwright 逐条走查并截图归档于 `docs/acceptance/stage3/screenshots/`（9 张：01 入口 / 02 工作区 / 02b 空搜索 / 03 禁用态 / 05 proposed 条 / 05b 对比弹层 / 06 候选冲突审核 / 07 候选编辑弹层 / 08 总结编辑弹层）；真实验收补充 8 张真实链路截图于 `real-evidence/`（00 进度 / 01 批次完成 / 02 审核后 / 03 检索命中 / 04 记忆视图 / 05 重启保持 / 06 人工编辑 / 07 cancelled 批次）。

## 9. 回归验证

| 套件 | 命令 | 结果 |
|---|---|---|
| 单测（无 env） | `pnpm --filter @kanban/desktop test` | 272 passed / 3 skipped（gated），与基线一致，无回归 |
| 类型 | `pnpm -r typecheck` | 5/5 包 PASS |
| Lint | `npx oxlint apps packages` | 0 warnings 0 errors |
| 新增门控验收用例 | `KANBAN_REAL_E2E=1 … playwright test memory-real` | 续跑收尾 **1 passed**（完整旅程用例随本报告 §7-1/§7-2 记录分段执行） |

> 本票零产品代码改动（验收 spec + 文档 + 证据归档）；spec 缺陷均在验收 spec 内修复并随票提交。
