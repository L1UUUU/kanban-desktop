# PoC 2 结果 — Claude Code 原生 Skill 调用与事件观察验证

> 日期：2026-11-05 · 执行人：PoC 2 subagent · 对照计划：`docs/kanban-desktop-v1-plan.md` §2/§3/§4/§8.5/§8.7/§9

## 0. 环境与版本

| 项 | 值 |
|---|---|
| OS | Windows 11 build 26200，shell 为 Git Bash（MSYS 路径转换开启） |
| claude CLI | 2.1.317（全局，npm `bin/claude.exe`）；Agent SDK 包捆绑 2.1.318 |
| 认证 | 用户级 `~/.claude/settings.json` env 提供 `ANTHROPIC_BASE_URL`（内网网关）+ `ANTHROPIC_AUTH_TOKEN`；官方 OAuth 凭证存在但已过期、未使用 |
| 模型 | `glm-5.3[1m]`（经网关映射；init 报 `claude-opus-5-5`/`glm-5.3[1m]`） |
| Node / npm | v24.13.0 / 11.6.2 |
| SDK | @anthropic-ai/claude-agent-sdk 0.3.318 与 0.2.141（均实测） |
| 对照工具 | cc-skill-trace 3.0.0（npm 局部安装）；`skill-audit` 不存在于 npm，仅 `opencode-skill-audit`（面向 OpenCode，未跑） |
| 成本 | 真实模型调用 **9 次**（上限 10），合计约 \$1.35（网关计费口径见 runs/*.jsonl 的 total_cost_usd） |

## 1. A 部分：验收表逐行判定（§9 PoC 2）

| 测试 | 判定 | 证据 |
|---|---|---|
| **Skill 发现** | **PASS** | 每次会话 `system/init` 消息的 `skills` 与 `slash_commands` 数组均含项目级 `design-feature`、`implement-spec`（runs/a1-cli-slash-stream.jsonl、b1-protocol-slash-events-final.json）。发现不依赖 `--setting-sources`。 |
| **Skill 执行（原生而非文本模拟）** | **PASS**（附不确定性发现） | ① assistant 消息出现原生 `tool_use: Skill {skill:"design-feature"}`（a1-cli-slash-stream.jsonl、b1-protocol-slash-events-final.json）；② Skill 工具执行后 CLI 注入展开消息 `Base directory for this skill: <fixture>\.claude\skills\design-feature`——**加载的是项目级 SKILL.md，同名时项目级优先于用户级**（Base directory 为证）；③ 输出恰为 stub 固定文案 `DESIGN-FEATURE-STUB-OK`。发现：非交互模式下 Skill 工具是否被调用由**模型决策**，同一输入多次运行行为不固定（见发现 #2），触发≠100% 确定，但「执行时是原生调用」这一点成立。 |
| **依赖与 Subagent** | **NOT TESTED** | 成本控制决策：stub skill 无依赖链、无子代理设计。skill 展开机制与 Bash/Glob/Read/ToolSearch 等工具在 stream 中可见（a1-cli-slash-native-summary.json 等），但未验证真实 `design-feature` 的澄清/审查依赖。 |
| **Hook/事件（真调用 vs 提及不误判）** | **PASS** | 正例：`PreToolUse(Skill)`+`PostToolUse(Skill)` 精确捕获 `toolInput.skill`、sessionId、transcriptPath、cwd、permissionMode，`PostToolUse.toolResponse={success:true,commandName:"design-feature"}` 可作成功二次确认（fixture/proj/hook-events.jsonl）。反例（a3-cli-mention-neg.jsonl，session dad26de8）：明确要求不执行、文本含 "design-feature" → 输出恰为 `ACK-NOSKILL`、Skill 调用 0 次、hook 中 Skill 事件 0 条。交叉对照：cc-skill-trace 从 transcript 回溯出的 3 次 design-feature 与 hook 捕获**逐 session、逐时间戳吻合**（差<1s，runs/compare-ccst-export.json）。 |
| **自动建卡** | **PASS** | 确定性测试 15/15（tracker/tracker.test.mjs）：未关联 session 首个 verified `design-feature` 建卡；同 eventId 重放幂等；同 session 重复不建新卡；未关联 session 的 implement-spec/pr/retro 不建卡；self_reported 不建卡。真实回放（runs/b2-replay-result.json）：36 行 hook 事件、8 个 session，仅 3 个含 verified Skill 调用的 session 各建 1 卡，其余 5 个 session（含反例、含输入了 `/implement-spec` 但模型未调 Skill 工具的轮次）零误建。 |
| **阶段变化** | **PASS（B 侧全规则）；A 侧仅 Design 实测** | 乱序（旧 design-feature 不覆盖新 implement）、延迟（t20 的 pr 晚到不覆盖 t30 依据）、多 session 并发竞争（最新有效事件胜出，允许 PR→Implement 回退）、手动修正立即生效且可被更新事件覆盖、解除关联不回退、关联时按 skill 实际发生时间比较、occurredAt 不可解析时保留当前阶段并标 `uncertain`——全部用例绿。A 侧说明：`/implement-spec` 轮模型未调用 Skill 工具（直接文本回复，a4-implementspec-summary），故真实事件流中只有 Design 阶段被实测；Implement 阶段信号路径与 Design 完全同构（同一 Skill 工具与 hook）。 |
| **权限（审批不被包装层破坏）** | **PARTIAL** | 已证：`permissionMode=default` 下 Skill 工具不弹审批直接执行（非交互流无法交互审批，CLI 对 Skill 放行）；`--disallowedTools Bash` 生效（模型转用 Glob/Read，ToolSearch 调用被 PreToolUse 记录）；`--permission-mode` 显式参数可覆盖用户 settings 的 `defaultMode`。未证：`canUseTool` 审批回调全链路（因 Agent SDK 库在 Windows 阻塞，见发现 #5）；`--setting-sources project` 隔离用户 settings 会**切断认证 env**（发现 #4），GUI 不能简单用它做隔离。 |
| **工作目录（不被隐式改写）** | **PARTIAL** | 已证：所有轮 `init.cwd` 与 hook `cwd` 均为 fixture/proj，会话内无目录漂移；`--add-dir`/original_cwd 字段正常。未证：真实 `implement-spec` 的 integration branch/worktree 操作（stub 无此行为，成本控制未跑真实 skill）——该项专门列 NOT TESTED 依据见「依赖与 Subagent」。 |

## 2. 关键发现（按对产品的影响排序）

1. **slash dispatch 是 CLI 客户端行为，且被 shell 环境破坏**：`claude -p "/design-feature"` 在 Git Bash 中，位置参数与**环境变量值**都会被 MSYS 转换成 `C:/Program Files/Git/design-feature`；经 stdin 传 prompt 或 `MSYS_NO_PATHCONV=1` 可保原文。原文到达时 CLI 做 slash dispatch——transcript 首条 user 消息变为 `<command-message>design-feature</command-message><command-name>/design-feature</command-name>`（transcript 实证，runs 判别实验）。**GUI 直接以编程方式 spawn CLI/协议发消息，不经 shell，无此问题；但任何经过 shell 的封装层都必须防改写。**
2. **Skill 工具调用由模型决策，非确定性**：4 轮有效 slash 输入中仅 2 轮模型直接调用 Skill 工具；另 2 轮模型先跑 Bash/Glob 调查或直接文本回复（成本 0.18-0.31 的调查轮）。被改写的路径文本反而 2/2 触发了模型调用 Skill（模型自主纠错）。**结论：Kanban 不能以「用户输入了 /skill」推定 skill 已执行，必须以 hook 的 PreToolUse(Skill) 为真相源；输入 slash 但未捕获到 Skill 事件的，落入手动修正路径。**
3. **项目级 skill 优先于用户级同名 skill**：Skill 工具展开的 Base directory 指向 fixture 项目级文件，即便用户全局存在同名 mattpocock 正式版。但同名冲突会让模型行为更不稳定（stdin 轮模型专门停下来报告「重名冲突」）。**建议 GUI 在触发前检测项目级/用户级同名并提示，或产品上要求 skill 名带项目前缀。**
4. **`--setting-sources project` 隔离会切断认证**：本机认证依赖用户 settings 的 env（网关 URL+token）；排除 user 来源后 CLI 回退到过期的 OAuth 并报 `Failed to authenticate: OAuth session expired`。**GUI 的隔离策略必须保留认证所需 env，或显式注入认证配置。**
5. **Agent SDK（npm 包）在 Windows 上 pre-spawn abort**：0.3.318 与 0.2.141 在 Git Bash 与 cmd 下、裸 query、debug:true、`spawnClaudeCodeProcess` 代理各组合均在 spawn 前后失败（"Operation aborted"/"aborted by user"）。判别实验证明：bundled claude.exe 本身正常（`--version`、手动 initialize 握手、Node 直 spawn 全部成功，sdk/spawn-repro.mjs）；失败在 SDK 自身的启动/传输层，与官方仓库同类 Windows issue 吻合（claude-agent-sdk-typescript #359「Windows 下 stream 在首次工具调用后关闭，debug 时消失」、#444「claude.exe 在 Windows segfault 0xC0000005」）。**规避**：按 SDK 同款 wire 协议（`--input-format stream-json` + initialize control_request + user message 行协议）手写传输层（sdk/protocol-client.mjs），单次调用完整跑通 Skill 触发与双路 hook。SDK 的问题需在正式实施前向上游确认或锁定可用版本。
6. **双路事件观察一致**：项目级 `.claude/settings.json` 外部 hook（Node 脚本落盘 JSONL）与 SDK 协议层可注册的进程内 hook 回调（SDKOptions.hooks，0.3.318 类型已验证存在）是同一事件源的两个出口；外部 hook 在协议直连会话中同样触发（b1-final 轮 3 事件齐备）。GUI 任选其一即可，建议外部 hook（与 CLI 版本解耦）。
7. **UserPromptSubmit hook 捕获用户原始输入**：可用于识别「用户输入了 slash 但未发生 Skill 调用」的缺口场景（如反例轮与 implement-spec 轮），支撑「PARTIAL 时允许手动修正」的产品规则。
8. **cc-skill-trace 可作独立对照**：transcript 回溯扫描（`scan`）与实时 hook 结果一致；其 auto/user 触发分类、`injectedTokens`、gitBranch 元数据可借鉴；其 `triggerMessage` 抓取有噪声（抓到 system-reminder 开头而非真正触发消息），不能替代 hook。`skill-audit` 不在 npm（仅 `opencode-skill-audit`，面向 OpenCode），文档级记录。
9. **hook 脚本 Windows 细节**：`$CLAUDE_PROJECT_DIR` 在 hook 命令（bash 语义）中可用；Node hook 脚本读 stdin 必须用异步迭代（同步 readSync(0) 在 Windows 管道下拿到空数据，首版失败原因）。

## 3. B 部分：tracker 状态机测试结果

```text
$ cd tracker && node --test
ℹ tests 15  ℹ pass 15  ℹ fail 0
```

用例覆盖：首次建卡 / 重复不建卡 / eventId 重放幂等 / 非建卡 skill 不建卡 / self_reported 不建卡 / 乱序旧事件不覆盖 / 同内容重放不改阶段 / 多 session 并发竞争与 PR→Implement 回退 / 手动修正立即生效且新事件可覆盖旧事件不可 / 解除关联不回退 / 关联时按实际发生时间同步 / occurredAt 缺失标 uncertain / self_reported 只记活动 / transformHookEvents 归一化 / SKILL_STAGE 映射。

端到端回放（真实数据）：`node scripts/replay.mjs` → 36 行 hook 事件、8 session、3 个 verified Skill 事件 → 恰好 3 张 Design 卡（REQ-001/002/003，各绑定一个 session，basis 含 skill 实际发生时间），5 个无 Skill 调用的 session（反例提及、未触发轮）零误建。结果存 runs/b2-replay-result.json。

## 4. 结论与建议（对照 §11 门槛）

| §11 门槛要求 | 达成情况 |
|---|---|
| Skill 真调用留证 | **达成**：原生 Skill tool_use + 项目级展开 + stub 输出 + hook 双事件（4 类独立证据互相印证） |
| 可观察、无误报 | **达成**：PreToolUse(Skill) 为真相源；反例 0 误报；cc-skill-trace 独立回溯一致 |
| 去重与旧事件处理通过 | **达成**：15/15 用例 + 真实回放 |
| 观察信号标注证据等级 | **达成**：tracker 按 `verified`（hook 确认）/`self_reported` 分级，self_reported 只记活动不驱动阶段 |
| 缺口明确标 PARTIAL、允许手动修正 | **执行**：权限审批回调链路、真实 skill 依赖链、worktree 行为三项 PARTIAL/NOT TESTED；tracker 的手动修正路径即兜底 |

**总体判定：PoC 2 通过（核心链路 PASS，三项非核心项 PARTIAL/NOT TESTED）。**

给架构落地的主要输入：
1. Claude Adapter 的事件观察以项目级 hook（外部脚本/SDK hooks 二选一）+ JSONL 落盘为基线，Requirement Tracker 消费归一化事件流（tracker.mjs 规则可直接演进为产品实现）。
2. GUI 触发 skill 用编程 spawn（不经 shell）+ 协议发消息；「输入 slash」与「Skill 已执行」是两个事件，UI 不得合并展示。
3. 正式实施前需解决：Agent SDK Windows 可用版本（或以协议直连为 Claude Adapter 传输层基线）；同名 skill 冲突的产品策略；认证 env 的注入策略。

## 5. 轮次清单（复现索引）

| 轮次 | 方式 | session | 结果 | 证据文件 |
|---|---|---|---|---|
| 0 | CLI 参数 slash（认证失败） | 1ac866f0 | OAuth 过期（隔离 user settings 所致，发现 #4） | runs/a1-cli-slash-stream.jsonl 首轮覆盖前 stderr |
| 1 | CLI 参数 slash（MSYS 改写→模型自主调 Skill） | fecb83a2 | stub 输出，cost 0.111 | runs/a1-cli-slash-stream.jsonl |
| 2 | 同上（完整 hook 捕获） | 2fab6393 | 3 hook 事件，cost 0.063 | runs/a1-cli-slash-stream-final.jsonl、hook-events-model-autonomous.jsonl |
| 3 | `MSYS_NO_PATHCONV=1`（dispatch 生效，模型调查未调 Skill） | a8e88321 | cost 0.312 | runs/a1-cli-slash-native-summary.json |
| 4 | stdin slash（dispatch 生效，模型报告重名冲突） | 9c30a6f9 | cost 0.278 | runs/a1-cli-slash-stdin-summary.json |
| 5 | stdin slash + 禁 Bash（模型 Glob/Read 调查） | ef0f5d22 | cost 0.183 | runs/a2-cli-slash-clean-summary.json |
| 6 | 反例：普通文本提及 + 明确不执行 | dad26de8 | ACK-NOSKILL，0 Skill，cost 0.038 | runs/a3-cli-mention-neg.jsonl |
| 7 | stdin `/implement-spec`（未调 Skill，直接文本回复） | efbd8316 | cost 0.177 | runs/a4-cli-implementspec-summary.json |
| 8 | 协议直连 `/design-feature` | e62a3618 | initialize→Skill→stub，cost 0.140 | sdk/protocol-client.mjs |
| 9 | 协议直连正式轮（env 传 prompt 仍被 MSYS 改写，模型纠正） | 05b0533e | 全链路 + 双路 hook，cost 0.057 | runs/b1-protocol-slash-events-final.json |
