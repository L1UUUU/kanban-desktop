# CLI 兼容性矩阵（Kanban Desktop V1）

> 日期：2026-11-05 · 全部条目来自本机真实运行（见 `poc/poc-1..3/`），无「文档声称」混入；NOT TESTED = 本次未运行并注明原因
> 字段维度参考 desktop-cc-gui 矩阵 + 计划文档 §5/§8/§10

## 1. 总矩阵

| 维度 | Codex 0.144.1 | Claude Code 2.1.317 | OpenCode 1.19.5 |
|---|---|---|---|
| 协议接入 | **app-server 直连**（JSON-RPC 2.0 over stdio，LF 分帧；`generate-ts` 同版本协议绑定可生成） | **协议直连**（`--print --output-format stream-json --input-format stream-json` + initialize 控制请求行协议）；Agent SDK 0.2.141/0.3.318 Windows pre-spawn abort（上游 #359/#444） | **HTTP+SSE 直连**（`opencode serve`，OpenAPI `/doc` 自描述；`@opencode-ai/sdk` 同版本发布可作类型化替代；自带 `opencode acp` 子命令） |
| 原生 Session 创建 | ✅ `thread/start` 返回 UUIDv7 thread id + rollout 落盘路径 | ✅ stream-json 会话（session id + transcriptPath） | ✅ `POST /session` 返回 `ses_...`（实测多开 7 个） |
| 多轮流式聊天 | ✅ delta 按 itemId 归属，拼接与终文逐一相等；`turn/completed` 带全量快照可兜底 | ✅ stream-json 增量；slash dispatch 为 CLI 客户端行为（`<command-message>` 转写） | ⬜ NOT TESTED（凭据阻塞；事件形状已校准：text part 全量快照流式更新） |
| 工具调用展示 | ✅ `item/started`+`item/completed`（command/参数/输出/exitCode/duration） | ✅ 工具调用在 stream 可见（Bash/Glob/Read/ToolSearch/Skill） | ⬜ NOT TESTED（解析就绪） |
| 原生审批 | ✅ `item/commandExecution/requestApproval`（服务端带 id 请求，回 `{decision}`）；read-only 沙箱 + on-request 策略；accept/deny 语义保真实测 | ⚠️ 非交互下 Skill 不弹审批直接执行；`--disallowedTools` / `--permission-mode` 生效；`canUseTool` 回调链路未测（SDK bug） | ⚠️ **默认不弹**：build agent 权限表 `*:*:allow`（仅 4 类默认 ask）；统一审批须会话级显式注入 `permission:{"bash":"ask",...}`，批准/拒绝 API 就绪未跑 |
| 取消 Turn | ✅ `turn/interrupt` → interrupted，同 thread 可继续 | 未单测（无独立 cancel 验收项） | ⬜ NOT TESTED（abort 端点实证；turn 终态=`session.idle/error`） |
| 并发 ≥3 Session | ✅ 3 thread 并行无串扰 | 多会话并行由 PoC 4 实证（Claude+Codex 混合流） | ⬜ NOT TESTED（session 多开已证，并行 turn 脚本就绪） |
| 历史读取 | ✅ `thread/read{includeTurns}` 读回完整 turns | ✅ 原生 transcript jsonl 直读（PoC 5 双 CLI 读入实证） | ✅ `GET /session` 列表 + `GET /session/{id}/message`（crash 后 7/7 完好） |
| 上下文继续 | ✅ `thread/resume` 同 id，暗号复现实证 | ✅（stream-json 会话续问） | ⬜ NOT TESTED（凭据阻塞） |
| Skill/Slash 原生支持 | 有 skills 机制；无 per-turn hook（结构性缺口，§8.5） | ✅ 项目级/用户级 skill 原生发现与加载（项目级优先）；Skill 是工具调用，**hook 是唯一真相源**；触发由模型决策非 100% | ✅ `.opencode/command`+`.opencode/skill` 原生发现（skill 同时以 slash 暴露）；执行 NOT TESTED；**会扫描用户全局 `~/.claude/skills`、`~/.agents/skills`** |
| Skill 调用可观察信号 | 仅 turn 级事件 → self_reported（GUI 观察用户提交+turn 完成） | ✅ PreToolUse/PostToolUse(Skill) hook = verified；UserPromptSubmit 可捕获「输入了但未执行」缺口 | permission/SSE 事件流；skill 执行粒度信号待补跑 |
| 异常退出（kill） | ✅ 客户端明确报错、无重放 | —（同左逻辑由包装层负责） | ✅ ECONNREFUSED 明确报错、无重放、数据完好 |
| Windows 专项 | ⚠️ 须直连 `codex.exe`（`.cmd` shim kill 后留孤儿）；`model/list`≠账号可用（须探测回退） | ⚠️ MSYS 会改写 `/` 参数与 env（GUI 编程 spawn 不受影响）；`--setting-sources project` 切断认证 env | ✅ XDG 重定向隔离生效（但 skill 扫描不受隔离） |

图例：✅ 实测通过 · ⚠️ 实测有条件/有限制 · ⬜ NOT TESTED（OpenCode 凭据恢复后补跑，见 poc-3 README）

## 2. 事件模型归一化（PoC 4 实证）

```text
Claude hook (verified) ─┐
Codex turn 事件 (self_reported) ─┤→ 归一化事件 {eventId, sessionId, cli, skill, occurredAt, seq, evidenceLevel}
OpenCode SSE (self_reported*) ─┘         ├─ verified：唯一可建卡，直接驱动阶段
                                         ├─ self_reported/simulated：驱动阶段 + uncertain 标注，手动确认/后续 verified 转正
                                         └─ 排序：按 occurredAt 实际发生时间；旧/重复/重放不覆盖；允许 PR→Implement 回退
```

*OpenCode 本次为合成事件（凭据阻塞），schema 已按 poc-3 协议结论对齐。

## 3. 各 CLI Adapter 落地建议

| | Codex Adapter | Claude Adapter | OpenCode Adapter |
|---|---|---|---|
| 传输层 | 直连 app-server（零依赖 Node 客户端，poc-1 client.mjs 可演进） | stream-json 行协议直连（poc-2 protocol-client.mjs 可演进）；SDK 待锁版本 | HTTP+SSE（poc-3 client.mjs 可演进） |
| 版本策略 | 锁版本 + `--version`/`generate-ts` diff 探针 + 模型可用性探测 | hook 与 CLI 版本解耦（外部 hook 落 JSONL） | 与 CLI 同版本 SDK；prompt body 顶层 `parts` 等形状坑已记录 |
| 审批策略 | 原生 requestApproval 直通（语义不改写） | 权限 flags 透传 + canUseTool（待 SDK 修复后接） | 会话级显式 `ask` 注入 + UI 明示档位（原生默认/收紧） |
| 阶段识别 | self_reported + uncertain | verified（hook） | self_reported + uncertain（待补跑确认） |

## 4. 证据索引

- Codex：`poc/poc-1-codex-appserver/RESULT.md`（8/8 PASS + 过程发现）、`NOTES.md`、`protocol/ts/`（同版本协议绑定）
- Claude：`poc/poc-2-claude-skills/RESULT.md`（验收表 + 9 大发现 + 轮次清单）、`tracker/tracker.test.mjs`（15/15）
- OpenCode：`poc/poc-3-opencode/RESULT.md`（12 项判定 + 权限默认值实证 + 阻塞与补跑命令）、`NOTES.md`
- 跨 CLI：`poc/poc-4-cross-cli/RESULT.md`（证据分级策略 + 5 场景）
