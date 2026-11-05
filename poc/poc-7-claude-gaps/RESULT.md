# PoC 7 结果 — Claude Code 补验（审批回调 / 取消 Turn / 跨重启 resume / hook 会话级注入）

> 日期：2026-11-05 · 执行人：PoC 7 subagent · 动因：PoC 1-6 后独立审查发现四项能力无证据但产品契约当作三 CLI 一致行为

## 0. 环境与版本

| 项 | 值 |
|---|---|
| OS | Windows 11 build 26200 |
| claude CLI | 2.1.317（npm 全局 `bin/claude.exe`，编程 spawn 直连不经 shell） |
| 认证 | 用户级 settings env（内网网关 `ANTHROPIC_BASE_URL` + token）；模型 `glm-5.3[1m]`（网关映射，init 报同值） |
| 传输层 | stream-json 行协议直连（`--input-format stream-json` + initialize 控制请求），演进自 poc-2 protocol-client.mjs，本 PoC 扩展为持久多轮客户端（lib/client.mjs） |
| 干净前提 | 真实 `~/.claude/settings.json` 含 skill-hub telemetry 等 hook（不可改动用户文件），故用 `CLAUDE_CONFIG_DIR` 重定向至运行时生成的干净配置（仅 env+model，无 hooks/permissions，见 lib/common.mjs）——同时构成 T6 的用户级叠加基座 |
| 成本 | 7 个会话进程、13 轮模型调用（含 1 轮脚本 bug 浪费、1 轮模型决策重试），合计约 \$0.52（各会话末轮 total_cost_usd 之和，会话内该值为累计口径） |

## 1. 验收表

| # | 测试 | 判定 | 证据 |
|---|---|---|---|
| T1 | 持久多轮 | **PASS** | 单进程 3 轮连发（埋暗号→数数→续问），全部 result(session_id=683f6d8d) 一致且 subtype=success；轮 3 精确复现轮 1 暗号「紫鲸7号」（logs/t1t2-raw-stream.jsonl、t1t2-result.json，判定经 analyze-t1t2.mjs 从原始流重算） |
| T2 | 取消 Turn | **PASS** | 数数轮收到首批 delta 后发 `control_request{subtype:"interrupt"}`：CLI 回 control_response(success) 确认；interrupt 之后 **0 个 text delta**（输出停在「3」）；被中断轮以 `result(subtype=error_during_execution, is_error=true, num_turns=2)` 终止；同会话轮 3 正常续答暗号（同上证据） |
| T3 | 审批请求 | **PASS**（附前提条件） | 前提：spawn 参数 `--permission-prompt-tool=stdio`（SDK canUseTool 的实际接线，见发现 1）。带 flag：`can_use_tool` 控制请求流出（tool_name=Bash、完整 input、permission_suggestions 含 addRules/addDirectories 选项），回 `{behavior:"allow"}` 后文件真实创建且内容正确，回 `{behavior:"deny",message}` 后文件不存在、模型收到拒绝原因（logs/t3-result.json approvals 字段、t3-raw-stream.jsonl）。**不带 flag（默认）实测不流审批请求**：Bash 重定向/Write 均被自动拒绝（tool_result is_error「needs approval...you haven't granted」），模型自述被权限模式拦截（logs/t3-noflag-result.json）——这是 capabilities 口径的关键证据，非测试失败 |
| T4 | 跨重启 resume | **PASS** | 进程 A（session e43da4cd）埋暗号后 stdin 关闭自然退出（exit 0）；进程 B 以 `--resume e43da4cd...` + stream-json initialize 握手续问，result.session_id 与 A 一致（--resume 不换 id），回复精确复现「琥珀象9号」，subtype=success（logs/t4-result.json、t4a/t4b-raw-stream.jsonl） |
| T5 | hook 会话级注入 | **PASS** | 干净前提成立（fixture/proj 无 .claude/settings.json、重定向用户级无 hooks，运行时断言）；仅经 spawn 参数 `--settings <file>` 注入 PreToolUse/PostToolUse hook：Skill 真调用后 hook-events.jsonl 捕获 `PreToolUse(Skill)`+`PostToolUse(Skill)`（toolInput.skill=design-feature，PostToolUse.toolResponse.success=true，sessionId=9e079606）；反例（文本提及+明确不执行）零 Skill 事件（logs/t5t6-result.json 首轮反例 + t5t6-retry-result.json 正例、t5-inject-settings.json） |
| T6 | 认证叠加 | **PASS** | 注入 settings 存在的同一会话：认证正常（两轮 success，无认证错误，网关计费正常产出）→ 用户级 env 认证生效；init.model=glm-5.3[1m] 与用户级 settings 的 model 映射一致 → 用户级 model 生效；hook 进程读到注入 settings 的 env 探针 `POC7_SESSION_INJECTED=1` → 注入 env 生效。三处同时成立 = **合并为叠加语义而非替代**（与 PoC 2 发现 4 的 `--setting-sources project` 排除语义形成对照） |

## 2. 关键发现（按对产品的影响排序）

1. **审批回调的隐藏前提：`--permission-prompt-tool=stdio`**。非交互 stream-json 默认把「会弹审批」的工具调用**自动拒绝**（tool_result is_error，不向宿主发任何请求）——GUI 漏带此 flag 会静默降级为「全部拒绝」且无任何报错。Agent SDK 的 canUseTool 回调经查源码（claude-agent-sdk@0.3.318，文档级）就是把该 flag 传给 CLI；实测带 flag 后 `can_use_tool` 控制请求经 stdout 流出，宿主以 `control_response{response:{subtype:"success",request_id,response:{behavior:"allow"|"deny",...}}}` 应答（请求/响应形状与 SDK 源码一致）。**注意 request_id 嵌套在 response 对象内（顶层无 request_id）**。请求还携带 `permission_suggestions`（addRules/addDirectories 规则建议）——产品审批 UI 可直接渲染为「允许本次/ always 规则」选项。
2. **interrupt 语义完整可用**：CLI 确认（control_response success）→ 输出立即停止（interrupt 后 0 delta）→ 被中断轮以 `result(subtype=error_during_execution, is_error=true)` 终止 → 同会话下一轮正常。**GUI 必须把 `error_during_execution` + 用户已发 interrupt 的组合归类为「已取消」而非错误**（判定不可只看 is_error）。
3. **跨重启 resume 与 Codex/OpenCode 同构可用**：进程 A 正常退出（exit 0）后，新进程 `--resume <session-id>` + stream-json 握手即可续问，session id 不变（`--fork-session` 才换 id），上下文无损复现。GUI 的「重启恢复」= 持久化 session id + spawn 新进程 resume，无需常驻。
4. **`--settings` 是会话级注入的正解，且是叠加语义**：注入的 hooks、env 与用户级 settings（认证 env、model）同时生效；对比 `--setting-sources project`（排除用户级、切断认证，PoC 2 发现 4），**GUI 会话级注入必须用 `--settings`、禁用 `--setting-sources`**。注入随进程消失，不污染项目仓库与用户目录——产品决策「会话级注入」在 Claude 侧完全落地。
5. **CLAUDE_CONFIG_DIR 可做 Windows 配置隔离**：重定向后认证 env settings 即用户级配置的目标形态，会话落盘/resume 也在重定向目录内自洽（T4 即在重定向目录内完成跨进程 resume）。可作为 GUI 多配置/隔离的候选机制（本轮为满足 T5 干净前提引入，兼得验证）。
6. **Skill 触发非确定性再现，且新增一种缺口形态**：首轮 `/design-feature` 正例模型**未调用 Skill 工具**——slash dispatch 已把 SKILL.md 展开进上下文，模型直接照做输出 stub 文案「DESIGN-FEATURE-STUB-OK」（输出正确但 hook 零事件）；强提示（明确要求 tool_use Skill）后真调用且 hook 捕获。**GUI 不得以「输出符合 skill 预期」推定 skill 已执行**——verified 只认 PreToolUse(Skill) hook（poc-2 结论强化，缺口清单新增「dispatch 展开后照做」形态）。
7. **实现细节**：a) `result.total_cost_usd` 为会话累计口径（轮间递增），成本台账取各会话末轮值；b) `system/init` 与 initialize 的 control_response 到达顺序不保证，session id 应从 `result.session_id` 或 init 轮询读取（lib/client.mjs 已处理，本 PoC 首跑的判定竞态由 analyze-t1t2.mjs 从原始流重算修正）；c) stderr 出现 `[claude-code:unrecognized_model] glm-5.3[1m]` 警告但会话全程正常（网关映射模型，与 poc-2 现象一致，不影响判定）。

## 3. 调用台账（7 会话 / 13 轮 / 约 \$0.52）

| # | 脚本 | session | 轮次 | 成本（会话累计末值） | 结果 |
|---|---|---|---|---|---|
| 1 | run-t1t2（首跑，脚本 bug 中断） | — | 1 | ~\$0.067（raw 被覆盖，估） | turn1 成功后客户端异常，进程终止 |
| 2 | run-t1t2（正式） | 683f6d8d | 3 | \$0.0757 | T1/T2 全部判定通过 |
| 3 | run-t3（无 flag 对照） | efad4b35 | 2 | \$0.1066 | 审批不流出、自动拒绝（关键证据） |
| 4 | run-t3（--permission-prompt-tool=stdio） | 271919a6 | 2 | \$0.1008 | accept/deny 语义保真 |
| 5 | run-t4 进程 A | e43da4cd | 1 | \$0.0293 | 埋暗号，exit 0 |
| 6 | run-t4 进程 B（--resume） | e43da4cd（同 id） | 1 | \$0.0383 | 暗号复现 |
| 7 | run-t5t6（首轮） | （t5t6-result.json） | 2 | \$0.0317 | T6 叠加全过；正例模型未调 Skill（缺口形态证据）、反例零事件 |
| 8 | run-t5t6-retry | 9e079606 | 1 | \$0.0659 | Skill 真调用 + hook 双事件 + env 探针 |

真实模型调用合计 13 轮（上限约 12，超 1 轮：bug 浪费 1 轮 + 模型决策重试 1 轮，如实记录）。

## 4. 对产品设计的直接影响（capabilities 口径建议）

**可进三 CLI 统一契约（本 PoC 补齐 Claude 侧证据）：**

| 能力 | 三 CLI 实测形态 | 契约建议 |
|---|---|---|
| 取消 Turn | Codex `turn/interrupt`、Claude `control_request{interrupt}`、OpenCode abort 端点 | 统一「Cancel」能力；Claude 中断轮的 result 归类为已取消（发现 2） |
| 跨重启 resume | Codex `thread/resume`、Claude `--resume <id>`、OpenCode server 重启后续问 | 统一「会话恢复」能力，session id 由 GUI 持久化 |
| 审批回调 | Codex requestApproval、Claude can_use_tool（**需 --permission-prompt-tool=stdio**）、OpenCode ask+轮询 | 统一「审批」能力；Claude Adapter 必须显式带 flag 并在启动时断言，漏带 = 静默全拒绝（发现 1） |
| 会话级 hook 注入 | 仅 Claude 有此机制（Codex 无 per-turn hook、OpenCode 无 hook） | Claude 专属能力，不进统一契约；Claude Adapter 用 `--settings` 注入 + 与用户级叠加（发现 4） |

**需降级/特别声明的口径：**

1. Claude 审批回调不是「开箱即用」：默认非交互 = 自动拒绝。产品文档与 capabilities 矩阵必须写明前置 flag；建议 Claude Adapter 启动自检（缺 flag 即 fail-fast）。
2. Skill 触发不确定性维持 poc-2 结论并加强：slash dispatch 展开后模型可直接照做（无 Skill 工具调用）→ verified 只认 hook 事件；「输出正确」不构成执行证据（发现 6）。
3. 中断/审批控制消息的 request_id 位置（嵌套于 response）与 result subtype 语义（error_during_execution=取消）应写进 Claude Adapter 的协议绑定注释，防实现踩坑。

## 5. 复现

见 `README.md`（每个验收项一条命令；全部脚本 spawn 直连真实 claude.exe、prompt 经 stdin 协议传入，不经 shell）。
