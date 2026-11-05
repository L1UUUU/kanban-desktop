# CLI 兼容性矩阵（Kanban Desktop V1）

> 日期：2026-11-05（首轮 + magpie 接入补跑后全量收口 + T0-02 Agent SDK 弃用决策更新）· 全部条目来自本机真实运行（见 `poc/poc-1..4/`、`poc/t0-02-sdk/`），无「文档声称」混入
> 字段维度参考 desktop-cc-gui 矩阵 + 计划文档 §5/§8/§10

## 1. 总矩阵

| 维度 | Codex 0.144.1 | Claude Code 2.1.317 | OpenCode 1.19.5 |
|---|---|---|---|
| 协议接入 | **app-server 直连**（JSON-RPC 2.0 over stdio，LF 分帧；`generate-ts` 同版本协议绑定可生成） | **协议直连 = 唯一传输层基线**（`--print --output-format stream-json --input-format stream-json` + initialize 控制请求行协议）；**Agent SDK 已正式弃用**（T0-02 复测：0.2.141/0.3.309/0.3.318 全部子进程秒退，换可用 exe/禁 settings 均无效，上游 #359/#444 仍 open 无修复，见 `poc/t0-02-sdk/RESULT.md`） | **HTTP+SSE 直连**（`opencode serve`，OpenAPI `/doc` 自描述；`@opencode-ai/sdk` 同版本发布可作类型化替代；自带 `opencode acp` 子命令） |
| 原生 Session 创建 | ✅ `thread/start` 返回 UUIDv7 thread id + rollout 落盘路径 | ✅ stream-json 会话（session id + transcriptPath） | ✅ `POST /session` 返回 `ses_...`（实测多开，含 crash 后 18/18 完好） |
| 多轮流式聊天 | ✅ delta 按 itemId 归属，拼接与终文逐一相等；`turn/completed` 带全量快照可兜底 | ✅ stream-json 增量；slash dispatch 为 CLI 客户端行为（`<command-message>` 转写） | ✅ delta 事件 + part 快照双通道；轮 2 复现暗号「蓝鲸42号」 |
| 工具调用展示 | ✅ `item/started`+`item/completed`（command/参数/输出/exitCode/duration） | ✅ 工具调用在 stream 可见（Bash/Glob/Read/ToolSearch/Skill） | ✅ bash part 5 次状态更新（状态机流转 + output），模型正确复述结果 |
| 原生审批 | ✅ `item/commandExecution/requestApproval`（服务端带 id 请求，回 `{decision}`）；read-only 沙箱 + on-request 策略；accept/deny 语义保真实测 | ⚠️ 非交互**默认静默全拒绝**，必须显式 `--permission-prompt-tool=stdio` 才流出 `can_use_tool` 控制请求（allow/deny 语义保真实测，PoC 7 T3）；`--disallowedTools` / `--permission-mode` 生效；Skill 工具 default 档不弹审批直接执行 | ⚠️ **默认不弹**：build agent 权限表 `*:*:allow`（三层证据：事件流 + `GET /agent` + server 日志）；显式 `ask` 后批准（`once`）/拒绝（`reject`）双路径实测；**审批请求不走 SSE，须轮询 `GET /permission`**（SSE 只回 `permission.replied`） |
| 取消 Turn | ✅ `turn/interrupt` → interrupted，同 thread 可继续 | ✅ `control_request{interrupt}` 实证（PoC 7 T2：确认后 0 delta，result=error_during_execution 归类「已取消」，同会话可继续） | ✅ abort 端点 → `MessageAbortedError`（0 输出 token），session 随后可继续使用 |
| 并发 ≥3 Session | ✅ 3 thread 并行无串扰 | 多会话并行由 PoC 4 实证（三 CLI 混合流 25/25） | ✅ 3 session 并行 16.5s 全 completed，回复互不串扰 |
| 历史读取 | ✅ `thread/read{includeTurns}` 读回完整 turns | ✅ 原生 transcript jsonl 直读（PoC 5 双 CLI 读入实证） | ✅ `GET /session` 列表 + `GET /session/{id}/message`（crash 后 18/18 完好） |
| 上下文继续 | ✅ `thread/resume` 同 id，暗号复现实证 | ✅（stream-json 会话续问） | ✅ 重启 server 后续问正确复现（原生上下文继续） |
| Skill/Slash 原生支持 | 有 skills 机制；无 per-turn hook（结构性缺口，§8.5） | ✅ 项目级/用户级 skill 原生发现与加载（项目级优先）；Skill 是工具调用，**hook 是唯一真相源**；触发由模型决策非 100% | ✅ `.opencode/command`+`.opencode/skill` 原生发现（skill 同时以 slash 暴露）；**command 执行实测**（`POST /session/{id}/command` 同步 200，`arguments` 必填）；**会扫描用户全局 `~/.claude/skills`、`~/.agents/skills`** |
| Skill 调用可观察信号 | 仅 turn 级事件 → self_reported（GUI 观察用户提交+turn 完成） | ✅ PreToolUse/PostToolUse(Skill) hook = verified；UserPromptSubmit 可捕获「输入了但未执行」缺口 | command 显式执行 + 输出回读（信号强但 SKILL.md 注入 prompt 由模型自由发挥，无语义独立验证）→ **self_reported**（PoC 4 实证不能升 verified） |
| 异常退出（kill） | ✅ 客户端明确报错、无重放 | —（同左逻辑由包装层负责） | ✅ ECONNREFUSED 明确报错、无重放、数据完好 |
| Windows 专项 | ⚠️ 须直连 `codex.exe`（`.cmd` shim kill 后留孤儿）；`model/list`≠账号可用（须探测回退） | ⚠️ MSYS 会改写 `/` 参数与 env（GUI 编程 spawn 不受影响）；`--setting-sources project` 切断认证 env | ✅ XDG 重定向隔离生效（skill 扫描不受隔离）；magpie 模型 ID 自带斜杠按第一个切分；GLM 首 token 10-12s |

图例：✅ 实测通过 · ⚠️ 实测有条件/有限制 · OpenCode 各项均已补跑收口（commit `69e9920`）

## 2. 事件模型归一化（PoC 4 实证，三 CLI 真实源）

```text
Claude hook (verified) ─────┐
Codex turn 事件 (self_reported) ─┤→ 归一化事件 {eventId, sessionId, cli, skill, occurredAt, seq, evidenceLevel}
OpenCode command/SSE (self_reported) ─┘      ├─ verified：唯一可建卡，直接驱动阶段
                                             ├─ self_reported/simulated：驱动阶段 + uncertain 标注，手动确认/后续 verified 转正
                                             └─ 排序：按 occurredAt 实际发生时间；旧/重复/重放不覆盖；允许 PR→Implement 回退
```

分级标准：按「**CLI 是否提供 skill 语义独立验证**」划分，不按信号强度（OpenCode command 信号虽强，但机制是 SKILL.md 注入 prompt，实测不能升 verified）。e2e 三 CLI 全真实源 25/25、tracker 21/21、重启恢复 7/7。

## 3. 各 CLI Adapter 落地建议

| | Codex Adapter | Claude Adapter | OpenCode Adapter |
|---|---|---|---|
| 传输层 | 直连 app-server（零依赖 Node 客户端，poc-1 client.mjs 可演进） | stream-json 行协议直连（poc-2 protocol-client.mjs + poc-7 lib/client.mjs 演进）；**SDK 已弃用、不留备选路径**（T0-02 决策） | HTTP+SSE（poc-3 client.mjs 可演进，已含 provider 只读注入） |
| 版本策略 | 锁版本 + `--version`/`generate-ts` diff 探针 + 模型可用性探测 | hook 与 CLI 版本解耦（外部 hook 落 JSONL） | 与 CLI 同版本 SDK；prompt body 顶层 `parts` 等形状坑已记录 |
| 审批策略 | 原生 requestApproval 直通（语义不改写） | 显式 `--permission-prompt-tool=stdio` + 启动自检 fail-fast + `can_use_tool` 控制请求直通（PoC 7 T3；SDK canUseTool 随弃用移除） | 会话级显式 `ask` 注入 + **轮询 `GET /permission`** + SSE `replied` 兜底 + UI 明示档位 |
| 阶段识别 | self_reported + uncertain | verified（hook） | self_reported + uncertain（已实证） |

## 4. 证据索引

- Codex：`poc/poc-1-codex-appserver/RESULT.md`（8/8 PASS + 过程发现）、`NOTES.md`、`protocol/ts/`（同版本协议绑定）
- Claude：`poc/poc-2-claude-skills/RESULT.md`（验收表 + 9 大发现 + 轮次清单）、`tracker/tracker.test.mjs`（15/15）、`poc/poc-7-claude-gaps/RESULT.md`（审批/取消/resume/hook 注入补验 T1-T6）
- Claude（T0-02 SDK 弃用决策）：`poc/t0-02-sdk/RESULT.md`（三版本复测 + E1-E6 隔离实验链 + 可重复复测脚本）
- OpenCode：`poc/poc-3-opencode/RESULT.md`（首轮 12 项 + 补跑全过 + magpie 发现 NOTES §10）、`NOTES.md`
- 跨 CLI：`poc/poc-4-cross-cli/RESULT.md`（证据分级策略 + 5 场景，三 CLI 真实源 e2e 25/25）
