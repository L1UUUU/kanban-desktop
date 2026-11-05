# PoC 总体验证结果（Kanban Desktop V1）

> 日期：2026-11-05 · 环境：Windows 11 (10.0.26200) / Node v24.13.0 / Git Bash
> 依据：`docs/kanban-desktop-v1-plan.md` §9 六项 PoC；各项详细证据见 `poc/poc-N-*/RESULT.md`，复现命令见各目录 README.md
> 结论只来自真实运行；未运行的项标 NOT TESTED 并注明原因。

## 0. 总判定一览

| PoC | 优先级 | 判定 | commit | 一句话结论 |
|---|---|---|---|---|
| 1 Codex app-server 直连 | P0 | **PASS（8/8）** | `ae69e8a` | Windows 直连 app-server 全链路可用，建议作为 Codex Adapter 路线 |
| 2 Claude Skill 与事件 | P0 | **PASS（核心全过，2 项 PARTIAL、1 项 NOT TESTED）** | `03249bd` | Skill 真调用可留证；hook 是唯一真相源；建卡/阶段规则 15/15 + 真实回放零误建 |
| 3 OpenCode Adapter | P0/P1 | **PARTIAL（环境阻塞）** | `22372cd` | 权限默认值已实证（`*:*:allow` 自动放行）；6 项需模型调用的矩阵项被凭据失效阻塞，脚本就绪待补跑 |
| 4 跨 CLI 需求链路 | P0 | **PASS（5/5 场景）** | `183c8fd` | 多 CLI 事件归一化 + 证据分级驱动阶段成立；SQLite 持久化重启恢复通过 |
| 5 需求级 Memory | P1 | **PASS（6/6）** | `c784597` | 手动提取/临时 Session 隔离/不静默覆盖/冲突提示全通过，Memory 可进 MVP |
| 6 参考组件抽离 | P1 | **完成（评估型）** | `578c8ce` | 旧 Kanban terminal 全链路可直接复用（0 diff 实测）；PI-Desktop LGPL-3.0 仅可借鉴设计 |

真实模型调用成本：PoC 1 十次 / PoC 2 九次 / PoC 3 零次 / PoC 4 约八次（有效 3 次）/ PoC 5 七次；PoC 6 无模型调用。各 PoC 台账见其 RESULT.md / logs。

## 1. PoC 1 — Codex（PASS 8/8）

启动/原生 thread id、多轮流式（delta 与终文逐一相等）、工具事件、审批（accept 真建文件、deny 真不执行，权限语义未被改写）、interrupt 后可继续、3 thread 并发、退出后 thread/read + resume 上下文延续（暗号复现）、SIGKILL 后明确报错无重放——全部真实运行通过。

对架构有直接输入的发现：

1. 协议绑定可用 `codex app-server generate-ts` 与二进制同版本生成（本 PoC 已存 `protocol/ts/`），应作为版本漂移探针而非网上文档。
2. `model/list` ≠ 账号可用模型（本账号仅 gpt-5.6-luna 可用，config 默认模型报 400）——GUI 必须做模型可用性探测与回退。
3. read-only 沙箱内 echo 不触发审批；审批验证要用写文件类命令（会触发 `item/commandExecution/requestApproval`）。
4. Windows 上 spawn npm `.cmd` shim 会留孤儿进程，必须直连真实 `codex.exe`（或 Job Object，见 §8.6）。
5. ACP 桥接（AionUi 路线）仅文档级对照：npm 桥接包落后 codex 高频迭代约 4.5 个月，首版建议直连；若后续需要统一协议层再评估。

## 2. PoC 2 — Claude Code（核心 PASS）

已证实：项目级 skill 被原生发现并加载（Base directory 为证）；Skill 是原生工具调用（`tool_use: Skill` + PreToolUse/PostToolUse hook 双事件 + stub 输出四类证据互印）；普通文本提及零误判；tracker 建卡/去重/乱序/延迟/并发/手动修正/解除关联规则 15/15 用例 + 36 行真实事件回放恰好 3 卡零误建。

PARTIAL / NOT TESTED：`canUseTool` 审批回调链路（被 Agent SDK Windows bug 阻塞）；真实 design-feature 的依赖链与 worktree 行为（成本决策，用 stub）。

关键发现：

1. **Skill 是否执行由模型决策，非确定**（4 轮 slash 仅 2 轮直接调用）——「用户输入了 /skill」≠「skill 已执行」，**hook 是唯一真相源**，未捕获事件落入手动修正。这正是 §4「识别风险」的实证。
2. 项目级 skill 优先于用户级同名，但同名冲突使模型行为不稳定——产品需检测/规避。
3. `--setting-sources project` 隔离会切断认证 env（本机认证依赖用户 settings 的网关配置）。
4. **Agent SDK 0.2.141/0.3.318 在 Windows pre-spawn abort**（与上游 issue #359/#444 同类）；已按同款 wire 协议（stream-json + initialize 控制请求）手写传输层完成等效验证。正式实施前需锁定可用版本或以协议直连为传输层基线。
5. Git Bash/MSYS 会改写 `/` 开头的参数与 env 值；GUI 编程 spawn 不经 shell，无此问题。
6. cc-skill-trace 回溯结果与实时 hook 逐 session 逐时间戳一致（独立对照通过）；skill-audit 不在 npm。

## 3. PoC 3 — OpenCode（PARTIAL，环境阻塞）

已实证：server 隔离启动 + 原生 session id；SSE 事件形状；`GET /agent` 权限表第一条即 `*:*:allow`（仅 doom_loop/external_directory/read .env 四类默认 ask）——**默认 build agent 自动放行所有工具**与 §8.6 判断一致；异常退出客户端不崩溃、重启后 7/7 session 完好；fixture 的 command/skill 被原生发现（注意：用户全局 `~/.claude/skills`、`~/.agents/skills` 也会被扫描，XDG 隔离不影响 skill 发现）。

**对 GUI 审批设计的直接影响：** 包装层不能假设 OpenCode 默认弹审批；要统一审批体验必须由 Adapter 在 Session 创建时显式注入 `permission: {"bash":"ask",...}`（会话级配置，UI 明示「原生默认 / 收紧 ask」档位），不得全局假设。

**阻塞（需用户操作）：** OpenAI oauth 凭据失效（refresh 401，过期约 7 个月）。恢复方式任选：① 走代理执行 `opencode login`；② 向 fixture 提供 `OPENAI_API_KEY` 或 zen key（可只写 fixture，不碰全局）。恢复后按 `poc/poc-3-opencode/README.md` 一条命令序列补跑（预算 ≤10 次调用，当前消耗 0）。

## 4. PoC 4 — 跨 CLI 需求链路（PASS 5/5）

真实混合流验证：Claude stub design-feature（真实 hook）自动建 REQ-001 → Codex 真实 turn + self_reported implement-spec → 合成 OpenCode 事件（凭据阻塞，标注 simulated）→ 手动修正 → 重放注入 → 重启恢复。`node --test` 20/20，e2e 22/22，重启恢复 7/7。

**证据分级策略（本 PoC 回答的设计问题）：**

```text
事件流（hook / GUI 观察 / 合成）→ 归一化 {eventId, occurredAt, evidenceLevel, ...}
        ├─ verified（hook 确认）      → 唯一可建卡；直接驱动阶段
        ├─ self_reported（Codex 等）   → 驱动阶段但标 uncertain，manual confirm / 后续 verified 转正
        └─ simulated                  → 同 self_reported 处理
排序规则（实际发生时间比较、旧事件不覆盖、允许 PR→Implement 回退）与证据等级正交
```

理由：turn 开始/完成与用户提交是可信事实，完全不驱动会使 Codex 的自动阶段识别永久失效（无 per-turn hook 是结构性缺口）；uncertain 把不可信部分显式暴露，符合 §4「记录不确定性」。建卡副作用大，只信 verified。

## 5. PoC 5 — 需求级 Memory（PASS 6/6）

仅手动触发；Claude（原生 jsonl 直读）+ Codex（thread/read）双 CLI 真实历史读入；临时 Session 三层隔离（session id / 原生历史文件 / project 目录，提取前后 sha256 不变）；缺失历史明确标注；分段逻辑确定性单测；双产物（summary.md + 15 条带 sourceSessionIds/evidence/scope 候选）；pending→accepted/edited/ignored 状态机（参照 pi-sleep-agent T0/T1/T2 与 review metadata）；人工编辑后重复提取不覆盖（hash 检测 + proposed 暂存）；「除零返回 0 → throw」纠错场景两批提取 0 条错误规则进入 accepted；冲突检测真实检出（Dice 0.611）。

诚实边界：字符启发式对同义改写召回有限（Dice 0.391 未标），产品化建议 embedding/LLM 判重。

## 6. PoC 6 — 组件复用评估（完成）

- **许可证：** PI-Desktop 为 **LGPL-3.0**，源码抽离=衍生作品须隔离开源，对本项目基本不可源码复用，仅借鉴设计；旧 Kanban **无 LICENSE**，为用户本人旧项目，确权后可直接复用；两仓库依赖树实查无 copyleft。
- **直接复用：** 旧 Kanban terminal 全链路（TerminalPanel + terminalApi 契约 + 注入式 PTY 宿主 + IPC 薄层，渲染层不经 Go daemon）——已 0 diff 抽离 + mock PTY 在浏览器实测跑通。
- **改造后复用：** 旧 Kanban project-switcher / git-viewer（受控组件，换类型依赖即可）。
- **仅借鉴交互：** PI-Desktop ToolRow / Sidebar / TurnChangesCard（深耦合 store/IPC/插件槽/i18n；TurnChangesCard 实测 6 个宿主耦合点可收敛，但推荐按契约自实现省去 LGPL 成本）。
- **否决：** PI-Desktop Rust Host Core 与插件系统、旧 Kanban Go daemon 及 daemon 数据 feature。
- 风险项：node-pty 原生编译未实测（需 Windows Electron 环境先验证）；PI-Desktop 组件 CSS 依赖 28 个 `--ds-*` token。

详见 `poc/poc-6-reuse/desktop-reuse-assessment.md`。

## 7. 对照 §11 选型门槛的结论

| 决策 | 门槛达成情况 | 结论 |
|---|---|---|
| CLI 正式支持 GUI | Codex 全过；Claude 核心过（审批回调待 SDK 版本解决）；OpenCode 阻塞待补跑 | Codex=直连 app-server；Claude=协议直连（stream-json+hook）为基线，SDK 待锁版本；OpenCode=HTTP+SSE 直连，凭据恢复后补跑 6 项 |
| 协议接入方式 | 直连均有实证；ACP 仅文档级对照 | 三 CLI 均建议直连；ACP 留作跨 CLI 统一层第二候选 |
| 自动 Skill 阶段识别 | 真调用留证 / 无误报 / 去重 / 旧事件处理全过 | **达成（证据分级口径）**：Claude verified 全自动；Codex 类 self_reported「自动驱动 + uncertain + 手动兜底」；若要求全 CLI 零人工则 Codex 结构性不满足，分级正是缺口的显式化 |
| 统一 Worker | 单 Node 宿主多 CLI adapter + tracker 并存、交错事件流正确（PoC 4） | 必要条件达成、非充分：进程管理维度（Job Object、Turn 粒度取消）仍需在正式 Worker 实现时按 §8.6 验证 |
| 复用开源组件 | 许可证/依赖/独立编译实测过（terminal 链）；PI-Desktop LGPL 否决源码复用 | 旧 Kanban terminal/project-switcher 可复用；PI-Desktop 仅借鉴 |
| Memory 进入 MVP | 多 CLI 历史可读 / 来源可追溯 / 审核闭环全过 | **可进 MVP**，保持三条硬边界：仅手动触发、临时 Session 隔离、终态不可静默覆盖 |

## 8. 待办与建议下一步

1. **用户操作：恢复 OpenCode 凭据**（`opencode login` 走代理，或提供 OPENAI_API_KEY/zen key 到 fixture），然后按 `poc/poc-3-opencode/README.md` 补跑 6 项阻塞矩阵（含 PoC 4 场景 3 换真实事件源重跑）。
2. `architecture-proposal.md` 有意推迟到 PoC 3 补跑完成后编写（避免在 1/3 CLI 证据缺失下定稿架构）。
3. 正式实施前需解决的技术债：Agent SDK Windows 可用版本锁定；同名 skill 冲突产品策略；认证 env 注入策略；node-pty 在 Windows Electron 的原生编译验证。
4. 各 PoC 保留的最小可运行示例即 §10 要求的复现载体（各目录 README 一条命令复现），不再另建 `poc-test-plan.md`——测试步骤已随 RESULT 固化。
