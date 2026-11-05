# Kanban Desktop V1 架构提案（基于 PoC 实证）

> 日期：2026-11-05 · 状态：待评审
> 依据：六项 PoC 全部完成并收口（`poc/poc-1..6/`，三 CLI 真实事件源），汇总见 `docs/poc-results.md`、`docs/cli-compatibility-matrix.md`
> 本文只主张有 PoC 证据支撑的决策；未经实测的部分明确标注「待验证」，不伪装成已确认。

## 1. 总体结论

计划文档 §6 的四层架构**成立，无需推倒**：三 CLI 均以直连协议实测通过全部 GUI 核心验收（Codex app-server 8/8、OpenCode HTTP+SSE 12/12、Claude 协议直连核心全过），自动阶段识别以证据分级模型成立（三 CLI 真实源 e2e 25/25），Memory 可进 MVP（6/6），UI 复用收敛为「旧 Kanban terminal 链直接复用 + 其余自研」。ACP 桥接不作为首版依赖，仅留作未来跨 CLI 统一层的第二候选。

## 2. 进程模型

```text
React Renderer（Chat / Projects / Kanban / Memory / Diff 视图）
      ↕ 安全 Electron IPC（schema 化消息）
Electron Main（窗口 / 项目与关联元数据 / SQLite / Worker 生命周期）
      ↕ 进程内 API 或 utilityProcess
CLI Worker（单 Node 宿主，多 Adapter 实例共存）           ← PoC 4 已证可行
      ├─ Codex Adapter    → spawn codex.exe（app-server, JSON-RPC/stdio）
      ├─ Claude Adapter   → spawn claude.exe（stream-json 行协议）
      ├─ OpenCode Adapter → HTTP+SSE（opencode serve，隔离配置）
      └─ Requirement Tracker + Memory Service（消费归一化事件流）
```

- **统一 Worker 的必要条件已达成**（PoC 4：单 Node 宿主内三 CLI adapter + tracker 并存，交错事件流 25/25 正确），**非充分**：进程管理维度未压测，列为实施首批验证任务（§7-1）。
- **Windows 进程规则（已实证）**：spawn 必须直连真实 exe（npm `.cmd` shim kill 后留孤儿进程，PoC 1 发现 #4）；codex 用 `codex.exe`、claude 用 `claude.exe`。Job Object + `KILL_ON_JOB_CLOSE` 方案仍需按「取消 Turn 不杀 Session、按 Session 粒度有序终止」实测（§8.6，待验证）。
- **生命周期与恢复**沿用 §6.1 规则；对应行为已有实证：切页不停止（架构属性）、取消 Turn 保留 Session（PoC 1e/3）、退出后历史与关联恢复（PoC 1g、PoC 3 恢复项、PoC 4 场景 5 重启 7/7）、CLI 意外退出不崩溃不重放（PoC 1h、PoC 3 异常项）。

## 3. CLI Adapter 层（每 CLI 一个，接口统一）

| | Codex | Claude Code | OpenCode |
|---|---|---|---|
| 传输层 | app-server JSON-RPC/stdio（poc-1 client.mjs 演进） | stream-json 行协议（poc-2 protocol-client.mjs 演进） | HTTP+SSE（poc-3 client.mjs 演进） |
| 版本策略 | 锁版本 + `generate-ts` diff 探针 | 外部 hook 与 CLI 版本解耦 | 与 CLI 同版本 SDK / OpenAPI 自描述 |
| 审批 | requestApproval 直通，语义不改写 | 权限 flags 透传；canUseTool 待 SDK 修复 | 会话级显式 `ask` 注入 + 轮询 `GET /permission` + SSE `replied` 兜底 |
| 模型可用性 | **`model/list` 不可信**，启动时可用性探测与回退 | 按账号配置 | provider/model 按第一个斜杠切分 |
| 阶段信号 | self_reported | **verified（hook）** | self_reported |

统一契约（Adapter 对上只暴露）：createSession(cwd) / sendTurn / interruptTurn / approval(requestId→decision) / readHistory / resume / 事件流（归一化 schema）+ dispose。**Adapter 不解释需求状态、不编排 Skill**（§5 边界不变）。

实施约束（全部实测来源）：

1. OpenCode 默认 `*:*:allow` 全放行——统一审批体验由 Adapter 显式收紧（会话级 `ask`），UI 明示「原生默认 / 收紧 ask」档位，不得全局假设（PoC 3）。
2. Claude 的 Skill 真调用以**项目级 PreToolUse/PostToolUse hook 落 JSONL 为唯一真相源**；「用户输入了 /skill」≠「已执行」，两个事件在 UI 分开展示（PoC 2 发现 #1/#2）。
3. Claude 认证依赖用户级 settings env——隔离策略必须保留认证注入（`--setting-sources project` 会切断认证，PoC 2 发现 #4）。
4. 所有 spawn 编程直连、不经 shell（MSYS 改写 `/` 参数与 env，PoC 2 发现 #5）。
5. Agent SDK（npm）在 Windows 有上游 bug（#359/#444），首版以协议直连为传输层基线，SDK 恢复后再评估替换（PoC 2 发现 #4）。

## 4. Requirement Tracker（阶段引擎）

规则全部经确定性测试 + 真实事件验证（PoC 2 tracker 15/15、PoC 4 tracker 21/21 + e2e 25/25 + 重启 7/7），可直接演进为产品实现：

```text
归一化事件 {eventId, sessionId, cli, skill, occurredAt, seq, evidenceLevel, source}
   ├─ 建卡：仅 verified 的未关联 Session 首次 design-feature；eventId 幂等去重
   ├─ 驱动：verified 直接驱动；self_reported/simulated 驱动 + uncertain，
   │        manual confirm 或后续 verified 转正（两条路径已实测）
   ├─ 分级：按「CLI 是否提供 skill 语义独立验证」划分（OpenCode command 信号
   │        再强也不能升 verified——SKILL.md 注入 prompt 由模型自由发挥）
   ├─ 排序：按 occurredAt 实际发生时间；旧/重复/延迟事件不覆盖；允许 PR→Implement 回退；
   │        无法可靠排序保留当前阶段 + uncertain 标注
   └─ 关联：link 时按 skill 实际发生时间同步（不以关联时间冒充）；unlink 不回退不删历史
```

存储：SQLite（requirements / sessions / stage_events 三表已够首版，PoC 4 实证重启恢复与重放幂等）。手动修正 UI 为必备兜底路径。

## 5. Memory Service

PoC 5 全过（6/6），三条硬边界写入 MVP：

1. **仅手动触发**（需求详情点击「提取需求经验」），无任何自动调度；
2. **临时 CLI Session 三层隔离**（session id / 原生历史文件 / project 目录，提取前后 sha256 不变）；
3. **终态不可静默覆盖**（人工编辑后重复提取走 hash 检测 + proposed 暂存）。

数据布局沿用 PoC 5 实证结构：Kanban 应用数据目录按 Project ID 分区，SQLite 存索引/关联/来源，Markdown 存总结与已接受知识；候选状态机 pending→accepted/edited/ignored，带来源 Session、证据、适用范围、批次 id、review 元数据（参照 pi-sleep-agent T0/T1/T2）。冲突提示首版用启发式（Dice 已实证可检出高相似），同义改写召回不足如实标注，产品化再升级 embedding/LLM 判重。

## 6. Renderer 与 UI 复用

- **直接复用**：旧 Kanban terminal 全链路（TerminalPanel + terminalApi 契约 + 注入式 PTY 宿主 + IPC 薄层；已 0 diff 抽离 + mock PTY 浏览器实测跑通）。前置：node-pty 在 Windows Electron 的原生编译验证（§7-3）——**已通过**（T0-03，node-pty 1.1.0 随包 N-API prebuilt 在 Electron 42/44 与纯 Node 下加载 + 窗口回显冒烟全过，见 `poc/t0-03-node-pty/RESULT.md`）。
- **改造后复用**：旧 Kanban project-switcher / git-viewer（受控组件，替换 `@kanban/core` 类型依赖）。
- **仅借鉴交互，自研实现**：PI-Desktop 的聊天/工具卡片/Session 导航/Diff（LGPL-3.0 阻断源码复用）；工具卡片与 Diff 按 poc-6 的 review-change 契约思路自实现。
- **否决引入**：PI-Desktop Rust Host Core 与插件系统；旧 Kanban Go daemon；任何带 dispatch/worktree/自动推进的开源 Kanban 执行模型（§8.4 边界）。

## 7. 实施前置验证任务（进入开发的首批 ticket 候选）

| # | 任务 | 来源 |
|---|---|---|
| 1 | Worker 进程管理实测：Windows Job Object、取消 Turn 不杀 Session、按 Session 粒度有序终止、子进程（Skill 的 Subagent）清理 | §8.6 + PoC 1 发现 #4 |
| 2 | Agent SDK Windows bug 跟进：锁可用版本或正式弃用改协议直连 | PoC 2 发现 #4 |
| 3 | node-pty 在 Windows Electron 原生编译验证（terminal 链复用前置）——**已完成（T0-03，PASS）**：Node 24 · Electron 44.10.2（42 对照同过）· node-pty 1.1.0 随包 N-API prebuilt，无需编译/electron-rebuild；pnpm 10 须放行构建脚本；源码编译回退路线亦验证可用（详见 `poc/t0-03-node-pty/RESULT.md`） | PoC 6 风险项 |
| 4 | 同名 skill 冲突的产品策略（项目级/用户级同名提示或前缀） | PoC 2 发现 #3 |
| 5 | 认证 env 注入策略（保留网关认证的隔离方案） | PoC 2 发现 #4 |
| 6 | Codex 协议版本探针与降级（experimental v2，锁版本 + generate-ts diff） | PoC 1 发现 #1 |
| 7 | 模型可用性探测与回退（model/list 不可信） | PoC 1 发现 #2 |
| 8 | Memory 判重升级评估（embedding/LLM） | PoC 5 诚实边界 |

## 8. 实施阶段映射（对照 §12）

阶段 0（技术验证）**完成**：本文 + `cli-compatibility-matrix.md` + `poc-results.md` + `desktop-reuse-assessment.md` + 各 PoC 最小可运行示例。阶段 1（Desktop MVP）开工前先做 §7-1/2/3 三项进程与依赖验证，然后冻结三份接口：Adapter 统一契约（§3）、归一化事件 schema（§4）、SQLite 表结构（§4/§5）。IPC schema、Memory 文件布局等 §13.9 细节随阶段 1 规格化，不在本文预先虚构。
