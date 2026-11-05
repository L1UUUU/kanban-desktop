# PoC 5 结果 — 需求级 Memory 手动提取验证

日期：2026-11-05 · 环境：Windows 11 / Git Bash / Node v24.13.0 / claude 2.1.317（GLM 网关）/ codex 0.144.1（gpt-5.6-luna）
真实模型调用共 **7 次**（≤10 预算内）：dev-claude 1 + dev-codex 1 + B1 提取 2 + B2 提取 2 + B1 段1 失败 1（输出 JSON 含未转义引号，已修 prompt 并追溯补录台账，见 `logs/model-calls.jsonl`）。

## 一、六 bullet 判定表

| # | 验收项（§9 PoC 5） | 判定 | 证据 |
|---|---|---|---|
| 1 | 仅用户点击提取才执行；读取同需求多个 CLI 的历史 | **PASS** | 提取仅由 `node scripts/extract.mjs --req --batch` 显式触发，全流程无任何自动调度/hook/定时；`fixture/requirements.json` 将 claude session `7d06be78…`、codex thread `01a1aa3e…` 关联到同一 REQ-001，`logs/extract-B1.json` 的 `readableSessions` 显示两个 CLI 均读到（claude 5 事件 / codex 4 事件）。读取方式：claude 直读 `~/.claude/projects/…/<id>.jsonl`（只读）；codex 经 app-server `thread/read`（读磁盘，不 resume 不发 turn） |
| 2 | 临时 CLI Session 独立于开发 Session；不得污染原生上下文 | **PASS** | 提取用全新 UUID 的 `claude -p --session-id`（无 --resume/--continue），cwd 为独立目录 `extract-tmp/`；`logs/isolation-B1.json`/`-B2.json`：开发 claude jsonl 提取前后 sha256 `b86241…` 不变、codex rollout `cab31c…` 不变，`isolated: true`；临时 session 落在独立 project 目录 `…-poc-5-memory-extract-tmp`（`~/.claude/projects/` 列表可证），与开发目录 `…-fixture-workdir` 完全分离 |
| 3 | 历史过长时分段处理，缺失历史明确提示 | **PASS** | 分段 `chunkEvents`（session 边界优先 + 累计字符 + 单事件硬切）为确定性纯函数，`tests/chunk.test.mjs` 5 项覆盖（边界切分/不撕裂事件/硬切片）；真实运行 2 段（B1/B2 各 2 段）。假 session `00000000-dead…` 读取失败归入 `missingSessions`，`data/REQ-001/summary.md` 顶部「来源 Session」列出 ❌ 不可读，并有独立「缺失历史提示」节声明「本次提取未包含以下 1 个 Session 的历史，分析不覆盖其内容」 |
| 4 | 同时输出开发总结和有来源的长期知识候选 | **PASS** | `data/REQ-001/summary.md`（批次 B1）含分段开发小结；`candidates.jsonl` 15 条候选全部带 `sourceSessionIds`/`evidence`/`scope`（B1 8 条 + B2 7 条）；来源由 pipeline 强制校正（`clampExtraction`：模型给出的来源 ∩ 段内 session，空则回填段内全部），候选证据含历史原句摘录 |
| 5 | 用户可接受、编辑、忽略；结果存入 Kanban 管理的本地项目目录 | **PASS** | `data/REQ-001/{summary.md,candidates.jsonl,accepted/}` 为 Kanban 数据目录布局（未写项目仓库 `.local`，未上传）；`demo-review.mjs review-batch1` 真实演示：CAND-0001 accept → `accepted/CAND-0001.md`（带 review 元数据头：来源/证据/范围/批次/状态，参照 pi-sleep-agent T2），CAND-0002 edit → `accepted/CAND-0002.md`（`edited: true`），CAND-0003 ignore → 不写 accepted；状态流转 `pending → accepted/edited/ignored`，终态不可再改（单测覆盖） |
| 6 | 重复提取不静默覆盖人工编辑；早期错误被纠正后不作为项目规则 | **PASS** | B2 重复提取时 summary 已被人工编辑（追加「人工补充」行）：`writeSummary` 检测 meta hash ≠ 磁盘 hash → **不覆盖**，改写 `summary.proposed.B2.md` 暂存（`logs/extract-B2.json` `summaryWritten: {overwritten: false, reason: "human-edited"}`），磁盘仍为人工版（verify-batch2 `summaryHumanMarkKept: true`）。早期错误：dev-claude 历史真实含「除零返回 0 → 自测 FAIL → 纠正为 throw」情节，两批提取的除零候选全部为纠正后规则，无一条「返回 0」错误版本成为候选（`verify-batch2.json` `wrongRuleCandidates: []`、`wrongInAccepted: []`）；状态机侧确定性测试（`tests/review.test.mjs`）证明：错误候选被 ignore 后永不进入 accepted/，纠正版出现时带「与已忽略知识相似」note 提示、可正常接受 |

## 二、三项关键结论

1. **隔离（bullet 2）**：临时提取 session 与开发 session 在「session id、原生历史文件、project 目录」三层均分离；提取前后开发历史文件字节级不变（sha256 对比，B1/B2 两次均通过）。提取过程对开发 thread 只读（claude 直读 jsonl；codex 仅 `thread/read`，从不 `thread/resume`/`turn/start`）。
2. **不覆盖（bullet 6 前半）**：summary 防覆盖靠「生成时记录内容 hash + 写入前重算磁盘 hash」，人工编辑使二者不一致即触发暂存而非覆盖；重复提取产生的新批次候选独立追加（CAND-0009…0015），已审核的终态候选不可被再次流转覆盖（单测「终态候选不可再次审核」）。
3. **冲突检测（§8.5 难点）**：确定性字符 bigram + Dice 相似度。真实生效证据：B2 的 CAND-0010 与已接受（用户编辑版）CAND-0002 相似度 0.611 ≥ 0.5 → `conflicts: [{withId: CAND-0002, similarity: 0.611, kind: similar-to-accepted}]`，状态保持 pending 待用户裁决（演示中用户 ignore，保留原知识，不静默并入）。**已知边界（诚实记录）**：B2 的 CAND-0009 与已接受 CAND-0001 语义同指「divide 除零抛 Error」但措辞差异大，Dice 仅 0.391 < 0.5 未标记——字符级启发式对「同义改写」召回有限，产品化应用 embedding 或 LLM 二次判重（这不在 PoC 范围）；机制链路（标记 → 提示 → 用户裁决 → 不静默并入）本身完整可用。
   过程中发现并修复一个真实 bug：冲突标记最初写到了内存副本而非磁盘重读的记录，导致 `candidates.jsonl` 落盘丢失（`scripts/extract.mjs` 现对磁盘重读的本批记录跑检测后回写，`lib/review.mjs#appendWithConflictCheck` 同步修复）。

## 三、§11「Memory 进入 MVP」门槛对照

| 门槛 | 结论 | 证据 |
|---|---|---|
| 多 CLI 原生历史可读 | **通过** | claude jsonl 直读 + codex `thread/read` 双 CLI 真实读取并入同一提取（bullet 1/3） |
| 来源可追溯 | **通过** | 每条候选带 `sourceSessionIds` 且经 pipeline 强制校正；accepted 知识文件含完整来源/证据/批次元数据头 |
| 提取审核闭环 | **通过** | 提取（手动触发）→ pending 候选 → 用户 accept/edit/ignore → accepted/ 正式知识；重复提取不覆盖、冲突提示、早期错误不沉淀（bullet 5/6） |

**结论：Memory 可进入 MVP**（手动需求级提取、总结、候选审核与本地检索），前提是保持 PoC 已验证的三条硬边界：仅手动触发、临时 session 隔离、审核终态不可覆盖。

## 四、局限与后续

- 冲突检测为字符 bigram 启发式，同义改写召回有限（见上 0.391 例）；产品化建议 embedding/LLM 判重，并在提取 prompt 中要求候选 claim 复用固定术语。
- 结构化输出依赖 prompt 约束 + JSON 抠取（首跑一次失败：串内未转义引号）；已加「串内禁止英文双引号」硬约束，产品化应加 schema 校验与失败重试（预算内可完成）。
- codex 历史的 `[file-change]` 事件字段未完全展开（item 字段名与预期不符），当前仅保留事件占位，不影响经验提取；正式实现时补齐。
- PoC 未实现 Memory 页面搜索/查看/复制（§7 存储节后半），属 MVP 阶段 4 工作。
