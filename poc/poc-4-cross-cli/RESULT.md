# PoC 4 结果 — 跨 CLI 需求链路验证

> 日期：2026-11-05 · 执行人：PoC 4 subagent · 对照计划：`docs/kanban-desktop-v1-plan.md` §3/§4/§8.5/§9 PoC 4/§11/§13.7

## 0. 环境与版本

| 项 | 值 |
|---|---|
| OS | Windows 11 build 26200，Git Bash |
| Node | v24.13.0（内置 `node:sqlite`，运行时 ExperimentalWarning，功能正常） |
| claude CLI | 2.1.317（npm 全局，直连 `bin/claude.exe`；认证经用户级网关 env） |
| codex CLI | 0.144.1（npm 全局，直连 `codex.exe`，模型 `gpt-5.6-luna`，均为 poc-1 结论） |
| opencode | **1.19.5 真实调用**（npm 全局 `opencode.exe`，`serve` HTTP API + SSE；provider 为 magpie 本地网关，从用户全局 opencode.json **只读复制注入**隔离 fixture，密钥不入库不落日志——注入模式复制自 poc-3；模型 `magpie/192-168-4-61-3000/asw_glm-5.3`，modelID 自带斜杠按第一个斜杠切分） |
| 依赖 | 零 npm 依赖（SQLite 用 Node 内置） |
| 成本 | **重跑轮（真实三 CLI）**：4 次一句话级调用（Claude ×2 + Codex turn ×1 + OpenCode command ×1，runs/e2e-main.json `modelCalls`；另有 1 次失败运行耗 2 次——OpenCode serve 参数误用致 server 未启动，S1/S2 已耗，本轮任务累计 6 次顶格）。首轮（OpenCode 合成时期）：成功链路 3 次 + 调试约 5 次 |

## 1. 验收场景判定表（§9 PoC 4）

| # | 场景 | 判定 | 证据摘要（完整证据：`runs/e2e-main.json` 25 checks、`runs/e2e-restart.json` 7 checks，全部 PASS） |
|---|---|---|---|
| 1 | 自由 Claude Session 调 `design-feature` → 自动建卡 REQ-001 | **PASS** | 真实链路：编程 spawn claude.exe（stdin 传 `/design-feature`）→ 原生 sessionId `6abd778a` → 项目级 hook 捕获 `PreToolUse(Skill){skill:"design-feature"}` 且 `PostToolUse success:true`（runs/hook-events-evidence.jsonl）→ tracker 自动建 REQ-001、阶段 Design、关联该 session、uncertain=false；同 eventId 重复注入 → 零变化（幂等） |
| 2 | 从 REQ-001 创建 Codex Session 自动关联；手动调用 `implement-spec` | **PASS**（self_reported 分级处理，见 §2） | 真实链路：app-server `thread/start`（cwd=fixture/workdir）→ threadId `01a1aa43` → GUI link 事件自动关联 → 真实 `turn/start`（输入含 `/implement-spec`）→ `turn/completed`，答复 `IMPLEMENT-TURN-OK` → 由「用户提交 + turn 真实开始/完成」构造 `self_reported` 事件（occurredAt=协议 turn.startedAt epoch 秒转 ISO，seq=turnId）→ 阶段 Implement + **uncertain=true** → GUI confirm（manual）→ uncertain 转正 false |
| 3 | OpenCode Session 先执行阶段 Skill 后手动关联，按实际发生顺序同步 | **PASS（真实 OpenCode）** | 真实链路：XDG 隔离 fixture 启动 `opencode serve`（provider 只读注入）→ 原生 session `ses_e557894b` → `POST /session/{id}/command {command:"pr"}` 同步 200 + turn 真实完成（SSE session.idle）+ 输出含项目级 stub 文案（PR-STUB-OK，证明执行的是项目级 `.opencode/skill/pr`）→ self_reported 事件（occurredAt=command 提交时刻）：未关联时只记活动不建卡；手动 link 后按 skill **实际发生时间**与当前依据比较同步到 PR（link 时间不冒充依据），uncertain=true。规则分支（早于依据不覆盖、无依据初始化、link 冲突拒绝）由确定性测试覆盖 |
| 4 | 手动修正后新有效事件覆盖；重复/重放/延迟不覆盖；多 Session 最新有效胜出 | **PASS** | 手动修正 → Retro 立即生效；**真实** Claude Session D（第二个真实会话）hook verified `implement-spec`（时间晚于修正）→ 覆盖 → Implement、uncertain=false；同 eventId 重放注入 → duplicate_ignored；occurredAt 早于依据的新事件 → stale 不覆盖；混合流（Claude A + Codex + OpenCode + Claude D 四个真实 session 关联 REQ-001）中最新有效事件胜出，且 PR→Implement 回退被允许 |
| 5 | 解除关联不删历史不回退；退出重开后全部正确 | **PASS** | unlink 后阶段保持 Implement、session 从卡片移除、`stage_events` 历史仍可查（该 session 5 条）；主进程退出 → `--verify-restart` **新进程**仅凭 SQLite 恢复：卡片编号/阶段（Implement）/uncertain/关联 sessions 全一致，重放真实 hook 事件（同 eventId）幂等，13 条历史完整（verified 8 / self_reported 2 / simulated 3），恢复后新事件仍正常驱动 |

**确定性测试**：`node --test tracker/tracker.test.mjs` → **21/21 通过**，覆盖建卡（verified-only、重放幂等、非建卡 skill、self_reported/simulated 不建卡）、self_reported 驱动+转正+stale、关联同步（晚于/早于依据、无依据初始化、冲突拒绝、重启后仍可用、**OpenCode self_reported 真实源路径镜像**）、修正覆盖/锁定解除/乱序/延迟/回退/不可解析时间标 uncertain、解除关联、持久化往返与恢复后建卡编号连续。

**DB 终态快照**（runs/e2e-main.json `tables`）：

```text
requirements: REQ-001 待命名需求 stage=Implement uncertain=1(basis 为 S4 simulated 并发注入事件)
sessions:     803fb517(claude-code, 已解除关联) 01a1aa86(codex→REQ-001)
              ses_e557894b(opencode→REQ-001) 98074da3(claude-code→REQ-001)
stage_events: 13 条（verified 8 / self_reported 2 / simulated 3）
```

## 2. 证据分级策略结论（本 PoC 回答的设计问题）

归一化事件统一携带 `evidenceLevel: verified | self_reported | simulated`（`lib/schema.mjs`），tracker 按级处理：

| 等级 | 定义 | 建卡 | 驱动阶段 | uncertain |
|---|---|---|---|---|
| verified | CLI 原生 hook/事件流确认的 Skill 真调用（Claude `PreToolUse(Skill)`，PostToolUse success 二次确认） | 允许（唯一） | 直接驱动 | false |
| self_reported | GUI/API 可观察「用户提交了 skill/command 且 turn 真实开始/完成」，但 CLI 无 skill 语义的独立验证（Codex turn、OpenCode command API 均属此级） | 禁止 | **驱动** | **true** |
| simulated | 合成/规则注入事件（本 PoC 仅用于场景 4 的乱序/延迟/并发注入；首轮曾代替 OpenCode 真实源，重跑后已退役为纯注入用途） | 禁止 | **驱动** | **true** |

**self_reported 的处理选了「驱动阶段但标 uncertain 待确认」，而非 poc-2 的「只记活动不驱动」。理由：**

1. **信息不完整但不是零**——Codex turn 的 `turn/started`/`turn/completed` 与用户提交是 GUI 持有的两个可观察事实，「时间」与「用户意图」可信，唯一不可信的是「skill 语义是否真达成」；只记活动会丢弃可信的时间信息。
2. **完全降级到手动会让 Codex 的自动阶段识别永久失效**——Codex 是三 CLI 之一且无 per-turn hook 是结构性缺口（非 bug），若 self_reported 不驱动，混合流中「自动 Skill 阶段识别」对 Codex 永远不可用，§11 门槛直接失败。
3. **uncertain 把不可信部分显式暴露而非隐藏**——UI 展示「阶段 Implement（待确认）」，用户一键确认（manual confirm 事件）或后续 verified 事件即可转正（两条路径均已实测：S2 confirm 转正、S4 verified 覆盖转正）。这与 §4「无法可靠排序时保留当前阶段并记录不确定性」同一精神：降可信度，不丢事件。
4. **建卡仍只信 verified**——建卡产生新对象（副作用更大），synthetic/self_reported 的 `design-feature` 一律不建卡（确定性测试覆盖），防止合成流与自报流污染卡片集合。

**排序规则与证据等级正交**：所有事件按 `occurredAt`（skill 实际发生时间）与当前阶段依据比较，旧事件不覆盖、最新有效事件胜出、允许回退——该规则不区分证据等级；等级只影响「是否建卡」与「uncertain 标注」。GUI 自身动作（link/unlink/manual）的 evidenceLevel 恒为 verified（GUI 是自己动作的真相源）。

**真实源重跑后的分级再确认（新证据）：** 三 CLI 真实跑通后，self_reported 的可观察信号强度并不相同——Codex 是「turn 真实开始/完成」（skill 语义完全黑盒）；OpenCode 是「command 名义执行 + 同步 200 + turn 完成 + 输出可回读项目级 stub 文案」（`POST /session/{id}/command` 显式以 command 名执行，语义半白盒）。两者落在同一等级、同一处理路径（驱动 + uncertain），差异只体现在 source 字段与 UI 可展示的佐证强度。这印证分级设计的核心判断：**等级按「CLI 是否提供 skill 语义的独立验证」划分（verified/非 verified），而非按信号强度细分**——进一步细分（如 OpenCode 升 verified）会把「command 被执行」误当成「skill 目标已达成」，而 OpenCode 的 command 机制实际是把 SKILL.md 内容注入 prompt 由模型自由发挥（见 §4 新发现），并无独立完成校验。

## 3. 对照 §11 门槛判断

| 门槛 | 判断 | 依据 |
|---|---|---|
| **自动 Skill 阶段识别** | **达成（分级口径）**：Claude verified 全自动；Codex/OpenCode 类 self_reported/事件流事件「自动驱动 + uncertain 标注 + 手动确认兜底」；§4 预留的手动修正路径实测可用（立即生效、不永久锁定、可被新事件覆盖） | 真调用留证（hook 双事件）、可观察无误报（poc-2 反例 + 本 PoC hook 链路）、去重/旧事件处理（20 用例 + 真实重放注入）、证据等级标注（schema 强制）四项证据齐备。若把门槛读成「三 CLI 全部 verified 零人工」，则 Codex 结构性不满足（无 per-turn hook）——但这正是分级的意义：缺口显式化而非伪装 |
| **统一 Worker** | **必要条件达成，非充分**：三 CLI 真实 Adapter（Claude spawn + hook 文件、Codex app-server JSON-RPC、OpenCode HTTP/SSE server）与 Requirement Tracker 在**单一 Node 宿主**内共存并正确处理交错事件流（run-e2e 主进程即一个 Worker 雏形，全程真实源）；跨 CLI 时钟用实际发生时间比较 + uncertain 兜底（§13.7 风险的落地形态） | 进程管理维度（多 CLI 并发进程停止、异常隔离、Windows 进程树）属 PoC 1/3 范围未在本 PoC 重测；本 PoC 证明事件归一化层与单宿主共存无结构性障碍 |

## 4. 关键实现事实（给正式实施的输入）

1. **归一化事件流是唯一接缝**：三个 CLI 的观察信号全部转换为 `{eventId, kind, sessionId, cli, skill, occurredAt, receivedAt, seq, evidenceLevel, source}` 后进入同一 tracker；新增 CLI 只需写 adapter + 事件转换，tracker 与存储零改动。
2. **`eventId` 幂等由 SQLite 主键兜底**：hook 事件用 `hook:{session}:{skill}:{capturedAt}`，Codex turn 用 `codex-turn:{thread}:{skill}:{turnId}`——真实重放注入（重启前后各一次）均 duplicate_ignored。
3. **关联后同步用「session 已见事件缓存」**：tracker 缓存每个 session 的全部 skill 事件（含未关联时记录的），link 时取时间最新一条与当前依据比较；缓存随持久化往返（重启后 link 同步仍可用，测试覆盖）。不能简单重放事件原文——同 eventId 会被幂等层拦截。
4. **`node:sqlite` 足够 PoC 与 MVP 起步**：三表 + `INSERT OR IGNORE` 幂等 + 全量状态导出，零依赖；ExperimentalWarning 已记录，正式实施可评估 better-sqlite3 或继续内置。
5. **OpenCode 真实接入要点**（注入模式复制自 poc-3）：XDG_* 四变量重定向实现配置/数据隔离；provider（含 apiKey）从用户全局 opencode.json **只读复制**注入隔离 fixture（密钥不入库不落日志，fixture 内 .gitignore 排除）；`POST /session/{id}/command` 的 `model` 字段传**完整字符串** `providerID/modelID`（与 prompt_async 的对象形状不同），modelID 自带斜杠按第一个切分；turn 终态以 SSE `session.idle` 为准（message.updated 无 status 字段）；server 参数用 poc-3 原样组合（自创 `--log-level warn` 会导致 serve 打印 usage 拒启，实测踩坑）。
6. **新发现——OpenCode 的 skill 执行机制与 Claude 不同，印证分级必要性**：OpenCode command 执行是把 SKILL.md **内容作为 prompt 注入**由模型自由发挥（实测输出为复述 stub 文档后带出 PR-STUB-OK），没有 Claude 那样的原生 Skill 工具调用 + PreToolUse/PostToolUse hook 可观察闭环。因此「command 名被真实执行」（可观察）≠「skill 指令被模型遵循」（不可独立验证）——OpenCode 稳定落在 self_reported 级，不能因输出「看起来执行了」就升 verified。同名 skill 干扰在 OpenCode 侧同样存在（用户全局 `~/.claude/skills` 等会被扫描，poc-3 发现），本 PoC 用项目级 stub + 输出回读验证优先级。
7. **踩坑记录**：`claude -p` 从 stdin 读 prompt 必须写到 **EOF**（`stdin.end()`）才处理；Codex 协议 `turn.startedAt` 是 **epoch 秒**（数字）需转 ISO；模型是否调用 Skill 工具是模型决策且受本机用户级同名 skill 干扰（poc-2 发现 #2/#3 复现，重试与显式指令后成功）——GUI 触发 Skill 应是确定性编程行为，不能依赖模型自觉。

## 5. 阻塞与限制

| 项 | 状态 | 说明 |
|---|---|---|
| ~~OpenCode 真实事件流~~ | **已解除（重跑完成）** | 首轮曾因 oauth 凭据过期用合成事件；用户接入 magpie provider 后（poc-3 补跑 69e9920），本轮已用真实 `opencode serve` + command API + magpie 模型重跑场景 3，simulated 退役为纯规则注入用途 |
| 模型调用非确定性 | 已缓解 | stub skill 需显式指令才稳定触发 Skill 工具（详见 §4.7）；run-e2e 内置重试与 fail-fast |
| 真实 `implement-spec`/`pr`/`retro` 完整行为 | 未验证（超范围） | 本 PoC 用 stub 验证链路，skill 内部行为（worktree、PR 创建）不在 PoC 4 范围（§2 计划明确不可由 Skill 名称推断完成状态） |
| GUI | 未实现 | PoC 4 无 UI；「GUI 可观察信号」以 adapter 的编程观察等价替代（turn 通知、hook 文件读取、command API 响应） |

**总体判定：PoC 4 通过（5 场景全 PASS，三 CLI 全部真实事件源）。**
