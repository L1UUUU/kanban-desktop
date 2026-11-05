# Kanban Desktop V1 — 产品决策、架构与技术验证方案

> 日期：2026-11-05  
> 状态：产品方向已确认；技术兼容性与代码复用待实际 PoC  
> 用途：后续 Agent 调研、架构评审与实施规划交接  
> **本文不授权创建仓库、安装依赖、修改代码或执行 PoC。**  
> **2026-11-05 补充：** 第 8 节已扩展为对 GitHub 开源项目的第二轮调研记录。新增内容均标注为「已观察到（文档/README 级）」或「待验证」，不改变第 1–7、9–14 节已确认的产品决策。

## 1. 依据与产品定位

本文整理本轮逐项确认的新版决策，参考两份历史文件 `kanban-product-architecture-decision-snapshot-2026-10-08.md`、`kanban-v1-product-decisions.md`，以及对相关 GitHub 仓库 README、部分架构文档和目录的初步检查。旧文档中的自主开发闭环、复杂授权、Go daemon 调度、Pi 主运行时等不再作为新版第一版的默认要求。冲突时以本轮明确的新决策为准。

**定位：** 面向个人开发者的多项目 Coding Agent Desktop，包装 Claude Code、Codex、OpenCode 等现有 CLI；以统一聊天 GUI 为主、独立原生 TUI 为辅；通过轻量 Kanban 组织跨 Session 需求，通过手动触发的需求级分析沉淀项目经验。

**首版不做：** 自研 Agent Harness；Skill 安装管理、插件市场；工作流编排或自动推进；自动测试/Review/修复调度；复杂权限/预算/Agent Team；完整 Documentation OS；自动 Git worktree 管理或强制文件锁；跨 Session 自动传递 Spec/Tickets；自动注入 Memory；GUI/TUI 同一实时会话无缝切换；后台常驻 CLI；Memory 自动提取、知识图谱或向量数据库。

## 2. 典型用户旅程

1. 选择项目，自由创建 Session，选择 CLI；由用户自行输入提示词和文件路径。
2. 在未关联需求的 Session 中手动调用 `design-feature`。只有观察到**有效调用**，Kanban 才自动创建一张 Requirement 卡片、关联该 Session、设置 Design 阶段。
3. 用户在需求卡片中创建新的 Codex/其他 CLI Session（自动关联），或自由创建后手动关联已有需求。新 Session 不继承其他 Session 的完整聊天上下文；Spec、Tickets 由用户手动输入。
4. 用户手动调用 `implement-spec`，随后按需调用 `pr`、`retro`；不同阶段可使用不同 CLI，同阶段可有多个 Session。Kanban 不触发下一阶段。
5. 用户在需求详情点击「提取需求经验」，系统读取该需求关联的多个可访问 Session，使用独立临时 CLI Session 生成开发总结和长期知识候选。用户审核候选后才进入 Project Memory。

注意：上游 `mattpocock/skills` 的 `implement-spec` 自身管理 integration branch、子 Agent worktree 与 review；`pr` 主要生成 PR 正文，不保证创建远端 PR；`retro` 是会话复盘而不是完整 Memory 引擎。不可由 Skill 名称推断完成状态。

## 3. 核心对象与关联

| 对象 | 职责 |
|---|---|
| Project | 多项目与工作目录管理 |
| Requirement | 需求卡片，可关联多个 Session |
| Session | 原生 CLI 会话，可暂不关联需求；同一时刻最多归属一个需求 |
| Stage Event | Skill 有效调用或用户修正，记录来源、时间与顺序 |
| Memory | 需求总结、待审核知识候选、已接受项目知识 |

两种入口都支持：从需求卡片创建 Session 时自动关联；自由创建后可手动关联、解除关联。关联不重启 CLI、不注入上下文、不自动执行 Skill。

**自动建卡规则：** 只有未关联 Session 首次有效调用 `design-feature` 才自动建卡；重复调用不重复建卡。未关联 Session 调用 `implement-spec`、`pr`、`retro` 不建卡，但可以记录 Session 活动。卡片初始标题可为「待命名需求」，允许编辑。

## 4. Kanban 阶段与冲突规则（已确认）

粗粒度阶段：未开始、Design、Implement、PR、Retro。阶段不等于完成或验收；CLI 活动状态（Idle、Running、Waiting、Interrupted、Disconnected）单独展示。

| 有效事件 | 效果 |
|---|---|
| `design-feature` | Design；未关联时自动建卡 |
| `implement-spec` | Implement；只更新已关联需求 |
| `pr` | PR；不证明远端 PR 已创建 |
| `retro` | Retro；不证明知识已保存 |
| 用户手动修正 | 立即生效；不永久锁定 |
| 普通聊天、停止输出、页面切换 | 不改变阶段 |

**优先级：** 多个 Session 并行时，最新**有效阶段事件**决定需求阶段。用户手动修正立即生效，但之后新的有效 Skill 调用仍可覆盖。重复、重放、延迟旧事件不得覆盖更新状态。将已有 Session 关联需求时，同步其最近阶段，但以 Skill **实际发生时间/可信顺序** 与当前阶段依据比较，而不是以关联操作时间冒充调用时间；需求尚无阶段依据时可以初始化。无法可靠排序时保留当前阶段并记录不确定性。解除关联不自动回退阶段。允许 PR→Implement 等回退。

**识别风险：** CLI 发现 Skill、GUI 真正调用 Skill、Kanban 观察到调用是三个不同能力。普通消息中出现 `/design-feature` 不等于执行成功；不能可靠检测时允许手动修正。

## 5. GUI、TUI 与 CLI 适配边界

- 新仓库，选择性复用旧 Kanban 和开源实现；不直接继承旧重型架构。
- 参考 Codex Desktop、PI-Desktop、DeepSeek Harness Desktop 的视觉、会话导航、工具卡片、审批和 Diff。
- 左侧项目/Session，中央聊天 GUI；Kanban、Memory 独立视图。
- GUI 通过结构化接口包装现有 CLI；TUI 使用 PTY，第一版是**独立 Session**，不承诺实时无缝切换。
- CLI Adapter 只负责协议、启动、流式消息、工具、审批、取消、恢复、事件转换；不解释需求状态、不编排 Skill。
- 原生 Skill/Slash Command、Subagent、文件引用、模型切换等按各 CLI 实际支持能力声明；不能以普通文本模拟后宣称兼容。

正式 GUI 适配最低验收：创建原生 Session、多轮流式聊天、工具调用展示、正确审批、取消当前 Turn、历史读取与继续原生上下文、错误处理。

## 6. 最小技术架构

```text
React Renderer (Chat / Projects / Sessions / Kanban / Memory / Diff)
      ↕ 安全 Electron IPC
Electron Main (窗口 / 元数据 / SQLite / Worker 生命周期)
      ↕ 本地进程通信
独立 CLI Worker（默认一个宿主）
      ├─ Codex Adapter
      ├─ Claude Code Adapter
      ├─ OpenCode Adapter
      └─ 独立 PTY 兼容模式
             ↓
        现有 CLI 进程和原生 Session 存储
```

职责：Renderer 展示交互；Main 管理应用、项目与会话关联和持久化；Worker 管理 CLI 进程、协议、事件和取消；Requirement Tracker 维护自动建卡、关联、阶段顺序；Memory Service 负责需求级提取与候选审核。Worker **不是 Agent Runtime 或工作流引擎**。

默认一个 Worker 宿主管理多个独立 CLI Session，但不强制所有 CLI 共用一个服务实例。允许跨项目、跨 CLI、同目录多 Session 并行；同工作目录仅提示潜在文件冲突，不阻止执行，不自动创建 worktree。

### 6.1 生命周期与恢复

| 场景 | 第一版行为 |
|---|---|
| 切换页面/关闭聊天标签 | 不停止 CLI |
| 停止当前回复 | 取消当前 Turn，保留 Session |
| 正常退出应用 | 停止 CLI，保留历史及关联；不后台常驻 |
| 重开应用 | 恢复项目、Session、卡片，按需读取原生历史和恢复上下文 |
| Worker/CLI 异常 | 先核对旧进程，避免重复接管和重放有副作用操作 |
| 中断中的工具调用 | 不自动继续、不宣称仍在运行 |

退出时停止接收新请求、请求有序取消、有限等待后受控终止。Windows 需验证子进程树、路径、残留进程和身份核对。Kanban 本地数据库保存关联/阶段/索引，CLI 原生历史仍是恢复 Agent 上下文的依据；缓存消息不代替原生历史。

## 7. Memory V1：需求级手动提取

**触发：** 用户在 Requirement 卡片/详情点击「提取需求经验」。不在 CLI 空闲、关闭标签、Session 归档或 `retro` 结束时自动提取。读取该需求关联的所有**可访问** Session；缺失历史要列明，不可声称分析完整。

**执行：** 复用已接入的 CLI，以独立临时 Session 处理跨会话历史，不污染 Design/Implement 等开发 Session；不另建模型管理系统。长历史需考虑分段分析、去重和结果合并。

**产物一：需求开发总结。** 记录目标、设计、实现、关键取舍、错误修复、验证与交付过程。生成后保存到该需求本地记录，允许编辑与重新生成，不静默覆盖人工修改。

**产物二：长期知识候选。** 提取项目级可复用规则、架构边界、领域语义、调试与验证经验，附来源 Session、证据和适用范围。用户接受/编辑/忽略后才写入正式 Project Memory；相同或冲突知识要提示。

**存储：** Kanban 在自身应用数据目录统一管理 Memory，按 Project ID 分开；不默认写项目仓库 `.local`，不默认上传 Git。SQLite 保存索引、关联与来源；Markdown 等文件保存总结、候选和已接受知识。Memory 页面支持搜索、查看、编辑、复制与引用；CLI 可通过明确路径按需读取。**不自动注入上下文，不自动修改 `AGENTS.md`/`CLAUDE.md`。**

**复用边界：** 需求级记录与项目级知识分开。未合并需求的实现结论不得被其他需求误认为当前代码基线已有事实。第一版不建设复杂硬隔离平台，但应记录适用范围和来源。

## 8. 开源项目调研（2026-11-05 扩展，非运行验证）

> 本节新增内容来自第二轮 GitHub 检索，证据等级为「README / 文档 / 目录级观察」，**均未在本机运行**。任何「支持」「可用」描述均不代表 PoC 通过。

### 8.1 总体格局：三条路线

第二轮调研的项目可归入三条路线，理解这个分野比逐个罗列更重要：

- **路线 A — 多 CLI 统一 GUI。** 目标是把多个 CLI 的聊天、工具、审批、恢复包装进图形界面。与本文「统一聊天 GUI 为主」直接重叠，但 Kanban / Memory 普遍缺失或极浅。Adapter 层价值最高。
- **路线 B — Kanban 编排。** 共同范式是「卡片即任务 → 自动 dispatch 到 agent → 每任务强制 git worktree → 完成后进入 review」。与本文「Kanban 不触发下一阶段、不自动创建 worktree」存在**方向性冲突**，只能借数据结构，不能引入执行模型。
- **路线 C — Memory / Skill 观察。** 解决跨 Session 记忆、Skill 调用审计、事实冲突检测。局部可复用，但多数默认自动注入、自动 promotion、自动 consolidation，与本文「手动触发 + 审核后写入」冲突。

**结论：** 没有项目可以直接作为 Kanban Desktop V1 的底座或 Fork 起点；但在 **CLI 协议适配、Skill 调用观察、Memory 候选分级、Windows 进程树管理** 四个具体技术问题上存在可拆解复用的实现或设计模式。

### 8.2 原候选项目（第一轮已观察到）

| 项目 | 已观察到的基础 | 关键待验证项 |
|---|---|---|
| [Codex](https://github.com/openai/codex) | App Server 文档包含 `thread/start`、`thread/resume`、`thread/read`、`turn/start` 和审批事件 | GUI Skill 真调用、阶段信号、Windows 恢复 |
| [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) | 官方 TypeScript SDK 提供编程使用 Claude Code Agent 能力的入口 | 原生 Skill、Hooks、Subagent、认证与恢复行为 |
| [OpenCode](https://github.com/anomalyco/opencode) | 仓库存在 SDK 包，可作为 CLI/服务端适配候选 | 当前协议、事件、Skill、权限、恢复细节 |
| [PI-Desktop](https://github.com/vastsa/PI-Desktop) | Electron/React UI、Rust Host Core + Node Pi Sidecar 分层，多项目多 Session | UI 与 Pi 耦合、组件抽离、许可证、独立编译 |
| [旧 Kanban](https://github.com/L1UUUU/kanban) | Electron/React、xterm.js/node-pty、Windows 终端、项目切换、看板 | 脱离 Go daemon 后能否复用 |

PI-Desktop 架构参考：[Architecture](https://github.com/vastsa/PI-Desktop/blob/main/docs/spec/02-architecture/01-architecture.md)。建议重点研究聊天/工具卡片、Session 导航和 Diff，不优先引入 Rust Host Core 或插件系统。旧 Kanban 优先检查 `apps/desktop/src/features/terminal`、`project-switcher`、Electron IPC，不迁移旧 Go daemon 业务调度。代码复用必须通过许可证、依赖、独立编译和 Windows 测试。

### 8.3 路线 A 新增：多 CLI 统一 GUI

| 项目 | 技术栈 / 定位（README 级） | 与本方案的关联 | 可借鉴 | 冲突 / 限制 |
|---|---|---|---|---|
| **AionUi**（`iOfficeAI/AionUi`，Apache-2.0，约 16.8k stars） | Electron + React + TS + SQLite；通过 ACP 桥接 17 个 CLI 后端，含 Claude、Codex、OpenCode；每个 agent 一个 `utilityProcess` | Adapter 层与多 agent 宿主模型与本文最接近 | 不直接调用官方 CLI，而用 Zed 的 `@zed-industries/claude-agent-acp` / `codex-acp` 桥接包 spawn 子进程；Worker 进程模型 | 无 Kanban、无 Requirement、无 Skill 阶段跟踪；引入 Zed 桥接包依赖，需评估 Windows 兼容与版本跟随 |
| **desktop-cc-gui**（`zhukunpenglinyutong/desktop-cc-gui`） | Tauri 2 + React 18 + Rust；覆盖 Claude Code、Codex、OpenCode 等 11 个引擎 | 提供按引擎逐项的**功能兼容性矩阵** | 矩阵维度（流式、历史恢复、中断、审批、Skill/Slash、Sub-agent 展示等）可直接作为 `cli-compatibility-matrix.md` 字段设计；每个引擎用 Rust 专用协议适配器，非终端 scraping | 引擎广度超出首版范围；Rust 后端与本文 Electron Worker 模型不同，不能整体照搬 |
| **Tessera / ReevesAgents** 等同类 | 多 CLI 统一 GUI | 路线佐证 | 交互概念 | 未做代码级评估，优先级低于上述两个 |

**对本文的意义：** 若 PoC 1/3 发现直接对接 Codex app-server 或 Claude Agent SDK 协议工作量过大，**ACP 桥接是一条已验证的替代路径**（AionUi 路线），但需把「桥接包依赖 + Windows 行为」纳入选型门槛。desktop-cc-gui 的矩阵还印证：`/` slash commands & skills 的支持度在各 CLI 间并不一致（其 README 中 Claude Code / Codex 标 ✅、OpenCode 标 ⚠️），与第 4 节「不可由 Skill 名称推断完成状态」一致。

### 8.4 路线 B 新增：Kanban / Session 模型

| 项目 | 模式（README 级） | 可借鉴 | 冲突 / 限制 |
|---|---|---|---|
| **Vibe Kanban**（约 22k stars，Apache-2.0） | 看板 spawn agent，每 task 自动建 git worktree，完成后 diff review 与一键 merge | live status 分类（Running / Needs Attention / Idle）可映射到本文 CLI 活动状态展示；卡片字段设计 | 卡片是**执行单元**并触发 dispatch/worktree，违反「首版不做自动编排、不自动建 worktree」 |
| **lectern** | 单 Go 二进制自托管；task dispatch 到 SSH 可达机器，在 tmux 独立 worktree 运行，移动端审批 | **task（交办工作）与 session（长期共事）的二分**，与本文 Requirement–Session 有概念亲缘 | 强制 worktree + tmux；**Windows 上控制平面需 WSL 托管**，原生 Windows 未解决 |
| **agentic-kanban**（`jmelahman/agentic-kanban`） | PyPI board，每 ticket 绑定独立 git worktree 中的 agent session，devcontainer 执行 | ticket–session 绑定与状态字段 | 强制 worktree / devcontainer 执行模型 |
| **cliban**（`LioraLabs/cliban`） | CLI + TUI + SSH 自托管，agent 通过 CLI 读写 board 的 spec/plan/activity/notes，配 skill 维持 workflow | board 数据结构、spec/plan/notes 分区 | skill 体系带自动推进和 milestone 分发倾向 |

**对本文的意义：** 这些项目的「卡片」是**执行单元**，本文的 Requirement 是**组织单元**。只能借鉴字段与状态命名，**不得引入 dispatch / worktree / 自动推进逻辑**。lectern 在 Windows 上的规避（WSL 托管）反向印证第 13 节「Windows 进程管理必须实际测试」的风险判断。

### 8.5 路线 C 新增：Memory / Skill 观察

| 项目 | 机制（README 级） | 可借鉴 | 冲突 / 限制 |
|---|---|---|---|
| **`pi-sleep-agent`** | 三级记忆：T0 会话内 disposable captures → T1 sleep 蒸馏的 provisional memory（下一 session 可用）→ 仅 `promote` 后变 T2 permanent；未审核候选标 `stale-candidate-unrediscovered`；approved memory 带 review date 与 source；项目隔离 | **T0/T1/T2 状态机 + 审核元数据**与本文「候选 → 用户审核 → 已接受知识」几乎同构；其 hook 覆盖表可作跨 CLI 事件粒度参照 | sleep 为**自动运行**（nightly / budgeted consolidation），与本文「仅手动点击提取」冲突；只能借状态机，不能引入自动调度 |
| **`recall-agents`** | 读取 Claude Code / Codex / Cursor 本机历史，建跨工具统一搜索与 nightly 重写 markdown notes，note 链回来源 chat，按 project 分组；索引与搜索不调 LLM，搜索延迟 15–60ms | 验证「跨 CLI 原生历史可读」工程可行；轻量无向量索引路线；来源链接设计 | notes 为 nightly **自动重写**且默认面向自动注入，与本文手动审核、不自动注入冲突 |
| **`Hindsight`**（Thoughtworks 雷达收录） | LLM 提取 facts / entities / timestamps 存 Postgres，recall 结合语义搜索 | 「相同或冲突知识要提示」的冲突检测设计 | 自动 consolidation，超出首版 |
| **`mnemos`** | Go 单二进制 memory 层；事实存为带证据的小 claims，surface contradictions 而非静默覆盖；自动捕获 correction 聚类提升 | 证据化 claim 与冲突 surfacing 思路 | 自动 promotion / consolidation 与本文冲突 |
| **`thread-keeper`** | 跨 CLI 共享 memory；Autonomous Curator 每三天自动审查、合并、废弃 skill，并自动新建 skill（每 pass 最多 2 个） | 作为「若未来扩展自动策展会面临哪些失控风险」的反面案例 | 自动创建/废弃 skill 与本文「不自动提取、审核后写入」直接冲突，**不作实现参考** |
| **`skill-audit` / `opencode-skill-audit`** | 跨 Claude Code / Codex / OpenCode 的确定性审计轨迹：哪些可观察 skill 被调用、何时、之后哪些文件被修改 | PoC 2 的**对照工具**：核对原生 hook 收到的信号是否一致 | 不保证「有效调用」判定无假阳性，不能作为阶段变化的唯一依据 |
| **`cc-skill-trace`** | 覆盖三 CLI，Claude Code 支持较稳，捕获 skill invocation 并记录触发原因 | 观察维度参考 | 同上 |
| **`skill-ledger`** | 为每次调用附**显式证据等级**；Codex 调用标 `self_reported` 而非独立验证 | 直接支撑本文「证据分级 → 可信阈值 → 否则手动修正」的观察链路设计 | 仅为设计参照，非可嵌入库 |
| **`SkillTrace`** | 区分 read skill files / declared through MCP / post-run 等不同信号 | 信号分类 | 同上 |
| **`polyhook`** | 统一 hook 二进制检测调用方，反序列化为 normalized struct 再序列化回各 tool 格式 | **跨 CLI hook 事件归一化**的工程可行性参照 | 需自维护 hook 适配层 |

**对本文的意义：** Requirement Tracker 不应假设「收到名为 `design-feature` 的事件」等于 Skill 有效执行。可行观察链路为：**CLI 原生 hook / 事件流 → 归一化层（参考 polyhook 思路）→ 证据等级标注（参考 skill-ledger 的 self_reported vs. verified）→ 达到可信阈值才驱动阶段，否则落入手动修正**。`pi-sleep-agent` 的 hook 覆盖表还提供了一条直接证据：Claude Code 有 prompt/tool capture 与 stop/compact consolidation，OpenCode 通过 project plugin 做 idle consolidation，**而 Codex 仅有 completion notification、无 per-turn prompt capture** —— 印证第 13 节「不能假设所有 CLI 提供同等粒度事件」。

### 8.6 跨路线技术专题

**Codex app-server 的 SDK 化。** Codex app-server 为 JSON-RPC 2.0 over stdio，需处理 LF 分帧、2 MiB 读缓冲、responses / notifications / server-initiated requests 三种请求形状解复用、并发 turn 串行化以保持事件边界。`codex-agent-sdk-go` 已封装为 typed API（`ThreadStart` / `ThreadResume` / `ThreadFork` / `ThreadArchive`、`RunStreamed`、approval callback、turn interrupt、hook 观察事件）；`open-codex-bridge` 用 Python facade 封装 app-server session 与 IPC owner/follower 协议。**可借鉴：** 若 Worker 用 Go/Python，可显著降低 Codex Adapter 协议工作量。**限制：** 标注 preview（v0.x）、API 可能变化，Schema 漂移需自建版本探针与降级逻辑。

**OpenCode 权限默认值。** OpenCode 以本地 server 运行，SDK 提供统一 `startEventListener()` 全局事件订阅，permission 有 SSE 事件与 HTTP endpoint 用于审批请求/响应。**关键细节：** 默认 build agent **自动放行所有工具**，要让审批真正弹出必须显式把每个工具设为 `"ask"`。这直接关系 PoC 1「GUI 正确批准/拒绝 CLI 原生审批，不改变权限语义」——包装层不能假设 CLI 默认请求审批。

**Windows 进程树终止。** Tauri 生态实践一致：Windows 上 `child.kill()` 调用 `TerminateProcess`（等价 SIGKILL），**不保证子进程树被清理**；解决方案为 **Windows Job Object + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`**，创建进程退出时由 OS 终止 Job 内所有子进程。Tauri shell 插件已提供 process group spawn 选项（Windows 即 Job Object，POSIX 即 process group）。**对本文：** 若 Worker 用 Electron，Node `child_process` 在 Windows 无内建 Job Object 语义，需原生模块或 Windows API；若用 Tauri/Rust，`process-wrap` crate 与 Tauri shell 插件模式可参考。**但本文场景更复杂**：Worker 管理多个 CLI Session，Session 可能再 spawn 子进程（Skill 依赖的 Subagent、worktree 操作），且「取消 Turn ≠ 杀死 Session」。PoC 需分别验证取消 Turn 后主进程与已 spawn 子进程的状态，以及正常退出时按 Session 粒度有序终止而非杀整棵树。

**ACP（Agent Client Protocol）生态。** 编辑器与 agent 间的 stdin/stdout JSON-RPC 协议，已有多实现：`zedcode-acps` 提供 Claude Code / Codex 的 ACP server；`@cogitator-ai/acp` 同时支持 client 与 agent 两侧；`claude-code-acp` 为 Python 实现。**可借鉴：** 作为 AionUi 路线的协议基础，是 PoC 1 中「直连 app-server」之外的对照方案。

### 8.7 与本文逐项对照

| 本文决策 / 待验证项 | 最相关开源参考 | 可借鉴部分 | 不可借鉴 / 冲突点 |
|---|---|---|---|
| Codex 结构化 GUI（PoC 1） | AionUi、desktop-cc-gui、codex-agent-sdk-go、`open-codex-bridge` | 协议适配器模式、兼容性矩阵维度、app-server SDK 封装、ACP 桥接对照 | AionUi UI 与 Kanban 无关；desktop-cc-gui 引擎广度超首版；SDK 为 preview |
| Claude Code 原生 Skill 事件（PoC 2） | skill-audit、cc-skill-trace、SkillTrace、skill-ledger、polyhook、pi-sleep-agent 的 hook 覆盖表 | 跨 CLI hook 归一化、证据等级分级、各 CLI 事件粒度实证 | 无方案保证「有效调用」零假阳性；Codex 无 per-turn hook |
| OpenCode Adapter（PoC 3） | OpenCode SDK、相关 runtime adapter | 事件订阅、permission SSE / HTTP 审批 | 默认自动放行所有工具，须显式配 `"ask"` |
| 跨 CLI 需求链路（PoC 4） | Vibe Kanban、lectern、cliban、agentic-kanban | Requirement–Session–Stage 字段与状态命名 | 卡片是执行单元，会触发 dispatch / worktree，违反首版决策 |
| 需求级 Memory（PoC 5） | pi-sleep-agent、recall-agents、Hindsight、mnemos | T0/T1/T2 候选状态机、跨 CLI 历史读取、来源链接、冲突提示 | 自动 sleep / nightly 重写 / 自动注入 / 自动 consolidation 均与「手动 + 审核后写入」冲突 |
| 参考组件抽离（PoC 6） | PI-Desktop、旧 Kanban | 原候选仍成立；未发现更合适的 UI 底座 | AionUi / desktop-cc-gui UI 偏「通用 workspace」，形态与本文「个人开发者多项目工作台 + 独立 Kanban/Memory 视图」不同 |
| Windows 进程管理 | Tauri Job Object 实践、lectern 的 WSL 限制 | Job Object + `KILL_ON_JOB_CLOSE`、process group spawn | lectern 在 Windows 上规避而非解决，原生支持难度不可低估 |
| 统一 Worker | AionUi 的 utilityProcess per agent、desktop-cc-gui 的 Rust adapter | 每 agent 独立宿主模式 | 无项目验证「一个 Worker 宿主管理多 CLI 多 Session」的完整生命周期，仍需自测 |

### 8.8 建议优先阅读源码的项目

1. **AionUi** —— ACP 桥接与多 agent 宿主进程模型。
2. **desktop-cc-gui** —— 兼容性矩阵字段设计与原生协议适配器。
3. **`pi-sleep-agent`** —— T0/T1/T2 候选状态机、审核元数据、跨 CLI hook 覆盖表。
4. **lectern** —— task / session 二分与自托管控制平面边界，同时注意其 Windows 限制。
5. **Vibe Kanban** —— Kanban 字段与 live status 设计（仅字段，不引入执行模型）。
6. **skill-audit / cc-skill-trace / skill-ledger** —— Skill 观察的对照工具与证据分级思路。

**不宜作为实现参考：** `thread-keeper`（自动创建/废弃 skill）、`mnemos` 自动 promotion 分支、Vibe Kanban / lectern / agentic-kanban 的 dispatch + worktree 执行模型。

## 9. PoC 顺序与详细验收标准

> 以下全部是**待执行测试**，不是已通过的能力。每项结果记录 PASS / PARTIAL / FAIL / NOT TESTED，并附 CLI 版本、操作系统、原生命令/接口、复现步骤、日志或截图、已知限制。  
> 「参考对照」列仅提示可用于交叉验证的开源项目，不改变验收标准。

### PoC 1 — Codex 结构化 GUI（P0）

| 测试 | 验收标准 |
|---|---|
| 启动 | 在 Windows 指定工作目录成功启动并创建原生 Session ID |
| 聊天 | 连续多轮发送消息，流式增量正确，无重复或丢失 |
| 工具 | 展示工具开始、参数摘要、输出与结果 |
| 审批 | GUI 正确批准/拒绝 CLI 原生审批，不改变权限语义 |
| 取消 | 取消当前 Turn 后仍能继续 Session |
| 并发 | 至少三个独立 Session 并行运行，切换标签不停止 |
| 恢复 | 正常退出后读取原生历史并继续上下文 |
| 异常 | CLI 意外退出不导致 GUI 崩溃或自动重放副作用 |

**参考对照：** 对比「Codex app-server 直连」与「ACP 桥接（AionUi 路线）」在 Windows 下的行为差异；`codex-agent-sdk-go` 可作协议字段对照。

**门槛：** 核心聊天、工具、审批、取消、恢复均实际可用；仅能启动 CLI 不算通过。

### PoC 2 — Claude Code 原生 Skill 与事件（P0）

| 测试 | 验收标准 |
|---|---|
| Skill 发现 | CLI 实际识别本机安装的 `design-feature` |
| Skill 执行 | GUI 触发的是原生 Skill，而非模型收到同名普通文本 |
| 依赖与 Subagent | 设计中的依赖工具、独立审查等正常执行 |
| Hook/事件 | 能识别实际 Skill 调用；普通聊天提及名称不误判 |
| 自动建卡 | 未关联 Session 首次有效调用只建一张卡；重复/重放不建新卡 |
| 阶段变化 | `implement-spec` 等新事件更新阶段，旧事件不能覆盖 |
| 权限 | 原生工具审批与 CLI 认证行为不被包装层破坏 |
| 工作目录 | `implement-spec` 的原生分支/worktree 操作不被平台隐式改写 |

**参考对照：** 用 `skill-audit` / `cc-skill-trace` 跑一次对照，比较其捕获信号与原生 hook 是否一致；按 `skill-ledger` 的证据分级标注每次观察是 verified 还是 self_reported。

**门槛：** Skill 真调用、必要依赖行为、可信事件观察分别留证；缺口明确标为 PARTIAL，允许手动修正阶段。

### PoC 3 — OpenCode Adapter（P0/P1）

复用 PoC 1 的聊天、流式、工具、审批、取消、并发和恢复测试；单独验证 OpenCode 的原生 Skill/命令及事件。**不能用其他 CLI 的通过结果代替。** 注意先验证默认 build agent 是否自动放行工具，审批测试须显式配置 `"ask"`。

### PoC 4 — 跨 CLI 需求链路（P0）

1. 自由 Claude Session 调用 `design-feature`，自动创建 REQ-001。
2. 从 REQ-001 创建 Codex Session，自动关联；用户手动提供 Spec/Tickets 并调用 `implement-spec`。
3. 自由 OpenCode Session 先执行阶段 Skill，之后手动关联 REQ-001，按 Skill 实际发生顺序同步阶段。
4. 手动修正后，新有效事件覆盖；重复/延迟旧事件不覆盖；多 Session 同时运行时采用最新有效事件。
5. 解除关联不删除历史、不自动回退；退出重开后卡片、关联、阶段和历史均保持正确。

### PoC 5 — 需求级 Memory（P1）

- 仅用户点击提取才执行；读取同需求多个 CLI 的历史。
- 临时 CLI Session 独立于开发 Session；不得污染原生上下文。
- 历史过长时分段处理，缺失历史明确提示。
- 同时输出开发总结和有来源的长期知识候选。
- 用户可接受、编辑、忽略；结果存入 Kanban 管理的本地项目目录。
- 重复提取不静默覆盖人工编辑；早期错误被后续纠正时，不把旧错误作为项目规则。

**参考对照：** 可用 `pi-sleep-agent` 的 T0/T1/T2 状态机与 review metadata 作为结构参照，验证「候选状态流转 + 来源归属 + 冲突提示」；**不引入其自动 sleep 调度**。`recall-agents` 的历史读取层可作「跨 CLI 原生历史可读」的可行性对照。

### PoC 6 — 参考组件抽离（P1）

- 绘制 PI-Desktop 聊天、工具卡片、Session 导航、Diff 的依赖图；审查许可证与依赖。
- 尝试在最小 Electron/React 工程中独立编译至少一个候选 UI 组件。
- 对旧 Kanban 的 PTY、项目切换、Electron IPC 做同样的依赖和独立运行测试。
- 记录直接复用、重写、仅借鉴交互三类结论；不能因代码存在就视为可复用。

**第二轮调研后的收窄：** 未发现比 PI-Desktop / 旧 Kanban 更合适的 UI 复用候选；AionUi 与 desktop-cc-gui 的 UI 为「通用 workspace」范式，**不建议因其 star 数扩大 UI 复用调研范围**，其价值集中在 Adapter 层。

## 10. 技术验证的交付文件

| 文件 | 必须包含 |
|---|---|
| `cli-compatibility-matrix.md` | 三个 CLI 的版本、协议、GUI 核心能力、Skill/Hook、审批、恢复、Windows 限制与证据；字段设计可参考 desktop-cc-gui 的矩阵维度 |
| `desktop-reuse-assessment.md` | PI-Desktop 和旧 Kanban 的组件依赖、许可证、独立编译结果、复用建议 |
| `poc-test-plan.md` | 逐项步骤、测试数据、预期结果、失败判定、日志/截图收集方法 |
| `poc-results.md` | PASS/PARTIAL/FAIL/NOT TESTED、真实证据、阻塞、降级方案 |
| `architecture-proposal.md` | 基于实际 PoC 结果确定的最小模块边界、进程通信与技术取舍 |

建议每项 PoC 保留最小可运行示例，但**不要同时开发完整 UI**。

## 11. 技术选型门槛与降级

| 决策 | 必须有的证据 | 不满足时 |
|---|---|---|
| CLI 正式支持 GUI | 多轮聊天、工具、审批、取消、恢复通过 | 标记仅 TUI/实验性，不伪装完整 GUI |
| CLI 协议接入方式（直连 app-server / 官方 SDK / ACP 桥接） | 三种方式在 Windows 下的启动、流式、审批、取消、恢复对照结果；依赖链与许可证可接受 | 选已验证且依赖可控者；桥接包不满足 Windows 或版本跟随要求时回退直连 |
| 自动 Skill 阶段识别 | 真调用、可观察、无误报、去重与旧事件处理通过；观察信号标注证据等级 | 使用手动阶段修正，记录兼容缺口 |
| 统一 Worker | 多 CLI 并发、进程停止、异常隔离与 Windows 行为通过 | 在 Adapter 内拆分 CLI 宿主进程 |
| 复用开源组件 | 许可证、依赖、独立编译、交互测试通过 | 仅借鉴设计，独立实现 |
| Memory 进入 MVP | 多 CLI 历史可读、来源可追溯、提取审核闭环通过 | 先保留历史/需求关联，推迟提取功能 |

## 12. 实施顺序（待 PoC 通过后启动）

| 阶段 | 目标 | 交付 |
|---|---|---|
| 0 | 完成技术验证 | 兼容性矩阵、源码复用评估、PoC 证据 |
| 1 | Desktop MVP | 多项目、统一聊天 GUI、Session 管理与恢复 |
| 2 | Kanban | `design-feature` 自动建卡、跨 Session 关联、阶段识别与修正 |
| 3 | Memory | 手动需求级提取、总结、候选审核与本地检索 |
| 4 | 体验打磨 | Diff、错误提示、恢复、Windows 退出、视觉优化 |

这些是**项目实施阶段**，不是运行时自动工作流。正式拆 tickets 前先以 PoC 结果更新架构。

## 13. 风险、待定与不应擅自补齐的内容

1. **Skill 调用兼容性：** 各 CLI 的 GUI 接口可能与原生 TUI 命令机制不同；必须测试，不以 SDK 存在推断支持。
2. **CLI 认证与授权：** SDK、App Server、CLI 的登录和费用/条款可能不同；逐一验证，不假定继承已有订阅。
3. **原生历史恢复：** 历史可读、原生上下文可继续、运行中的工具可恢复是三件事；首版只要求前两项可行。
4. **Windows 进程管理：** 子进程残留、取消和终止必须实际测试；Job Object 方案需验证「取消 Turn 不杀 Session」的粒度控制。
5. **PI-Desktop 复用：** UI 与 Pi、Rust Host Core 的耦合及许可证需代码级评估；不直接 Fork。
6. **Memory 质量：** 长会话分段、来源、冲突和过期事实不能靠一次无证据总结解决。
7. **事件顺序：** 多 CLI 时钟与重连事件可能不可靠；必要时保留阶段并标注不确定性。
8. **第三方依赖跟随：** ACP 桥接包、app-server SDK 均为 preview 或第三方维护，需自建版本探针与降级路径，不假定长期兼容。
9. **首版具体技术细节未定：** IPC schema、SQLite 表、Worker 子进程协议、CLI 固定版本、具体 UI 组件库、Memory 文件布局、项目 ID 生成与移动策略，均留到验证后规格化。

## 14. 推荐下一步

**先做 PoC 1 和 PoC 2 的详细代码级调研与最小验证**，优先证明 Codex 结构化 GUI 和 Claude Code 原生 Skill 调用/事件观察。之后验证 OpenCode、跨 CLI 需求关联与 Memory。只有关键链路通过后，才锁定 Adapter 接口、UI 复用清单与最终架构，并创建新仓库实施。

结合第二轮调研，可在不扩大范围的前提下增加两个对照点：PoC 1 中对比 app-server 直连与 ACP 桥接的 Windows 行为；PoC 2 中用 `skill-audit` / `cc-skill-trace` 对原生 hook 信号做一致性核对。PoC 5 可提前到 PoC 4 之后、PoC 6 之前，以 `pi-sleep-agent` 的状态机为参照先验证「来源归属与冲突提示」这一真正难点。

---

### 来源链接

**原候选项目**
- 旧 Kanban：https://github.com/L1UUUU/kanban
- PI-Desktop：https://github.com/vastsa/PI-Desktop
- PI-Desktop Architecture：https://github.com/vastsa/PI-Desktop/blob/main/docs/spec/02-architecture/01-architecture.md
- Codex：https://github.com/openai/codex
- Claude Agent SDK：https://github.com/anthropics/claude-agent-sdk-typescript
- OpenCode：https://github.com/anomalyco/opencode
- Matt Pocock Skills：https://github.com/mattpocock/skills

**路线 A — 多 CLI 统一 GUI**
- AionUi：https://github.com/iOfficeAI/AionUi
- desktop-cc-gui：https://github.com/zhukunpenglinyutong/desktop-cc-gui

**路线 B — Kanban 编排**
- Vibe Kanban：https://github.com/BloopAI/vibe-kanban
- lectern：（自托管 Kanban / task dispatch 项目，README 级观察）
- agentic-kanban：https://github.com/jmelahman/agentic-kanban
- cliban：https://github.com/LioraLabs/cliban

**路线 C — Memory / Skill 观察**
- pi-sleep-agent（T0/T1/T2 分级记忆与 sleep 蒸馏）
- recall-agents（跨 CLI 历史搜索与 notes）
- Hindsight（Thoughtworks 雷达收录的事实/实体/时间戳记忆）
- mnemos（带证据 claim 与冲突 surfacing）
- thread-keeper（Autonomous Curator，自动 skill 策展）
- skill-audit / opencode-skill-audit（跨 CLI Skill 审计轨迹）
- cc-skill-trace（Skill invocation 捕获与触发原因）
- skill-ledger（调用证据等级标注）
- SkillTrace（Skill 信号分类）
- polyhook（跨 CLI hook 事件归一化）

**协议 / SDK / 进程管理**
- codex-agent-sdk-go（Codex app-server typed SDK）
- open-codex-bridge（Codex app-server Python facade）
- zedcode-acps / `@cogitator-ai/acp` / claude-code-acp（ACP 实现）
- Tauri shell 插件 process group spawn 与 Windows Job Object 实践
- `process-wrap` crate（Rust 进程树管理）

> 说明：路线 B/C 中部分项目仅在 README/文档级观察到，未逐一记录精确仓库 URL 与 star 数；正式调研时应补齐并标注观察日期与 commit。所有「支持」「可用」描述均为文档声称，**PASS 只能由未来真实 PoC 结果给出**。本次未创建新仓库、未修改现有项目、未执行 CLI 测试。

**说明：** 本文的「已确认」仅指用户在产品讨论中确认的目标/行为；「已观察到」指读取仓库资料；「PASS」只能由未来真实 PoC 结果给出。本次未创建新仓库、未修改现有项目、未执行 CLI 测试。