# PoC 4 结果 — 跨 CLI 需求链路验证

> 日期：2026-11-05 · 执行人：PoC 4 subagent · 对照计划：`docs/kanban-desktop-v1-plan.md` §3/§4/§8.5/§9 PoC 4/§11/§13.7

## 0. 环境与版本

| 项 | 值 |
|---|---|
| OS | Windows 11 build 26200，Git Bash |
| Node | v24.13.0（内置 `node:sqlite`，运行时 ExperimentalWarning，功能正常） |
| claude CLI | 2.1.317（npm 全局，直连 `bin/claude.exe`；认证经用户级网关 env） |
| codex CLI | 0.144.1（npm 全局，直连 `codex.exe`，模型 `gpt-5.6-luna`，均为 poc-1 结论） |
| opencode | **未使用真实 CLI**——OpenAI oauth 凭据过期（poc-3 已证需交互式重新登录，subagent 不代做），本 PoC 该分支用**合成事件**喂入同一归一化事件流，全部标注 `simulated` |
| 依赖 | 零 npm 依赖（SQLite 用 Node 内置） |
| 成本 | 成功链路真实模型调用 **3 次**（Claude ×2 + Codex turn ×1，一句话级，runs/e2e-main.json `modelCalls`）；含调试重试全程约 8 次调用（stdin EOF bug 修复 1 次超时、模型未调 Skill 工具重试 3 次、epoch 时间戳 bug 重跑 2 次），均在 ≤8 次预算约束内按上限如实记录 |

## 1. 验收场景判定表（§9 PoC 4）

| # | 场景 | 判定 | 证据摘要（完整证据：`runs/e2e-main.json` 22 checks、`runs/e2e-restart.json` 7 checks，全部 PASS） |
|---|---|---|---|
| 1 | 自由 Claude Session 调 `design-feature` → 自动建卡 REQ-001 | **PASS** | 真实链路：编程 spawn claude.exe（stdin 传 `/design-feature`）→ 原生 sessionId `6abd778a` → 项目级 hook 捕获 `PreToolUse(Skill){skill:"design-feature"}` 且 `PostToolUse success:true`（runs/hook-events-evidence.jsonl）→ tracker 自动建 REQ-001、阶段 Design、关联该 session、uncertain=false；同 eventId 重复注入 → 零变化（幂等） |
| 2 | 从 REQ-001 创建 Codex Session 自动关联；手动调用 `implement-spec` | **PASS**（self_reported 分级处理，见 §2） | 真实链路：app-server `thread/start`（cwd=fixture/workdir）→ threadId `01a1aa43` → GUI link 事件自动关联 → 真实 `turn/start`（输入含 `/implement-spec`）→ `turn/completed`，答复 `IMPLEMENT-TURN-OK` → 由「用户提交 + turn 真实开始/完成」构造 `self_reported` 事件（occurredAt=协议 turn.startedAt epoch 秒转 ISO，seq=turnId）→ 阶段 Implement + **uncertain=true** → GUI confirm（manual）→ uncertain 转正 false |
| 3 | OpenCode Session 先执行阶段 Skill 后手动关联，按实际发生顺序同步 | **PASS（规则）**／该分支**未用真实 CLI**（合成事件，标注 simulated） | 合成链路：OpenCode session `ses_opencode_sim_0001` 先发生 `pr` 事件（未关联 → 只记活动不建卡不改阶段）→ 之后手动 link → tracker 按 skill **实际发生时间**（t5）与当前依据（t3）比较同步到 PR，link 时间（t6）不冒充依据；simulated 依据 → uncertain=true。规则分支（早于依据不覆盖、无依据可初始化、link 冲突拒绝）由确定性测试覆盖 |
| 4 | 手动修正后新有效事件覆盖；重复/重放/延迟不覆盖；多 Session 最新有效胜出 | **PASS** | 手动修正 → Retro 立即生效；**真实** Claude Session D（第二个真实会话）hook verified `implement-spec`（时间晚于修正）→ 覆盖 → Implement、uncertain=false；同 eventId 重放注入 → duplicate_ignored；occurredAt 早于依据的新事件 → stale 不覆盖；多 Session（Claude A + Codex + OpenCode sim + Claude D）混合证据流中最新有效事件胜出，且 PR→Implement 回退被允许 |
| 5 | 解除关联不删历史不回退；退出重开后全部正确 | **PASS** | unlink 后阶段保持 Implement、session 从卡片移除、`stage_events` 历史仍可查（该 session 4 条）；主进程退出 → `--verify-restart` **新进程**仅凭 SQLite 恢复：卡片编号/阶段（Implement）/uncertain/关联 sessions 全一致，重放真实 hook 事件（同 eventId）幂等，13 条历史完整（verified 8 / self_reported 1 / simulated 4），恢复后新事件仍正常驱动 |

**确定性测试**：`node --test tracker/tracker.test.mjs` → **20/20 通过**，覆盖建卡（verified-only、重放幂等、非建卡 skill、self_reported/simulated 不建卡）、self_reported 驱动+转正+stale、关联同步（晚于/早于依据、无依据初始化、冲突拒绝、重启后仍可用）、修正覆盖/锁定解除/乱序/延迟/回退/不可解析时间标 uncertain、解除关联、持久化往返与恢复后建卡编号连续。

**DB 终态快照**（runs/e2e-main.json `tables`）：

```text
requirements: REQ-001 待命名需求 stage=Implement uncertain=1(basis 为 simulated 并发事件)
sessions:     6abd778a(claude-code, 已解除关联) 01a1aa43(codex→REQ-001)
              ses_opencode_sim_0001(opencode→REQ-001) d1318afc(claude-code→REQ-001)
stage_events: 13 条（verified 8 / self_reported 1 / simulated 4）
```

## 2. 证据分级策略结论（本 PoC 回答的设计问题）

归一化事件统一携带 `evidenceLevel: verified | self_reported | simulated`（`lib/schema.mjs`），tracker 按级处理：

| 等级 | 定义 | 建卡 | 驱动阶段 | uncertain |
|---|---|---|---|---|
| verified | CLI 原生 hook/事件流确认的 Skill 真调用（Claude `PreToolUse(Skill)`，PostToolUse success 二次确认） | 允许（唯一） | 直接驱动 | false |
| self_reported | GUI 可观察「用户提交了 /skill 且 turn 真实开始/完成」，但 CLI 无 per-turn hook（Codex，§8.5 实证） | 禁止 | **驱动** | **true** |
| simulated | 合成/未接真实事件源的替代事件（本 PoC OpenCode 凭据阻塞） | 禁止 | **驱动** | **true** |

**self_reported 的处理选了「驱动阶段但标 uncertain 待确认」，而非 poc-2 的「只记活动不驱动」。理由：**

1. **信息不完整但不是零**——Codex turn 的 `turn/started`/`turn/completed` 与用户提交是 GUI 持有的两个可观察事实，「时间」与「用户意图」可信，唯一不可信的是「skill 语义是否真达成」；只记活动会丢弃可信的时间信息。
2. **完全降级到手动会让 Codex 的自动阶段识别永久失效**——Codex 是三 CLI 之一且无 per-turn hook 是结构性缺口（非 bug），若 self_reported 不驱动，混合流中「自动 Skill 阶段识别」对 Codex 永远不可用，§11 门槛直接失败。
3. **uncertain 把不可信部分显式暴露而非隐藏**——UI 展示「阶段 Implement（待确认）」，用户一键确认（manual confirm 事件）或后续 verified 事件即可转正（两条路径均已实测：S2 confirm 转正、S4 verified 覆盖转正）。这与 §4「无法可靠排序时保留当前阶段并记录不确定性」同一精神：降可信度，不丢事件。
4. **建卡仍只信 verified**——建卡产生新对象（副作用更大），synthetic/self_reported 的 `design-feature` 一律不建卡（确定性测试覆盖），防止合成流与自报流污染卡片集合。

**排序规则与证据等级正交**：所有事件按 `occurredAt`（skill 实际发生时间）与当前阶段依据比较，旧事件不覆盖、最新有效事件胜出、允许回退——该规则不区分证据等级；等级只影响「是否建卡」与「uncertain 标注」。GUI 自身动作（link/unlink/manual）的 evidenceLevel 恒为 verified（GUI 是自己动作的真相源）。

## 3. 对照 §11 门槛判断

| 门槛 | 判断 | 依据 |
|---|---|---|
| **自动 Skill 阶段识别** | **达成（分级口径）**：Claude verified 全自动；Codex/OpenCode 类 self_reported/事件流事件「自动驱动 + uncertain 标注 + 手动确认兜底」；§4 预留的手动修正路径实测可用（立即生效、不永久锁定、可被新事件覆盖） | 真调用留证（hook 双事件）、可观察无误报（poc-2 反例 + 本 PoC hook 链路）、去重/旧事件处理（20 用例 + 真实重放注入）、证据等级标注（schema 强制）四项证据齐备。若把门槛读成「三 CLI 全部 verified 零人工」，则 Codex 结构性不满足（无 per-turn hook）——但这正是分级的意义：缺口显式化而非伪装 |
| **统一 Worker** | **必要条件达成，非充分**：多 CLI Adapter（Claude spawn + hook 文件、Codex app-server JSON-RPC、合成 OpenCode）与 Requirement Tracker 在**单一 Node 宿主**内共存并正确处理交错事件流（run-e2e 主进程即一个 Worker 雏形）；跨 CLI 时钟用实际发生时间比较 + uncertain 兜底（§13.7 风险的落地形态） | 进程管理维度（多 CLI 并发进程停止、异常隔离、Windows 进程树）属 PoC 1/3 范围未在本 PoC 重测；本 PoC 证明事件归一化层与单宿主共存无结构性障碍 |

## 4. 关键实现事实（给正式实施的输入）

1. **归一化事件流是唯一接缝**：三个 CLI 的观察信号全部转换为 `{eventId, kind, sessionId, cli, skill, occurredAt, receivedAt, seq, evidenceLevel, source}` 后进入同一 tracker；新增 CLI 只需写 adapter + 事件转换，tracker 与存储零改动。
2. **`eventId` 幂等由 SQLite 主键兜底**：hook 事件用 `hook:{session}:{skill}:{capturedAt}`，Codex turn 用 `codex-turn:{thread}:{skill}:{turnId}`——真实重放注入（重启前后各一次）均 duplicate_ignored。
3. **关联后同步用「session 已见事件缓存」**：tracker 缓存每个 session 的全部 skill 事件（含未关联时记录的），link 时取时间最新一条与当前依据比较；缓存随持久化往返（重启后 link 同步仍可用，测试覆盖）。不能简单重放事件原文——同 eventId 会被幂等层拦截。
4. **`node:sqlite` 足够 PoC 与 MVP 起步**：三表 + `INSERT OR IGNORE` 幂等 + 全量状态导出，零依赖；ExperimentalWarning 已记录，正式实施可评估 better-sqlite3 或继续内置。
5. **踩坑记录**：`claude -p` 从 stdin 读 prompt 必须写到 **EOF**（`stdin.end()`）才处理；Codex 协议 `turn.startedAt` 是 **epoch 秒**（数字）需转 ISO；模型是否调用 Skill 工具是模型决策且受本机用户级同名 skill 干扰（poc-2 发现 #2/#3 复现，重试与显式指令后成功）——GUI 触发 Skill 应是确定性编程行为，不能依赖模型自觉。

## 5. 阻塞与限制

| 项 | 状态 | 说明 |
|---|---|---|
| OpenCode 真实事件流 | **阻塞（沿 poc-3 结论）** | OpenAI oauth 凭据过期需交互式 `opencode login`（用户操作）；场景 3 以合成事件验证规则分支，`simulated` 标注全程保留；凭据恢复后可用 poc-3 的 SSE 事件形状直接替换合成源（事件 schema 已对齐） |
| 模型调用非确定性 | 已缓解 | stub skill 需显式指令才稳定触发 Skill 工具（详见 §4.5）；run-e2e 内置重试与 fail-fast |
| 真实 `implement-spec`/`pr`/`retro` 完整行为 | 未验证（超范围） | 本 PoC 用 stub 验证链路，skill 内部行为（worktree、PR 创建）不在 PoC 4 范围（§2 计划明确不可由 Skill 名称推断完成状态） |
| GUI | 未实现 | PoC 4 无 UI；「GUI 可观察信号」以 adapter 的编程观察等价替代（turn 通知、hook 文件读取） |

**总体判定：PoC 4 通过（5 场景全 PASS；OpenCode 分支为合成事件，已明确标注）。**
